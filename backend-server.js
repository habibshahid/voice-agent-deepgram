// server.js - Updated with improved Asterisk integration
// Add Blob polyfill first before any other imports
global.Blob = require('buffer').Blob;

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient, AgentEvents } = require('@deepgram/sdk');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const url = require('url');

// Import the new modules
const { configureDeepgramAgent } = require('./deepgram-config');
const { initializeFunctionHandler, handleFunctionCallRequest } = require('./function-handler');
const audioStats = new Map();
// Load environment variables
dotenv.config();

// Debug mode
const DEBUG = process.env.DEBUG || true;

function debug(message, data) {
    if (DEBUG) {
        if (data) {
            console.log(`[SERVER] ${message}`, typeof data === 'object' ? JSON.stringify(data) : data);
        } else {
            console.log(`[SERVER] ${message}`);
        }
    }
}

// Check for API key
if (!process.env.DEEPGRAM_API_KEY) {
    console.error('Missing DEEPGRAM_API_KEY environment variable');
    process.exit(1);
}

// Initialize Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
    server
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Load restaurant data
let restaurantData = null;

function loadRestaurantData() {
    try {
        const restaurantDataPath = path.join(__dirname, 'public', 'restaurant-data.js');
        const fileContent = fs.readFileSync(restaurantDataPath, 'utf8');
        
        // Create a mock window object to receive the data
        const mockWindow = {};
        
        // Create a context for running the JS file
        const context = { window: mockWindow };
        
        // Execute the script in the mocked context
        vm.runInNewContext(fileContent, context);
        
        // Get the data from the mock window
        const data = mockWindow.restaurantData;
        
        if (data) {
            debug('Restaurant data loaded successfully');
            
            // Preprocess the data for easier access
            // Combine all menu items into a single array for easier searching
            data.allMenuItems = [];
            
            if (data.menu) {
                for (const category of ['pizzas', 'sides', 'drinks', 'desserts']) {
                    if (data.menu[category]) {
                        data.allMenuItems.push(...data.menu[category]);
                    }
                }
            }
            
            return data;
        } else {
            console.error('Failed to extract restaurant data from file');
            return null;
        }
    } catch (error) {
        console.error('Error loading restaurant data:', error);
        return null;
    }
}

// Load restaurant data
restaurantData = loadRestaurantData();

function trackAudio(clientId, direction, byteCount) {
    if (!audioStats.has(clientId)) {
        debug(`Creating audio stats tracker for client ${clientId}`);
        audioStats.set(clientId, {
            received: 0,
            sent: 0,
            lastReport: Date.now(),
            reportInterval: setInterval(() => {
                const stats = audioStats.get(clientId);
                if (!stats) return;
                
                const now = Date.now();
                const elapsedSec = (now - stats.lastReport) / 1000;
                
                debug(`Audio stats for client ${clientId}:`);
                debug(`- Received: ${stats.received} bytes (${Math.round(stats.received / elapsedSec / 1024)} KB/s)`);
                debug(`- Sent: ${stats.sent} bytes (${Math.round(stats.sent / elapsedSec / 1024)} KB/s)`);
                
                if (stats.sent === 0) {
                    debug(`⚠️ WARNING: No audio sent to client in the last ${elapsedSec} seconds!`);
                    debug(`This indicates a one-way audio issue - check Deepgram audio events`);
                }
                
                stats.received = 0;
                stats.sent = 0;
                stats.lastReport = now;
            }, 5000)
        });
    }
    
    const stats = audioStats.get(clientId);
    if (direction === 'received') {
        stats.received += byteCount;
    } else {
        stats.sent += byteCount;
    }
}


function cleanupAudioStats(clientId) {
    if (audioStats.has(clientId)) {
        const stats = audioStats.get(clientId);
        if (stats.reportInterval) {
            clearInterval(stats.reportInterval);
        }
        audioStats.delete(clientId);
    }
}

// Create a Deepgram client
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// WebSocket connection handler
wss.on('connection', (ws, req) => {
	const urlPath = req.url;
    debug(`WebSocket connection established on path: ${urlPath}`);
    // Parse the URL to check if this is an Asterisk connection
    const urlParsed = url.parse(req.url, true);
    const isAsteriskBridge = urlParsed.pathname === '/asterisk';
    
    debug(`Client connected to WebSocket server. Asterisk Bridge: ${isAsteriskBridge}`);
    debug(`Connection URL: ${req.url}`);

    // Track if the Deepgram connection is active
    let deepgramConnection = null;
    let isConfigured = false;
    let keepAliveInterval = null;
    let channelId = null; // For Asterisk connections

    // Initialize the function handler with the client WebSocket
    initializeFunctionHandler(ws, restaurantData);

    // Send initial status to client
    try {
        ws.send(JSON.stringify({
            type: 'status',
            status: 'connected',
            message: 'Connected to server. Waiting for initialization.'
        }));
        debug('Sent initial status message to client');
    } catch (error) {
        console.error('Error sending initial status:', error);
    }

    // Handle messages from the client
    ws.on('message', async (message) => {
		try {
			// Generate a clientId 
			const clientId = isAsteriskBridge ? 
				channelId || 'unknown-asterisk' : 
				req.headers['sec-websocket-key'] || 'unknown-web';
			
			// Try to determine if this is a binary audio buffer or a text command
			if (message instanceof Buffer) {
				// Check if it looks like JSON (starts with '{')
				// This is necessary because text messages are sometimes received as Buffer
				const firstByte = message[0];
				if (firstByte === 123) { // 123 is ASCII code for '{'
					// This is likely a text message received as buffer
					const textMessage = message.toString();
					debug('Received text message as buffer:');

					try {
						const command = JSON.parse(textMessage);
						debug('Parsed JSON command:', command);

						// Store channel ID for Asterisk connections
						if (isAsteriskBridge && command.channelId) {
							channelId = command.channelId;
							debug(`Associated with Asterisk channel: ${channelId}`);
						}

						// Handle command
						if (command.type === 'action_response') {
							// Forward the response to Deepgram
							await handleActionResponse(command, deepgramConnection);
						} else {
							// Handle other commands as usual
							handleCommand(command);
						}
					} catch (parseError) {
						console.error('Error parsing JSON command:', parseError);
					}
				} else {
					// It's regular binary audio data
					const dataLength = message.length;
					//debug(`📥 Received binary audio data: ${dataLength} bytes from ${isAsteriskBridge ? 'Asterisk' : 'web client'}`);
					
					// Track audio stats
					trackAudio(clientId, 'received', dataLength);
					
					if (deepgramConnection && isConfigured) {
						// Log just before sending to Deepgram
						//debug(`📤 Sending ${dataLength} bytes of audio to Deepgram`);
						
						try {
							// Forward the audio to Deepgram
							deepgramConnection.send(message);
							//debug(`✅ Audio sent to Deepgram: ${dataLength} bytes`);
						} catch (err) {
							console.error(`Error sending audio to Deepgram: ${err.message}`);
						}
					} else {
						debug('❌ Ignoring audio data - Deepgram not ready yet');

						// Inform client that we're not ready yet
						try {
							ws.send(JSON.stringify({
								type: 'status',
								status: 'not_ready',
								message: 'Please wait for Deepgram connection to be ready before sending audio.'
							}));
						} catch (err) {
							console.error('Error sending not-ready message:', err);
						}
					}
				}
			} else {
				// It's already a string (rare but possible depending on WebSocket implementation)
				debug('Received string message:', message);

				try {
					const command = JSON.parse(message);
					debug('Parsed JSON command:', command);

					// Store channel ID for Asterisk connections
					if (isAsteriskBridge && command.channelId) {
						channelId = command.channelId;
						debug(`Associated with Asterisk channel: ${channelId}`);
					}

					// Handle command
					handleCommand(command);
				} catch (parseError) {
					console.error('Error parsing JSON command from string:', parseError);
				}
			}
		} catch (error) {
			console.error('Error handling WebSocket message:', error);
			try {
				ws.send(JSON.stringify({
					type: 'error',
					message: `Server error: ${error.message}`
				}));
			} catch (sendError) {
				console.error('Error sending error message to client:', sendError);
			}
		}
	});
	
	function sendToClient(ws, data) {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			debug(`Cannot send message: WebSocket not open (readyState: ${ws ? ws.readyState : 'undefined'})`);
			return false;
		}
		
		try {
			// If it's a string, send as is
			if (typeof data === 'string') {
				debug(`Sending string data (${data.length} chars) to client`);
				ws.send(data);
				return true;
			}
			
			// If it's a Buffer or ArrayBuffer, send as binary
			if (data instanceof Buffer || data instanceof ArrayBuffer) {
				debug(`Sending binary data (${data.byteLength || data.length} bytes) to client`);
				ws.send(data);
				return true;
			}
			
			// If it's a plain object or array, stringify to JSON
			if (typeof data === 'object') {
				const jsonStr = JSON.stringify(data);
				debug(`Sending JSON object as string (${jsonStr.length} chars) to client`);
				ws.send(jsonStr);
				return true;
			}
			
			// Fallback - convert to string
			const strData = String(data);
			debug(`Sending data converted to string (${strData.length} chars) to client`);
			ws.send(strData);
			return true;
		} catch (error) {
			console.error(`Error sending data to client: ${error.message}`);
			console.error(error.stack);
			return false;
		}
	}

	function sendStatusToClient(ws, status, message) {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			debug(`Cannot send status: WebSocket not open (readyState: ${ws ? ws.readyState : 'undefined'})`);
			return false;
		}
		
		try {
			const statusMsg = {
				type: 'status',
				status: status,
				message: message || ''
			};
			
			const jsonStr = JSON.stringify(statusMsg);
			debug(`SENDING STATUS [${status}]: ${message} (${jsonStr.length} bytes)`);
			
			// Important: send as string, not as binary!
			ws.send(jsonStr);
			
			debug(`STATUS SENT SUCCESSFULLY: ${status}`);
			return true;
		} catch (error) {
			console.error(`Error sending status message: ${error.message}`);
			console.error(error.stack);
			return false;
		}
	}
	
    // Handle commands from client
    function handleCommand(command) {
		//console.log("handleCommand", command)
		
        if (command.type === 'init') {
            debug('Received init command from client');

            // Initialize Deepgram connection
            debug('Initializing Deepgram connection...');

            if (deepgramConnection) {
                debug('Existing Deepgram connection will be replaced');
                // Don't call close() directly, it might cause errors
                deepgramConnection = null;
                isConfigured = false;

                // Clear any existing keepalive interval
                if (keepAliveInterval) {
                    clearInterval(keepAliveInterval);
                    keepAliveInterval = null;
                }
            }

            // Create new Deepgram Agent connection
            deepgramConnection = deepgram.agent();
            debug('Created Deepgram agent connection');

			deepgramConnection.on('open', () => {
				debug(`Deepgram connection opened successfully`);
				
				// List all event handlers attached to Deepgram connection
				const eventNames = Object.keys(AgentEvents).map(key => AgentEvents[key]);
				debug(`Registered Deepgram event handlers: ${eventNames.join(', ')}`);
				
				// Add a handler for all events to log them
				deepgramConnection.on(AgentEvents.Unhandled, (event) => {
					debug(`Unhandled Deepgram event: ${JSON.stringify(event)}`);
				});
			});
			
            // Set up event handlers
            deepgramConnection.on(AgentEvents.Open, async () => {
                debug('Deepgram connection opened');

                try {
                    // Configure the Deepgram agent with our predefined functions
                    isConfigured = await configureDeepgramAgent(deepgramConnection, restaurantData);
                    
                    if (!isConfigured) {
                        throw new Error('Failed to configure Deepgram agent');
                    }

                    // Set up keepalive
                    keepAliveInterval = setInterval(() => {
                        if (deepgramConnection) {
                            //debug('Sending keepalive to Deepgram');
                            try {
                                deepgramConnection.keepAlive();
                            } catch (err) {
                                console.error('Error sending keepalive:', err);
                            }
                        } else {
                            clearInterval(keepAliveInterval);
                            keepAliveInterval = null;
                        }
                    }, 5000);

					sendStatusToClient(ws, 'ready', 'Agent ready. Click "Start Conversation" to begin.');
					
                    debug('Sent ready status to client');

                    // Send a welcome message from the agent
                    setTimeout(() => {
                        const restaurantName = restaurantData ? restaurantData.name : "Pixel Pizzeria";

						sendToClient(ws, {
						    type: 'transcript',
						    data: {
						        speaker: 'agent',
						        text: `Hello! Welcome to ${restaurantName}. I'm your virtual assistant. How can I help you today?`
						    }
						});
                        debug('Sent welcome message to client');
                    }, 500);
                } catch (error) {
                    console.error('Error configuring Deepgram agent:', error);

                    ws.send(JSON.stringify({
                        type: 'error',
                        message: `Failed to configure agent: ${error.message || 'Unknown error'}`
                    }));

                    // Clean up on configuration error
                    deepgramConnection = null;
                    isConfigured = false;

                    if (keepAliveInterval) {
                        clearInterval(keepAliveInterval);
                        keepAliveInterval = null;
                    }
                }
            });

            // Handle errors
            deepgramConnection.on(AgentEvents.Error, (error) => {
                console.error('Deepgram Agent error:', error);

                try {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: error.message || 'Unknown Deepgram error'
                    }));
                } catch (wsError) {
                    console.error('Error sending error to client:', wsError);
                }
            });

            // When connection closes
            deepgramConnection.on(AgentEvents.Close, (event) => {
                debug('Deepgram Agent connection closed:', event);

                try {
                    ws.send(JSON.stringify({
                        type: 'status',
                        status: 'closed',
                        message: 'Agent connection closed. Please refresh to reconnect.'
                    }));
                } catch (wsError) {
                    console.error('Error sending close notification to client:', wsError);
                }

                // Clean up
                deepgramConnection = null;
                isConfigured = false;

                if (keepAliveInterval) {
                    clearInterval(keepAliveInterval);
                    keepAliveInterval = null;
                }
            });

            // Forward all relevant Deepgram events to the client
            deepgramConnection.on(AgentEvents.ConversationText, async (data) => {
                debug('Conversation text:', data);

                ws.send(JSON.stringify({
                    type: 'transcript',
                    data: data
                }));

                // Only respond to user utterances
                if (data.speaker === 'user' && data.text) {
                    try {
                        // Send the text to Deepgram agent for thinking/speaking
                        await deepgramConnection.receiveText(data.text);
                        debug('Sent text to Deepgram agent for thinking/speaking');
                    } catch (err) {
                        console.error('Failed to send user text to agent:', err);
                    }
                }
            });

            // Handle function call requests from Deepgram
            deepgramConnection.on('FunctionCallRequest', async (request) => {
                debug('Function call request received:', request);
                
                try {
                    // Process the function call
                    await handleFunctionCallRequest(request, deepgramConnection);
                } catch (error) {
                    console.error('Error handling function call request:', error);
                    
                    // Send error response
                    try {
                        const response = {
                            type: 'FunctionCallResponse',
                            function_call_id: request.function_call_id,
                            output: {
                                error: error.message || 'Unknown error'
                            }
                        };
                        
                        deepgramConnection.send(JSON.stringify(response));
                    } catch (err) {
                        console.error('Error sending function call response:', err);
                    }
                }
            });

            // Handle audio data from Deepgram agent
            deepgramConnection.on(AgentEvents.Audio, (audioData) => {
				// Forward binary audio data to client
				const clientId = isAsteriskBridge ? 
					channelId || 'unknown-asterisk' : 
					req.headers['sec-websocket-key'] || 'unknown-web';
				
				debug(`📥 Received ${audioData.byteLength} bytes of audio from Deepgram`);
				
				try {
					// Track audio stats
					if (audioStats && audioStats.has(clientId)) {
						audioStats.get(clientId).sent += audioData.byteLength;
					}
					
					// Send the audio to the client
					debug(`📤 Sending ${audioData.byteLength} bytes of audio to client ${isAsteriskBridge ? channelId : 'web'}`);
					
					if (ws.readyState === WebSocket.OPEN) {
						ws.send(audioData);
						debug(`✅ Audio sent to client: ${audioData.byteLength} bytes`);
					} else {
						debug(`❌ Cannot send audio: WebSocket not open (readyState: ${ws.readyState})`);
					}
				} catch (err) {
					console.error(`Error sending audio data to client: ${err.message}`);
					console.error(err.stack);
				}
			});

            deepgramConnection.on(AgentEvents.AgentAudioDone, () => {
                try {
                    ws.send(JSON.stringify({
                        type: 'audioComplete'
                    }));
                } catch (err) {
                    console.error('Error sending audioComplete to client:', err);
                }
            });

            deepgramConnection.on(AgentEvents.UserStartedSpeaking, () => {
                try {
                    ws.send(JSON.stringify({
                        type: 'userStartedSpeaking'
                    }));
                } catch (err) {
                    console.error('Error sending userStartedSpeaking to client:', err);
                }
            });

            // Set up specific handler for EndOfThought event
            deepgramConnection.on('EndOfThought', (data) => {
                console.log('EndOfThought event received:', data);

                // Forward event to client
                try {
                    ws.send(JSON.stringify({
                        type: 'endOfThought',
                        data: data
                    }));
                } catch (err) {
                    console.error('Error sending EndOfThought to client:', err);
                }
            });

            // Add a handler for unhandled events to see what's coming through
            deepgramConnection.on(AgentEvents.Unhandled, (data) => {
                console.log('Unhandled Deepgram event received:', data);

                // Forward unhandled events to client for debugging
                if(data.type === 'EndOfThought') {
                    try {
                        ws.send(JSON.stringify({
                            type: 'endOfThought',
                            data: data
                        }));
                    } catch (err) {
                        console.error('Error sending EndOfThought to client:', err);
                    }
                }
            });

            // Handle agent speaking events
            deepgramConnection.on(AgentEvents.AgentStartedSpeaking, (data) => {
                debug("Agent started speaking:", data);

                // Notify client that audio is coming
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'agentStartedSpeaking',
                        data: data
                    }));
                }
            });
        }
        else if (command.type === 'terminate') {
			debug(`Received terminate request from client${channelId ? ' for channel ' + channelId : ''}`);
			debug(`Terminate reason: ${command.reason || 'No reason provided'}`);
			
			// Clean up Deepgram connection
			if (deepgramConnection) {
				debug('Terminating Deepgram connection');
				
				try {
					// Send a final message to Deepgram if needed
					if (deepgramConnection.readyState === WebSocket.OPEN) {
						debug('Sending final message to Deepgram before termination');
						// You might want to send a specific message to Deepgram to indicate termination
					}
				} catch (err) {
					console.error('Error sending final message to Deepgram:', err);
				}
				
				// Don't call close() directly as it might cause errors
				deepgramConnection = null;
			}
			
			isConfigured = false;
			
			if (keepAliveInterval) {
				debug('Clearing keepalive interval');
				clearInterval(keepAliveInterval);
				keepAliveInterval = null;
			}
			
			// Clear any audio statistics for this client
			const clientId = isAsteriskBridge ? 
				channelId || 'unknown-asterisk' : 
				req.headers['sec-websocket-key'] || 'unknown-web';
			
			if (audioStats && audioStats.has(clientId)) {
				debug(`Clearing audio stats for client ${clientId}`);
				cleanupAudioStats(clientId);
			}
			
			try {
				debug('Sending termination confirmation to client');
				ws.send(JSON.stringify({
					type: 'status',
					status: 'terminated',
					message: 'Agent connection terminated by request.'
				}));
			} catch (err) {
				console.error('Error sending termination confirmation:', err);
			}
			
			// Log termination
			console.log(`Client connection terminated: ${isAsteriskBridge ? 'Asterisk' : 'Web'} client${channelId ? ' (channel: ' + channelId + ')' : ''}`);
		}
		else if (command.type === 'ping') {
			// Respond with a pong
			//debug(`Received ping from client ${isAsteriskBridge ? 'Asterisk' : 'Web'}`);
			try {
				const pongMessage = {
					type: 'pong',
					timestamp: command.timestamp,
					serverTime: Date.now()
				};
				
				//debug(`Sending pong response: ${JSON.stringify(pongMessage)}`);
				sendToClient(ws, pongMessage);
				//debug('Sent pong response');
			} catch (err) {
				console.error('Error sending pong response:', err);
			}
		}
        else {
            debug('Unknown command type:', command.type);
        }
    }

    // Handle WebSocket close
    ws.on('close', (code, reason) => {
		debug(`Client disconnected (Code: ${code}, Reason: ${reason || 'None provided'})`);
		
		// Clean up audio stats
		const clientId = isAsteriskBridge ? 
			channelId || 'unknown-asterisk' : 
			req.headers['sec-websocket-key'] || 'unknown-web';
		
		if (audioStats && audioStats.has(clientId)) {
			debug(`Cleaning up audio stats for client ${clientId}`);
			cleanupAudioStats(clientId);
		}
		
		// Clean up Deepgram connection
		if (deepgramConnection) {
			debug('Cleaning up Deepgram connection');
			deepgramConnection = null;
		}
		
		isConfigured = false;
		
		if (keepAliveInterval) {
			debug('Clearing keepalive interval');
			clearInterval(keepAliveInterval);
			keepAliveInterval = null;
		}
		
		// Log disconnection
		console.log(`Client disconnected: ${isAsteriskBridge ? 'Asterisk' : 'Web'} client${channelId ? ' (channel: ' + channelId + ')' : ''}`);
	});

    // Handle WebSocket errors
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function safeSendToClient(ws, message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        debug(`Cannot send message: WebSocket not open (readyState: ${ws ? ws.readyState : 'undefined'})`);
        return false;
    }
    
    try {
        if (typeof message === 'string') {
            ws.send(message);
        } else {
            ws.send(JSON.stringify(message));
        }
        return true;
    } catch (error) {
        console.error('Error sending message to client:', error);
        return false;
    }
}

async function handleActionResponse(response, deepgramConnection) {
    try {
        if (!response.function_call_id) {
            console.error('Missing function_call_id in action response');
            return;
        }
                
        // Format the response for Deepgram in exact format
        const exactResponse = {
            "type": "FunctionCallResponse",
            "function_call_id": response.function_call_id,
            "output": "request received"
        };

        debug('Sending function response to Deepgram:', exactResponse);
        
        // Send the response to Deepgram
        deepgramConnection.send(JSON.stringify(exactResponse));
        
    } catch (error) {
        console.error('Error handling action response:', error);
    }
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    debug(`Server listening at http://localhost:${PORT}`);
    debug(`Asterisk bridge endpoint at ws://localhost:${PORT}/asterisk`);
});