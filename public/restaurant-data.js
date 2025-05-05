window.restaurantData = {
    name: "Pixel Pizzeria",
    menu: {
        pizzas: [
            { id: "p1", name: "Margherita", price: 12.99, description: "Classic cheese pizza with tomato sauce and fresh basil", tags: ["vegetarian", "classic"] },
            { id: "p2", name: "Pepperoni", price: 14.99, description: "Cheese pizza with pepperoni slices", tags: ["popular", "meat"] },
            { id: "p3", name: "Veggie Supreme", price: 15.99, description: "Bell peppers, mushrooms, olives, onions, and tomatoes", tags: ["vegetarian", "healthy"] },
            { id: "p4", name: "Meat Lovers", price: 16.99, description: "Pepperoni, sausage, ham, and bacon", tags: ["popular", "meat"] },
            { id: "p5", name: "Hawaiian", price: 15.99, description: "Ham and pineapple", tags: ["sweet", "meat"] },
            { id: "p6", name: "BBQ Chicken", price: 16.99, description: "Grilled chicken, BBQ sauce, red onions", tags: ["specialty", "meat"] }
        ],
        sides: [
            { id: "s1", name: "Garlic Bread", price: 4.99, description: "Toasted bread with garlic butter", tags: ["vegetarian", "popular"] },
            { id: "s2", name: "Cheese Sticks", price: 6.99, description: "Mozzarella sticks with marinara sauce", tags: ["vegetarian", "appetizer"] },
            { id: "s3", name: "Buffalo Wings", price: 8.99, description: "Spicy chicken wings with blue cheese dip", tags: ["meat", "spicy"] },
            { id: "s4", name: "Caesar Salad", price: 7.99, description: "Romaine lettuce, croutons, parmesan", tags: ["healthy"] }
        ],
        drinks: [
            { id: "d1", name: "Soda", price: 2.49, description: "Cola, Diet Cola, Lemon-Lime, or Root Beer", tags: ["drink"] },
            { id: "d2", name: "Iced Tea", price: 2.49, description: "Sweet or unsweetened", tags: ["drink"] },
            { id: "d3", name: "Bottled Water", price: 1.99, description: "Purified water", tags: ["drink", "healthy"] },
            { id: "d4", name: "Craft Beer", price: 5.99, description: "Selection of local craft beers", tags: ["drink", "alcohol"] }
        ],
        desserts: [
            { id: "de1", name: "Chocolate Brownie", price: 5.99, description: "Warm chocolate brownie with vanilla ice cream", tags: ["sweet", "dessert"] },
            { id: "de2", name: "Cheesecake", price: 6.99, description: "New York style cheesecake", tags: ["sweet", "dessert"] },
            { id: "de3", name: "Cinnamon Sticks", price: 5.99, description: "Sweet pizza dough with cinnamon and icing", tags: ["sweet", "dessert"] }
        ]
    },
    customizations: {
        crusts: ["Thin", "Regular", "Deep Dish", "Gluten-Free"],
        toppings: [
            { name: "Extra Cheese", price: 1.50 },
            { name: "Pepperoni", price: 1.50 },
            { name: "Sausage", price: 1.50 },
            { name: "Mushrooms", price: 1.00 },
            { name: "Onions", price: 1.00 },
            { name: "Bell Peppers", price: 1.00 },
            { name: "Olives", price: 1.00 },
            { name: "Pineapple", price: 1.00 },
            { name: "Bacon", price: 1.50 },
            { name: "Chicken", price: 2.00 }
        ],
        sizes: [
            { name: "Small", adjustmentFactor: 0.8 },
            { name: "Medium", adjustmentFactor: 1.0 },
            { name: "Large", adjustmentFactor: 1.2 },
            { name: "X-Large", adjustmentFactor: 1.4 }
        ]
    },
    deals: [
        { 
            id: "deal1", 
            name: "Family Combo", 
            description: "Any large pizza, 2 sides, and 4 drinks", 
            price: 29.99,
            savings: "Save up to $8"
        },
        {
            id: "deal2",
            name: "Lunch Special",
            description: "Medium 2-topping pizza and a drink",
            price: 11.99,
            savings: "Save $3",
            timeRestriction: {
                start: "11:00",
                end: "15:00"
            }
        }
    ],
    upsellRules: [
        {
            trigger: "pizza",
            suggestions: [
                { type: "side", message: "Would you like to add garlic bread to your order?" },
                { type: "drink", message: "Would you like to add a drink to your pizza?" }
            ]
        },
        {
            trigger: "large pizza",
            suggestions: [
                { type: "deal", message: "For just $5 more, you can make it a Family Combo with 2 sides and 4 drinks!" }
            ]
        },
        {
            trigger: "checkout",
            suggestions: [
                { type: "dessert", message: "Would you like to add a dessert to complete your meal?" }
            ]
        }
    ],
    hours: {
        Monday: { open: "11:00", close: "22:00" },
        Tuesday: { open: "11:00", close: "22:00" },
        Wednesday: { open: "11:00", close: "22:00" },
        Thursday: { open: "11:00", close: "22:00" },
        Friday: { open: "11:00", close: "23:00" },
        Saturday: { open: "11:00", close: "23:00" },
        Sunday: { open: "12:00", close: "21:00" }
    },
    delivery: {
        minimum: 15.00,
        fee: 3.99,
        estimatedTime: "30-45 minutes",
        radiusInMiles: 5
    }
};

// Create a flattened list of all menu items for easy searching
window.restaurantData.allMenuItems = [
    ...window.restaurantData.menu.pizzas,
    ...window.restaurantData.menu.sides,
    ...window.restaurantData.menu.drinks,
    ...window.restaurantData.menu.desserts
];

// Prepare alternative names for items to improve voice recognition
window.restaurantData.menuKeywords = {
    "pepperoni": ["p2", "pepperoni pizza", "pepperoni pie"],
    "margherita": ["p1", "margarita", "cheese pizza", "plain pizza", "classic pizza"],
    "veggie": ["p3", "vegetable", "veggie supreme", "vegetarian"],
    "meat lovers": ["p4", "meatlovers", "meat lover", "meat pizza", "all meat"],
    "hawaiian": ["p5", "ham and pineapple", "pineapple pizza"],
    "bbq chicken": ["p6", "barbecue chicken", "chicken pizza", "bbq"],
    "garlic bread": ["s1", "bread", "garlic toast"],
    "cheese sticks": ["s2", "mozzarella sticks", "fried cheese", "sticks"],
    "wings": ["s3", "buffalo wings", "chicken wings", "hot wings"],
    "salad": ["s4", "caesar", "caesar salad"],
    "soda": ["d1", "soft drink", "pop", "coke", "pepsi", "sprite"],
    "tea": ["d2", "iced tea", "sweet tea"],
    "water": ["d3", "bottled water"],
    "beer": ["d4", "craft beer", "alcohol"],
    "brownie": ["de1", "chocolate brownie"],
    "cheesecake": ["de2", "cake", "new york cheesecake"],
    "cinnamon sticks": ["de3", "dessert sticks", "cinnamon"]
};