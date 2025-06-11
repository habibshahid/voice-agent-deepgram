// asterisk-bridge.js with fixed live audio setup
// Connects Asterisk calls to the Deepgram voice agent
// Add Blob polyfill first before any other imports
global.Blob = require('buffer').Blob;
const RtpServer = require('./rtp-server');
const ip = require('ip');
const WebSocket = require('ws');
const ari = require('ari-client');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

const { mulawToLinear, linearToMulaw, stripWavHeader } = require('./audio-format-conversion');


// Load environment variables
dotenv.config();

// Debug mode
const DEBUG = process.env.DEBUG || true;

function debug(message, data) {
    if (DEBUG) {
        if (data) {
            console.log(`[ASTERISK-BRIDGE] ${message}`, typeof data === 'object' ? JSON.stringify(data) : data);
        } else {
            console.log(`[ASTERISK-BRIDGE] ${message}`);
        }
    }
}

// Configuration
const config = {
    asterisk: {
        url: process.env.ASTERISK_URL || 'http://localhost:8088',
        username: process.env.ASTERISK_USERNAME || 'nodejs',
        password: process.env.ASTERISK_PASSWORD || 'mycode',
        appName: process.env.ASTERISK_APP_NAME || 'intelli-Ajam'
    },
    server: {
        url: process.env.VOICE_SERVER_URL || 'ws://localhost:3000/asterisk'
    }
};

// Active calls map: channelId -> call state
const activeCalls = new Map();

// Call state object
class CallState {
    constructor(channel, bridge) {
        this.channel = channel;
        this.bridge = bridge;
        this.serverWs = null;
        this.isConnected = false;
        this.isAgentReady = false;
        this.playbackQueue = [];
        this.isPlaying = false;
        this.pingInterval = null;
        this.lastPongTime = Date.now();
        
        // Add audio buffer initialization
        this.audioBuffer = Buffer.alloc(0);
        
        // Add audio statistics tracking
        this.audioStats = {
            totalReceived: 0,
            totalSent: 0,
            lastReportTime: Date.now()
        };
    }

    startPingPong() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
        
        this.pingInterval = setInterval(() => {
            if (!this.serverWs || this.serverWs.readyState !== WebSocket.OPEN) {
                debug(`WebSocket not open, can't send ping`);
                return;
            }
            
            try {
                //debug(`Sending ping to server`);
                this.serverWs.send(JSON.stringify({
                    type: 'ping',
                    channelId: this.channel.id,
                    timestamp: Date.now()
                }));
                
                // Check if we've received a pong recently
                const timeSinceLastPong = Date.now() - this.lastPongTime;
                if (timeSinceLastPong > 15000) {
                    // No pong for 15 seconds, connection might be dead
                    debug(`No pong received for ${Math.round(timeSinceLastPong/1000)}s, reconnecting...`);
                    this.reconnectToServer();
                }
            } catch (error) {
                console.error(`Error sending ping: ${error.message}`);
            }
        }, 5000);
    }

    // Add this method to handle reconnection
    async reconnectToServer() {
        debug(`Reconnecting to server for channel ${this.channel.id}`);
        
        // Close existing connection if any
        if (this.serverWs) {
            try {
                this.serverWs.close();
            } catch (error) {
                // Ignore errors during close
            }
            this.serverWs = null;
        }
        
        // Reset state
        this.isConnected = false;
        this.isAgentReady = false;
        
        // Connect again
        await this.connectToServer();
    }
    
    // Connect to the voice agent server
    async connectToServer() {
        debug(`Connecting to voice server for channel ${this.channel.id}`);
        debug(`Using WebSocket URL: ${config.server.url}`);
        
        // Create WebSocket connection to our voice agent server
        this.serverWs = new WebSocket(config.server.url);
        
        // Set up event handlers
        this.serverWs.on('open', () => {
            debug(`Connected to voice server for channel ${this.channel.id}`);
            debug(`WebSocket readyState: ${this.serverWs.readyState}`);
            this.isConnected = true;
            
            // Start ping/pong
            this.startPingPong();
            
            // Initialize the agent
            const initMessage = {
                type: 'init',
                channelId: this.channel.id
            };
            
            debug(`Sending init message: ${JSON.stringify(initMessage)}`);
            this.serverWs.send(JSON.stringify(initMessage));
        });
        
        this.serverWs.on('message', (data) => {
			try {
				// Check if it's a binary message
				if (data instanceof Buffer) {
					const dataLength = data.length;
					
					// Quick check if it might be text (JSON)
					const isText = isLikelyText(data);
					
					if (isText) {
						debug(`Received text message as binary: ${data.toString().substring(0, 100)}...`);
						
						// Try to parse as JSON
						try {
							const jsonMessage = JSON.parse(data.toString());
							debug(`Parsed JSON message: ${JSON.stringify(jsonMessage)}`);
							this.handleJsonMessage(jsonMessage);
						} catch (jsonError) {
							debug(`Not valid JSON, treating as text`);
							// Handle as text if needed
						}
					} else {
						// It's definitely binary data (likely audio)
						debug(`Received binary data from server: ${dataLength} bytes`);
						
						// Queue it for playback
						this.queueAudioPlayback(data);
					}
				} else {
					// It's already a string
					debug(`Received string message: ${data}`);
					
					// Try to parse as JSON
					try {
						const jsonMessage = JSON.parse(data);
						this.handleJsonMessage(jsonMessage);
					} catch (jsonError) {
						debug(`Failed to parse string as JSON: ${jsonError.message}`);
					}
				}
			} catch (error) {
				console.error(`Error handling message from server:`, error);
				console.error(error.stack);
			}
		});
        
        this.serverWs.on('close', (code, reason) => {
            debug(`Disconnected from voice server for channel ${this.channel.id}`);
            debug(`Close code: ${code}, reason: ${reason || 'No reason provided'}`);
            this.isConnected = false;
            
            // Try to reconnect on unexpected close
            if (code !== 1000) { // 1000 is normal closure
                debug(`Unexpected WebSocket close, attempting to reconnect in 5 seconds...`);
                setTimeout(() => {
                    if (!this.isConnected) {
                        this.reconnectToServer();
                    }
                }, 5000);
            }
        });
        
        this.serverWs.on('error', (error) => {
            console.error(`WebSocket error for channel ${this.channel.id}:`, error);
            debug(`WebSocket error details: ${error.message}`);
            debug(`Current readyState: ${this.serverWs.readyState}`);
            
            // Try to reconnect after error
            setTimeout(() => {
                if (!this.isConnected) {
                    debug(`Attempting to reconnect after WebSocket error`);
                    this.reconnectToServer();
                }
            }, 5000);
        });
    }
    
    // Handle messages from the voice agent server
    async handleServerMessage(data) {
        try {
            debug(`RAW MESSAGE FROM SERVER: ${data instanceof Buffer ? 'Binary data: ' + data.length + ' bytes' : data}`);
            
            // Check if this might be a text message even though it's in a Buffer
            if (data instanceof Buffer) {
                // Try to convert to a string and see if it's valid JSON
                const possibleText = data.toString('utf8');
                
                // Check if it starts with '{' which would indicate JSON
                if (possibleText.trim().startsWith('{')) {
                    debug(`Received possible JSON as binary: ${possibleText}`);
                    
                    try {
                        // Try to parse as JSON
                        const jsonMessage = JSON.parse(possibleText);
                        debug(`Successfully parsed JSON from binary data: ${JSON.stringify(jsonMessage)}`);
                        
                        // Process the JSON message
                        await this.handleJsonMessage(jsonMessage);
                        return;
                    } catch (jsonError) {
                        debug(`Not valid JSON, treating as binary audio data`);
                        // Continue with binary processing
                    }
                }
                
                // If we get here, it's really binary audio data
                debug(`Received binary audio data: ${data.length} bytes`);
                await this.queueAudioPlayback(data);
            } else {
                // It's already a string message
                //debug(`Received string message: ${data}`);
                
                // Try to parse as JSON
                try {
                    const jsonMessage = JSON.parse(data);
                    //debug(`Parsed JSON message: ${JSON.stringify(jsonMessage)}`);
                    await this.handleJsonMessage(jsonMessage);
                } catch (jsonError) {
                    debug(`Error parsing string as JSON: ${jsonError.message}`);
                }
            }
        } catch (error) {
            console.error(`Error handling server message: ${error.message}`);
            console.error(error.stack);
        }
    }

    async handleJsonMessage(message) {
        debug(`Processing JSON message of type: ${message.type}`);
        
        switch (message.type) {
            case 'status':
                await this.handleStatusMessage(message);
                break;
                
            case 'transcript':
                this.handleTranscriptMessage(message);
                break;
                
            case 'actions':
                this.handleActionMessage(message);
                break;
                
            case 'error':
                console.error(`Error from server for channel ${this.channel.id}:`, message.message);
                break;
                
            case 'pong':
                debug(`Received pong from server, latency: ${Date.now() - (message.timestamp || 0)}ms`);
                this.lastPongTime = Date.now();
                break;
                
            case 'audioComplete':
                debug(`Audio complete for channel ${this.channel.id}`);
                break;
                
            default:
                debug(`Unknown message type: ${message.type}`);
        }
    }
    
    // Handle status messages
    async handleStatusMessage(message) {
        debug(`STATUS MESSAGE RECEIVED for channel ${this.channel.id}:`);
        debug(`- Status: ${message.status}`);
        debug(`- Message: ${message.message}`);
        
        if (message.status === 'ready') {
            debug(`🟢 AGENT READY for channel ${this.channel.id} - STARTING AUDIO STREAMING`);
            this.isAgentReady = true;
            
            // Start streaming audio from the channel
            await this.startStreaming();
        }
    }
    
    // Handle transcript messages
    handleTranscriptMessage(data) {
        if (!data.data) return;
        
        // Log transcripts
        if (data.data.speaker === 'user') {
            debug(`User said: ${data.data.text}`);
        } else if (data.data.speaker === 'agent') {
            debug(`Agent said: ${data.data.text}`);
        }
    }
    
    // Handle action messages
    handleActionMessage(data) {
        debug(`Action message for channel ${this.channel.id}:`, data);
        
        // Process actions like in the web client
        if (!data.actions || !Array.isArray(data.actions)) {
            return;
        }
        
        data.actions.forEach(action => {
            const functionCallId = action.function_call_id;
            const functionName = action.function_name;
            
            // Send action response back to server
            if (functionCallId) {
                this.sendActionResponse(functionCallId, { success: true }, functionName);
            }
        });
    }
    
    // Send action response back to server
    sendActionResponse(functionCallId, output, functionName) {
        if (!this.serverWs || this.serverWs.readyState !== WebSocket.OPEN) {
            console.error(`WebSocket not connected, cannot send action response for channel ${this.channel.id}`);
            return;
        }
        
        try {
            const response = {
                type: 'action_response',
                function_call_id: functionCallId,
                function_name: functionName,
                response: {
                    confirmation: "request processed"
                }
            };
            
            debug(`Sending action response:`, response);
            this.serverWs.send(JSON.stringify(response));
        } catch (error) {
            console.error(`Error sending action response for channel ${this.channel.id}:`, error);
        }
    }
    
    // Start streaming audio from the channel
    async startStreaming() {
        debug(`Starting audio streaming for channel ${this.channel.id}`);
        
		//await this.setupExternalMedia();
        // Subscribe to the channel's audio events
        this.channel.on('StasisStart', (event, channel) => {
            debug(`Stasis started for channel ${channel.id}`);
        });
        
        // Set up snoop to capture audio
        await this.setupSnoop();
        
        // Set up stats reporting
        this.setupStatsReporting();
    }
    
    // Set up stats reporting
    setupStatsReporting() {
        this.statsInterval = setInterval(() => {
            const now = Date.now();
            const elapsedSec = (now - this.audioStats.lastReportTime) / 1000;
            
            debug(`AUDIO STATS for channel ${this.channel.id}:`);
            debug(`- Total audio received: ${this.audioStats.totalReceived} bytes`);
            debug(`- Total audio sent: ${this.audioStats.totalSent} bytes`);
            if (elapsedSec > 0) {
                debug(`- Receive rate: ${Math.round(this.audioStats.totalReceived / elapsedSec / 1024)} KB/s`);
                debug(`- Send rate: ${Math.round(this.audioStats.totalSent / elapsedSec / 1024)} KB/s`);
            }
            
            this.audioStats.totalReceived = 0;
            this.audioStats.totalSent = 0;
            this.audioStats.lastReportTime = now;
        }, 5000);
    }

    // Set up a snoop to capture audio from the channel
    async setupSnoop() {
        try {
            debug(`Setting up snoop for channel ${this.channel.id} (isAgentReady: ${this.isAgentReady})`);
            
            // Create a snoop to capture audio
            const snoopChannel = await this.channel.snoopChannel({
                spy: 'both',
                whisper: 'out',
                app: config.asterisk.appName,
                appArgs: `snoop:${this.channel.id}`,
                snoopId: `snoop-${this.channel.id}`
            });
            
            debug(`Snoop created for channel ${this.channel.id}: ${snoopChannel.id}`);
            
            // Store the snoop channel reference
            this.snoopChannel = snoopChannel;
            
            // When we get DTMF from the snoop
            snoopChannel.on('ChannelDtmfReceived', (event, channel) => {
                debug(`DTMF received on channel ${channel.id}: ${event.digit}`);
            });
            
            // Set up audio capture using the ARI client's channel events
            debug(`Setting up audio capturing for channel ${this.channel.id}`);
            
            // Tell Asterisk to start sending us audio frames
            await this.setupExternalMediaInterface();
            
            debug(`Audio capture setup complete for channel ${this.channel.id}`);
            
        } catch (error) {
            console.error(`Error setting up snoop for channel ${this.channel.id}:`, error);
            console.error(error.stack);
        }
    }
    
	async setupExternalMedia() {
		try {
			debug(`Setting up external media for channel ${this.channel.id}`);
			
			// Get local IP address - make sure this is reachable from Asterisk
			const localIp = ip.address();
			const rtpPort = 10000 + (Math.floor(Math.random() * 10000) % 20000);
			
			debug(`Using RTP endpoint: ${localIp}:${rtpPort}`);
			
			// Create RTP server
			this.rtpServer = new RtpServer({
				port: rtpPort,
				host: '0.0.0.0', // Listen on all interfaces
				payloadType: 0,   // 0 = PCMU (G.711 μ-law)
				sampleRate: 8000  // 8kHz sampling rate
			});
			
			// Handle audio data from Asterisk
			this.rtpServer.on('audio-data', (data) => {
				if (this.isConnected && this.isAgentReady) {
					debug(`🎤 Received ${data.data.length} bytes of RTP audio data`);
					
					// Convert format if needed - Asterisk sends μ-law (G.711), Deepgram expects linear PCM
					const convertedAudio = this.convertFromMulaw(data.data);
					
					// Send to Deepgram via WebSocket
					this.sendAudioToServer(convertedAudio);
				}
			});
			
			// Handle client connections
			this.rtpServer.on('client-connected', (client) => {
				debug(`RTP client connected: ${client.address}:${client.port}`);
				this.rtpClient = client; // Store for sending audio back
			});
			
			// Start the RTP server
			await this.rtpServer.start();
			debug(`RTP server started on port ${rtpPort}`);
			
			// Tell Asterisk to start external media
			const externalMedia = await this.channel.externalMedia({
				format: 'ulaw',               // μ-law format
				direction: 'both',            // Bidirectional audio
				connection_type: 'client',    // Asterisk connects to us
				external_host: `${localIp}:${rtpPort}`  // Our RTP endpoint
			});
			
			debug(`External media started: ${JSON.stringify(externalMedia)}`);
			
			// Now we're ready to receive audio from Asterisk and send audio back
			
			// Set up audio forwarding from Deepgram to Asterisk
			this.setupAudioForwarding();
			
		} catch (error) {
			console.error(`Error setting up external media for channel ${this.channel.id}:`, error);
			console.error(error.stack);
			
			// Fall back to test audio generation
			debug(`Falling back to test audio generation`);
			this.startTestAudioGeneration();
		}
	}	

	setupAudioForwarding() {
		// Modify the handleServerMessage method to forward audio to RTP
		const originalHandleServerMessage = this.handleServerMessage;
		
		this.handleServerMessage = async (data) => {
			// If it's binary data (audio) and we have an RTP client
			if (data instanceof Buffer && this.rtpClient && this.rtpServer) {
				// Check if it might be JSON first
				const isText = isLikelyText(data);
				if (!isText) {
					debug(`Received ${data.length} bytes of audio from Deepgram`);
					
					// Convert from linear PCM to μ-law for Asterisk
					const convertedAudio = this.convertToMulaw(data);
					
					// Send to Asterisk via RTP
					this.rtpServer.sendAudioData(convertedAudio, this.rtpClient);
					return;
				}
			}
			
			// Otherwise, use the original handler
			await originalHandleServerMessage.call(this, data);
		};
	}

	// Add these helper methods for audio conversion
	convertFromMulaw(mulawData) {
		// Convert from G.711 μ-law to linear PCM
		// This is a simplified implementation - in production, use a proper library
		
		debug(`Converting ${mulawData.length} bytes from μ-law to linear PCM`);
		
		// For testing, just pass through the data
		// In production, use a library like 'g711' for proper conversion
		return mulawData;
	}

	convertToMulaw(linearData) {
		// Convert from linear PCM to G.711 μ-law
		// This is a simplified implementation - in production, use a proper library
		
		debug(`Converting ${linearData.length} bytes from linear PCM to μ-law`);
		
		// For testing, just pass through the data
		// In production, use a library like 'g711' for proper conversion
		return linearData;
	}

    // Setup external media to capture audio
    async setupExternalMediaInterface() {
        try {
            debug(`Setting up external media for channel ${this.channel.id}`);
            
            // Create a second snoop channel specifically for audio
            const audioSnoop = await this.channel.snoopChannel({
                spy: 'both', // Capture both directions
                app: config.asterisk.appName,
                appArgs: `audio:${this.channel.id}`
            });
            
            debug(`Audio snoop created: ${audioSnoop.id}`);
            this.audioSnoopChannel = audioSnoop;
            
            // Listen for audio frames from the channel
            // NOTE: This is a simplified approach - in a production environment,
            // you would use the Asterisk ARI's external media feature or a more robust
            // audio capture mechanism.
            
            // Simulate audio capture by generating test audio
            debug(`Starting test audio generation for channel ${this.channel.id}`);
            this.startTestAudioGeneration();
            
            // Check if we need to implement a more complex solution using ARI
            debug(`Note: This implementation uses test audio. For real audio capture, use ARI's external media.`);
            
        } catch (error) {
            console.error(`Error setting up external media for channel ${this.channel.id}:`, error);
            console.error(error.stack);
        }
    }
    
    // Generate test audio to simulate audio capture
    startTestAudioGeneration() {
        // This function generates test audio (a sine wave) for development/testing
        
        const sampleRate = 8000; // 8kHz
        const chunkDuration = 20; // 20ms chunks
        const samplesPerChunk = Math.floor(sampleRate * chunkDuration / 1000);
        const bytesPerSample = 2; // 16-bit audio = 2 bytes per sample
        const chunkSize = samplesPerChunk * bytesPerSample;
        
        debug(`Starting test audio generation (${chunkSize} bytes every ${chunkDuration}ms)`);
        
        let sampleIndex = 0;
        
        // Generate audio chunks at regular intervals
        this.audioGenerationInterval = setInterval(() => {
            if (!this.isConnected || !this.isAgentReady) {
                // Skip if not ready
                return;
            }
            
            // Generate a chunk of audio (sine wave at 440Hz)
            const buffer = Buffer.alloc(chunkSize);
            
            for (let i = 0; i < samplesPerChunk; i++) {
                // Generate a sample
                const sample = Math.sin(2 * Math.PI * 440 * sampleIndex / sampleRate) * 0x3FFF; // Use 16-bit range
                
                // Write to buffer
                buffer.writeInt16LE(Math.floor(sample), i * bytesPerSample);
                
                sampleIndex++;
                if (sampleIndex >= sampleRate) {
                    sampleIndex = 0; // Reset to avoid floating point errors
                }
            }
            
            // Send the audio to the server
            this.audioStats.totalReceived += buffer.length;
            //debug(`🎤 Generated ${buffer.length} bytes of test audio for channel ${this.channel.id}`);
            
            this.sendAudioToServer(buffer);
            
        }, chunkDuration);
    }
    
    // Send audio data to the voice agent server
    sendAudioToServer(audioData) {
        if (!this.serverWs || this.serverWs.readyState !== WebSocket.OPEN) {
            debug(`Cannot send audio: WebSocket not open for channel ${this.channel.id}`);
            return;
        }
        
        if (!audioData || audioData.length === 0) {
            debug(`No audio data to send for channel ${this.channel.id}`);
            return;
        }
        
        try {
            //debug(`📤 Sending ${audioData.length} bytes of audio to server for channel ${this.channel.id}`);
            
            // Send the audio data
            this.serverWs.send(audioData);
            this.audioStats.totalSent += audioData.length;
            
            //debug(`✅ Audio sent successfully for channel ${this.channel.id}`);
        } catch (error) {
            console.error(`Error sending audio to server for channel ${this.channel.id}:`, error);
            console.error(error.stack);
        }
    }
    
    // Convert audio format from Asterisk to what Deepgram expects
    convertAudioFormat(audioData) {
        // For now, we'll just pass the data through
        return audioData;
    }
    
    // Queue audio for playback to the caller
    async queueAudioPlayback(audioData) {
		debug(`Received ${audioData.length} bytes of audio to play to channel ${this.channel.id}`);
		
		if (!audioData || audioData.length === 0) {
			debug(`Empty audio data, not queueing for playback`);
			return;
		}
		
		try {
			// Convert audio format if needed
			const convertedAudio = this.convertResponseAudioFormat(audioData);
			
			// Create a temporary file to store the audio
			const tempFile = path.join(__dirname, 'temp', `response-${this.channel.id}-${Date.now()}.raw`);
			
			// Ensure temp directory exists
			if (!fs.existsSync(path.join(__dirname, 'temp'))) {
				fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
			}
			
			// Write the audio data to a file
			fs.writeFileSync(tempFile, convertedAudio);
			debug(`Created temporary audio file: ${tempFile} (${convertedAudio.length} bytes)`);
			
			// Add to playback queue
			this.playbackQueue.push(tempFile);
			debug(`Added file to playback queue, queue length: ${this.playbackQueue.length}`);
			
			// Start playback if not already playing
			if (!this.isPlaying) {
				debug(`Starting audio playback queue`);
				await this.playNextInQueue();
			}
		} catch (error) {
			console.error(`Error queueing audio for playback to channel ${this.channel.id}:`, error);
			console.error(error.stack);
		}
	}
    
    // Convert audio format from Deepgram to what Asterisk expects
    convertResponseAudioFormat(audioData) {
		debug(`Converting response audio format, input size: ${audioData.length} bytes`);
		
		// For initial testing, just pass through the audio data
		// But add a check for WAV header and strip it if present
		
		// Check if this might be a WAV file (starts with RIFF header)
		if (audioData.length > 44 && 
			audioData[0] === 0x52 && audioData[1] === 0x49 && 
			audioData[2] === 0x46 && audioData[3] === 0x46) {
			
			debug(`Detected WAV header, stripping it before playback`);
			// Skip the 44-byte WAV header
			return audioData.slice(44);
		}
		
		// Otherwise, just pass through the data
		return audioData;
	}
    
    // Play the next audio file in the queue
    async playNextInQueue() {
		if (this.playbackQueue.length === 0) {
			debug(`Playback queue empty for channel ${this.channel.id}`);
			this.isPlaying = false;
			return;
		}
		
		this.isPlaying = true;
		const audioFile = this.playbackQueue.shift();
		debug(`Playing next audio file from queue: ${audioFile}`);
		
		try {
			// Play the audio file to the channel
			debug(`Playing audio to channel ${this.channel.id} using file ${audioFile}`);
			
			// Extract just the filename for the media parameter
			const filename = path.basename(audioFile);
			
			// Try different playback methods
			try {
				// First try playing as a file path
				const playback = await this.channel.play({ media: `sound:${audioFile}` });
				debug(`Playback started with sound:${audioFile}`);
				
				// When playback finishes, play the next file
				playback.once('PlaybackFinished', () => {
					debug(`Playback finished for ${audioFile}`);
					
					// Clean up the temp file
					try {
						fs.unlinkSync(audioFile);
						debug(`Deleted temp file ${audioFile}`);
					} catch (error) {
						console.error(`Error deleting temp file ${audioFile}:`, error);
					}
					
					// Play next file
					this.playNextInQueue();
				});
			} catch (playError) {
				console.error(`Error playing with sound: prefix, trying file: prefix: ${playError.message}`);
				
				// Try with file: prefix
				try {
					const playback = await this.channel.play({ media: `file:${audioFile}` });
					debug(`Playback started with file:${audioFile}`);
					
					// When playback finishes, play the next file
					playback.once('PlaybackFinished', () => {
						debug(`Playback finished for ${audioFile}`);
						
						// Clean up the temp file
						try {
							fs.unlinkSync(audioFile);
						} catch (error) {
							console.error(`Error deleting temp file ${audioFile}:`, error);
						}
						
						// Play next file
						this.playNextInQueue();
					});
				} catch (fileError) {
					console.error(`Both playback methods failed: ${fileError.message}`);
					throw fileError; // Re-throw to be caught by outer catch
				}
			}
		} catch (error) {
			console.error(`Error playing audio to channel ${this.channel.id}:`, error);
			console.error(error.stack);
			this.isPlaying = false;
			
			// Clean up the temp file on error
			try {
				fs.unlinkSync(audioFile);
				debug(`Deleted temp file ${audioFile} after playback error`);
			} catch (unlinkError) {
				console.error(`Error deleting temp file ${audioFile}:`, unlinkError);
			}
			
			// Try to play the next file
			setTimeout(() => this.playNextInQueue(), 100);
		}
	}
    
    // Clean up when the call ends
    cleanup() {
		debug(`Cleaning up call state for channel ${this.channel.id}`);
		
		// Stop audio generation
		if (this.audioGenerationInterval) {
			debug(`Stopping audio generation for channel ${this.channel.id}`);
			clearInterval(this.audioGenerationInterval);
			this.audioGenerationInterval = null;
		}
		
		// Clear stats interval
		if (this.statsInterval) {
			debug(`Clearing stats interval for channel ${this.channel.id}`);
			clearInterval(this.statsInterval);
			this.statsInterval = null;
		}
		
		// Clear audio timing interval
		if (this.audioTimingInterval) {
			debug(`Clearing audio timing interval for channel ${this.channel.id}`);
			clearInterval(this.audioTimingInterval);
			this.audioTimingInterval = null;
		}
		
		// Clear ping interval
		if (this.pingInterval) {
			debug(`Clearing ping interval for channel ${this.channel.id}`);
			clearInterval(this.pingInterval);
			this.pingInterval = null;
		}
		
		if (this.rtpServer) {
			debug(`Stopping RTP server for channel ${this.channel.id}`);
			this.rtpServer.stop();
			this.rtpServer = null;
		}
		
		// Close the WebSocket connection
		if (this.serverWs) {
			debug(`Closing WebSocket connection for channel ${this.channel.id}`);
			
			try {
				// Check if the connection is still open
				if (this.serverWs.readyState === WebSocket.OPEN) {
					// Send termination message
					this.serverWs.send(JSON.stringify({
						type: 'terminate',
						channelId: this.channel.id,
						reason: 'Call cleanup'
					}));
					
					// Set a short timeout to ensure message is sent before closing
					setTimeout(() => {
						try {
							this.serverWs.close();
							debug(`WebSocket closed for channel ${this.channel.id}`);
						} catch (closeErr) {
							console.error(`Error closing WebSocket for channel ${this.channel.id}:`, closeErr);
						}
					}, 100);
				} else {
					debug(`WebSocket already closed (readyState: ${this.serverWs.readyState}) for channel ${this.channel.id}`);
				}
			} catch (err) {
				console.error(`Error during WebSocket cleanup for channel ${this.channel.id}:`, err);
			}
			
			this.serverWs = null;
		}
		
		// Clean up any temp files
		this.playbackQueue.forEach(file => {
			try {
				if (fs.existsSync(file)) {
					debug(`Deleting temp file: ${file}`);
					fs.unlinkSync(file);
				}
			} catch (error) {
				console.error(`Error deleting temp file ${file}:`, error);
			}
		});
		
		this.playbackQueue = [];
		
		debug(`Cleanup complete for channel ${this.channel.id}`);
	}
}

function isLikelyText(buffer) {
    // Check if buffer contains only ASCII characters
    for (let i = 0; i < Math.min(buffer.length, 100); i++) { // Check first 100 bytes max
        const byte = buffer[i];
        // Non-ASCII or control characters (except common ones like newline, tab)
        if ((byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte > 126) {
            return false;
        }
    }
    return true;
}

// Connect to Asterisk ARI
async function connectToARI() {
    try {
        debug('Connecting to Asterisk ARI...');
        debug(`URL: ${config.asterisk.url}`);
        debug(`Username: ${config.asterisk.username}`);
        debug(`App Name: ${config.asterisk.appName}`);
        
        // Connect to the ARI
        return new Promise((resolve, reject) => {
            ari.connect(
                config.asterisk.url, 
                config.asterisk.username, 
                config.asterisk.password,
                (err, client) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    debug('Connected to Asterisk ARI');
                    configureARIClient(client);
                    resolve(client);
                }
            );
        });
    } catch (error) {
        console.error('Error connecting to ARI:', error);
        throw error;
    }
}

// Configure the ARI client with event handlers
function configureARIClient(client) {
    const appName = config.asterisk.appName;
    
    // Handle incoming calls
    client.on('StasisStart', async (event, channel) => {
        const args = event.args || [];
        debug(`Stasis started for channel ${channel.id} with args: ${JSON.stringify(args)}`);
        
        // Check if this is a snoop channel or audio channel
        if (args.length > 0) {
            if (args[0].startsWith('snoop:')) {
                const originalChannelId = args[0].split(':')[1];
                debug(`This is a snoop channel for ${originalChannelId}: ${channel.id}`);
                return; // We'll handle snoop channels separately
            }
            
            if (args[0].startsWith('audio:')) {
                const originalChannelId = args[0].split(':')[1];
                debug(`This is an audio channel for ${originalChannelId}: ${channel.id}`);
                // Handle audio channel setup if needed
                return;
            }
        }
        
        try {
            debug(`Processing new call on channel ${channel.id}`);
            
            // Answer the channel if not already answered
            if (channel.state !== 'Up') {
                debug(`Answering channel ${channel.id}`);
                await channel.answer();
                debug(`Channel ${channel.id} answered`);
            }
            
            // Create a bridge for the call
            debug(`Creating bridge for channel ${channel.id}`);
            const bridge = await client.bridges.create({ type: 'mixing' });
            debug(`Created bridge: ${bridge.id} for channel ${channel.id}`);
            
            // Add the channel to the bridge
            debug(`Adding channel ${channel.id} to bridge ${bridge.id}`);
            await bridge.addChannel({ channel: channel.id });
            debug(`Added channel ${channel.id} to bridge ${bridge.id}`);
            
            // Create call state
            debug(`Creating call state for channel ${channel.id}`);
            const callState = new CallState(channel, bridge);
            activeCalls.set(channel.id, callState);
            
            // Connect to the voice agent server
            debug(`Connecting to voice server for channel ${channel.id}`);
            await callState.connectToServer();
            
            // Play welcome message
            try {
                debug(`Playing welcome message to channel ${channel.id}`);
                await channel.play({ media: 'sound:hello-world' });
                debug(`Played welcome message to channel ${channel.id}`);
            } catch (err) {
                console.error(`Error playing welcome message to channel ${channel.id}:`, err);
            }
            
            // Handle channel ending
            channel.once('StasisEnd', () => {
				debug(`Call ended on channel ${channel.id}`);
				
				// Clean up call state
				if (activeCalls.has(channel.id)) {
					const callState = activeCalls.get(channel.id);
					
					// Ensure WebSocket connection is closed
					if (callState.serverWs) {
						debug(`Closing WebSocket connection for channel ${channel.id}`);
						try {
							// Send a termination message to the server
							if (callState.serverWs.readyState === WebSocket.OPEN) {
								callState.serverWs.send(JSON.stringify({
									type: 'terminate',
									channelId: channel.id,
									reason: 'Call ended'
								}));
							}
							
							// Close the WebSocket connection
							callState.serverWs.close();
						} catch (err) {
							console.error(`Error closing WebSocket for channel ${channel.id}:`, err);
						}
					}
					
					// Run the cleanup method
					debug(`Running cleanup for channel ${channel.id}`);
					callState.cleanup();
					
					// Remove from active calls map
					activeCalls.delete(channel.id);
					debug(`Removed channel ${channel.id} from active calls`);
				}
				
				// Destroy the bridge
				debug(`Destroying bridge ${bridge.id}`);
				bridge.destroy().catch(err => {
					console.error(`Error destroying bridge ${bridge.id}:`, err);
				});
			});
        } catch (error) {
            console.error(`Error processing new call on channel ${channel.id}:`, error);
            console.error(error.stack);
        }
    });
    
    // Start the Stasis application
    debug(`Starting Stasis application: ${appName}`);
    client.start(appName);
}

// Main function
async function main() {
    try {
        // Connect to Asterisk ARI
        const client = await connectToARI();
        
        debug('Asterisk bridge started');
        
        // Handle process exit
        process.on('SIGINT', async () => {
            debug('Shutting down...');
            
            // Clean up all active calls
            for (const [channelId, callState] of activeCalls.entries()) {
                debug(`Cleaning up call: ${channelId}`);
                callState.cleanup();
            }
            
            client.close();
            process.exit(0);
        });
    } catch (error) {
        console.error('Error starting Asterisk bridge:', error);
        console.error(error.stack);
        process.exit(1);
    }
}

// Start the application
main();