// Updated Deepgram configuration for server.js
// This includes function definitions for cart operations
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

async function configureDeepgramAgent(deepgramConnection, restaurantData) {
    debug('Creating restaurant instructions...');
    const restaurantInstructions = createRestaurantInstructions(restaurantData);
    
    debug('Configuring Deepgram agent...');
    await deepgramConnection.configure({
        audio: {
            input: {
                encoding: "linear16",
                sampleRate: 16000,
            },
            output: {
                encoding: "linear16",
                sampleRate: 24000,
                container: "none",
            },
        },
        agent: {
            listen: {
                model: "nova-2",
            },
            speak: {
                model: "aura-asteria-en",
            },
            think: {
                provider: {
                    type: "open_ai",
                },
                model: "gpt-4o",
                instructions: restaurantInstructions,
                // Define the functions the agent can call
                functions: [
                    {
                        name: "add_to_cart",
                        description: "Add an item to the customer's cart",
                        parameters: {
                            type: "object",
                            properties: {
                                item: {
                                    type: "string",
                                    description: "The name of the menu item to add"
                                },
                                quantity: {
                                    type: "integer",
                                    description: "The quantity of the item to add",
                                    default: 1
                                },
                                size: {
                                    type: "string",
                                    description: "The size of the item (Small, Medium, Large, X-Large)",
                                    enum: ["Small", "Medium", "Large", "X-Large"],
                                    default: "Medium"
                                },
                                customizations: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Any customizations for the item (extra toppings, etc.)"
                                }
                            },
                            required: ["item"]
                        }
                    },
                    {
                        name: "modify_cart_item",
                        description: "Modify an existing item in the customer's cart",
                        parameters: {
                            type: "object",
                            properties: {
                                item: {
                                    type: "string",
                                    description: "The name of the menu item to modify"
                                },
                                quantity: {
                                    type: "integer",
                                    description: "The new quantity of the item"
                                },
                                size: {
                                    type: "string",
                                    description: "The new size of the item",
                                    enum: ["Small", "Medium", "Large", "X-Large"]
                                },
                                customizations: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "The new customizations for the item"
                                }
                            },
                            required: ["item"]
                        }
                    },
                    {
                        name: "remove_from_cart",
                        description: "Remove an item from the customer's cart",
                        parameters: {
                            type: "object",
                            properties: {
                                item: {
                                    type: "string",
                                    description: "The name of the menu item to remove"
                                }
                            },
                            required: ["item"]
                        }
                    },
                    {
                        name: "clear_cart",
                        description: "Clear all items from the customer's cart",
                        parameters: {
                            type: "object",
                            properties: {}
                        }
                    },
                    {
                        name: "get_cart_contents",
                        description: "Get the contents of the customer's cart",
                        parameters: {
                            type: "object",
                            properties: {}
                        }
                    },
                    {
                        name: "checkout",
                        description: "Process the customer's order for checkout",
                        parameters: {
                            type: "object",
                            properties: {
                                delivery: {
                                    type: "boolean",
                                    description: "Whether the customer wants delivery or pickup",
                                    default: true
                                },
                                address: {
                                    type: "string",
                                    description: "Delivery address if applicable"
                                },
                                phone: {
                                    type: "string",
                                    description: "Customer's phone number"
                                }
                            }
                        }
                    },
                    {
                        name: "suggest_deal",
                        description: "Suggest a deal that matches the customer's order",
                        parameters: {
                            type: "object",
                            properties: {}
                        }
                    },
                    {
                        name: "update_customer_name",
                        description: "Update the customer's name for the order",
                        parameters: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string",
                                    description: "The customer's name"
                                }
                            },
                            required: ["name"]
                        }
                    },
                    {
                        name: "update_customer_phone_number",
                        description: "Update the customer's phone number for the order",
                        parameters: {
                            type: "object",
                            properties: {
                                phone: {
                                    type: "string",
                                    description: "The customer's phone number"
                                }
                            },
                            required: ["phone"]
                        }
                    },
                    {
                        name: "update_customer_address",
                        description: "Update the customer's address for delivery",
                        parameters: {
                            type: "object",
                            properties: {
                                address: {
                                    type: "string",
                                    description: "The customer's delivery address"
                                }
                            },
                            required: ["address"]
                        }
                    }
                ],
            },
        },
    });
    
    debug('Deepgram Agent configured successfully with functions');
    return true;
}

// Create improved restaurant instructions for the agent
function createRestaurantInstructions(data) {
    if (!data) {
        return "You are a helpful assistant for a pizza restaurant.";
    }
    
    // Format the instructions with menu information
    const instructions = `
You are a voice assistant for ${data.name}, a pizza restaurant. Your job is to help customers place orders by having a natural conversation and using functions to manage their cart.

THE MENU:
PIZZAS:
${data.menu.pizzas.map(p => `- ${p.name}: $${p.price} - ${p.description}`).join('\n')}

SIDES:
${data.menu.sides.map(s => `- ${s.name}: $${s.price} - ${s.description}`).join('\n')}

DRINKS:
${data.menu.drinks.map(d => `- ${d.name}: $${d.price} - ${d.description}`).join('\n')}

DESSERTS:
${data.menu.desserts.map(d => `- ${d.name}: $${d.price} - ${d.description}`).join('\n')}

CUSTOMIZATION OPTIONS:
Crusts: ${data.customizations.crusts.join(', ')}
Sizes: ${data.customizations.sizes.map(s => s.name).join(', ')}
Toppings: ${data.customizations.toppings.map(t => t.name).join(', ')}

SPECIAL DEALS:
${data.deals ? data.deals.map(d => `- ${d.name}: $${d.price} - ${d.description} ${d.savings}`).join('\n') : 'No special deals available'}

RESTAURANT HOURS:
${Object.entries(data.hours).map(([day, hours]) => `${day}: ${hours.open} - ${hours.close}`).join('\n')}

DELIVERY INFORMATION:
Minimum Order: $${data.delivery.minimum}
Delivery Fee: $${data.delivery.fee}
Estimated Time: ${data.delivery.estimatedTime}
Delivery Radius: ${data.delivery.radiusInMiles} miles

INSTRUCTIONS FOR CART MANAGEMENT:
1. When a customer wants to add an item to their cart, use the add_to_cart function.
2. When a customer wants to modify an item, use the modify_cart_item function.
3. When a customer wants to remove an item, use the remove_from_cart function.
4. When a customer wants to clear their entire cart, use the clear_cart function.
5. When a customer wants to check what's in their cart, use the get_cart_contents function.
6. When a customer is ready to check out, use the checkout function.
7. If a customer's order qualifies for a special deal, use the suggest_deal function.
8. When the customer shares their phone number use the update_customer_phone_number function.
9. When the customer shares their address use the update_customer_address function.
10. When the customer shares their name use the update_customer_name function.

IMPORTANT CONVERSATIONAL GUIDELINES:
1. Be friendly, helpful, and conversational.
2. Ask clarifying questions when needed (e.g., "What size would you like?" or "Would you like any toppings on that?").
3. Confirm orders before adding them to the cart.
4. Suggest complementary items (e.g., suggest drinks when ordering pizza).
5. When using functions, maintain a natural conversation flow.
6. Always acknowledge function results in your responses (e.g., "I've added that to your cart").
7. If a customer interrupts you, stop talking and listen to their request.
8. do not return the text in markdown format. as the speech tries to read the markdown.
9. return phone numbers in the format of 1234567890.
10. always ask customer for delivery or pickup and in case of delivery always ask for customer name, address and phone number before check out and ask address only if its a delivery order.
11. When you have all the information for checkout, call the checkout function and provide the customer with a summary of their order, including the total cost and estimated delivery time.

Remember that you are representing ${data.name}, so maintain a professional and welcoming tone throughout the conversation.`;

    return instructions;
}

module.exports = {
    configureDeepgramAgent,
    createRestaurantInstructions
};