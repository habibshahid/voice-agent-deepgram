// Updated function-handler.js with fixes for Deepgram's function call format

// Track the client's WebSocket connection
let clientWebSocket = null;
let restaurantData = null;

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

/**
 * Initialize the function handler with the client WebSocket and restaurant data
 * @param {WebSocket} ws - Client WebSocket connection
 * @param {Object} data - Restaurant data
 */
function initializeFunctionHandler(ws, data) {
    clientWebSocket = ws;
    restaurantData = data;
}

/**
 * Process a function call request from Deepgram
 * @param {Object} request - Function call request from Deepgram
 * @param {WebSocket} deepgramConnection - Deepgram WebSocket connection
 * @returns {Promise<void>}
 */
async function handleFunctionCallRequest(request, deepgramConnection) {
    debug('Function call request received:', request);
    
    if (!clientWebSocket) {
        console.error('No client WebSocket connection available');
        return sendFunctionCallResponse(
            deepgramConnection, 
            request.function_call_id, 
            request.function_name,
            { error: 'No client connection available' }
        );
    }
    
    try {
        // Extract function details from Deepgram's format
        const functionName = request.function_name;
        const functionArgs = request.input || {};
        const functionId = request.function_call_id;
        
        debug(`Processing function call: ${functionName}`, functionArgs);
        
        // Add the function name to the data sent to client
        sendActionToClient(functionName, functionArgs, functionId, functionName);
        
    } catch (error) {
        console.error('Error handling function call:', error);
        
        // Send error response with the function name
        await sendFunctionCallResponse(
            deepgramConnection, 
            request.function_call_id, 
            request.function_name,
            { success: false, error: error.message || 'Unknown error' }
        );
    }
}


/**
 * Send a function call response back to Deepgram
 * @param {WebSocket} deepgramConnection - Deepgram WebSocket connection
 * @param {string} functionId - ID of the function call
 * @param {string} functionName - Name of the function that was called
 * @param {Object} result - Result of the function call
 * @returns {Promise<void>}
 */
async function sendFunctionCallResponse(deepgramConnection, functionId, functionName, result) {
    try {
        // Create a confirmation message based on the result
        let confirmationText = "";
        
        if (functionName === "add_to_cart" && result.item) {
            const quantity = result.item.quantity || 1;
            const size = result.item.size ? `${result.item.size} ` : '';
            const name = result.item.name || "item";
            const customizations = result.item.customizations && result.item.customizations.length > 0
                ? ` with ${result.item.customizations.join(', ')}`
                : '';
            
            confirmationText = `Added ${quantity} ${size}${name}${customizations} to your cart.`;
        } 
        else if (functionName === "remove_from_cart" && result.item) {
            confirmationText = `Removed ${result.item.name || "item"} from your cart.`;
        } 
        else if (functionName === "clear_cart") {
            confirmationText = `Cleared all items from your cart.`;
        } 
        else if (functionName === "modify_cart_item" && result.item) {
            confirmationText = `Updated ${result.item.name || "item"} in your cart.`;
        } 
        else {
            confirmationText = "Request processed successfully.";
        }
        
        // Create the exact format for the response
        const responseObject = {
            function_name: functionName,
            function_call_id: functionId,
            response: {
                confirmation: confirmationText
            }
        };
        
        debug('Sending function response to Deepgram:', responseObject);
        
        // Send the response
        deepgramConnection.send(JSON.stringify(responseObject));
        
    } catch (error) {
        console.error('Error sending function call response:', error);
        
        // Send an error response in the same format if something went wrong
        const errorResponse = {
            function_name: functionName,
            function_call_id: functionId,
            response: {
                confirmation: "Sorry, there was an error processing your request.",
                error: error.message || "Unknown error"
            }
        };
        
        try {
            deepgramConnection.send(JSON.stringify(errorResponse));
        } catch (sendError) {
            console.error('Error sending error response:', sendError);
        }
    }
}

/**
 * Send an action to the client
 * @param {string} type - Action type
 * @param {Object} data - Action data
 * @param {string} functionId - ID of the function call
 * @param {string} functionName - Name of the function
 */
function sendActionToClient(type, data, functionId, functionName) {
    if (!clientWebSocket) {
        console.error('No client WebSocket connection available');
        return;
    }
    
    try {
        const action = {
            type: type,
            ...data,
            function_call_id: functionId,
            function_name: functionName  // Add function name
        };
        
        clientWebSocket.send(JSON.stringify({
            type: 'actions',
            actions: [action]
        }));
        
        debug(`Sent ${type} action to client:`, action);
    } catch (error) {
        console.error('Error sending action to client:', error);
    }
}

module.exports = {
    initializeFunctionHandler,
    handleFunctionCallRequest
};