// server.js - Updated with Deepgram function calling integration
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient, AgentEvents } = require('@deepgram/sdk');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// Import the new modules
const { configureDeepgramAgent } = require('./deepgram-config');
const { initializeFunctionHandler, handleFunctionCallRequest } = require('./function-handler');

// Load environment variables
dotenv.config();

// Debug mode
const DEBUG = process.env.DEBUG;

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
const wss = new WebSocket.Server({ server });

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

// Create a Deepgram client
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// WebSocket connection handler
wss.on('connection', (ws) => {
    debug('Client connected to WebSocket server');

    // Track if the Deepgram connection is active
    let deepgramConnection = null;
    let isConfigured = false;
    let keepAliveInterval = null;

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

                        // Handle command
                        if (command.type === 'action_response') {
                            // Forward the response to Deepgram
                            await handleActionResponse(command, deepgramConnection);
                        } else {
                            // Handle other commands as usual
                            handleCommand(command);
                        }
                    } catch (parseError) {
                        console.error('Error parsing JSON command');
                    }
                } else {
                    // It's regular binary audio data
                    //debug(`Received binary audio data: ${message.length} bytes`);
                    if (deepgramConnection && isConfigured) {
                        deepgramConnection.send(message);
                    } else {
                        debug('Ignoring audio data - Deepgram not ready yet');

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

    // Handle commands from client
    function handleCommand(command) {
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

                    // Notify client that connection is ready
                    ws.send(JSON.stringify({
                        type: 'status',
                        status: 'ready',
                        message: 'Agent ready. Click "Start Conversation" to begin.'
                    }));
                    debug('Sent ready status to client');

                    // Send a welcome message from the agent
                    setTimeout(() => {
                        const restaurantName = restaurantData ? restaurantData.name : "Pixel Pizzeria";
                        ws.send(JSON.stringify({
                            type: 'transcript',
                            data: {
                                speaker: 'agent',
                                text: `Hello! Welcome to ${restaurantName}. I'm your virtual assistant. How can I help you today?`
                            }
                        }));
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
                //console.log('Received audio data from Deepgram, size:', audioData.byteLength);
                try {
                    ws.send(audioData);
                } catch (err) {
                    console.error('Error sending audio data to client:', err);
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
            debug('Received terminate request from client');

            // Clean up without calling close()
            deepgramConnection = null;
            isConfigured = false;

            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                keepAliveInterval = null;
            }

            try {
                ws.send(JSON.stringify({
                    type: 'status',
                    status: 'terminated',
                    message: 'Agent connection terminated by request.'
                }));
            } catch (err) {
                console.error('Error sending termination confirmation:', err);
            }
        }
        else {
            debug('Unknown command type:', command.type);
        }
    }

    // Handle WebSocket close
    ws.on('close', () => {
        debug('Client disconnected');

        // Clean up Deepgram connection
        deepgramConnection = null;
        isConfigured = false;

        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

async function handleActionResponse(response, deepgramConnection) {
    try {
        if (!response.function_call_id) {
            console.error('Missing function_call_id in action response');
            return;
        }
                
        // Format the response for Deepgram in exact format
        const exactResponse1 = {
            function_name: response.function_name,
            function_call_id: response.function_call_id,
            response: {
                confirmation: 'request received',
            }
        };

        const exactResponse = {
            "type": "FunctionCallResponse",
            "function_call_id": response.function_call_id,
            "output": "request received"
          }

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
});