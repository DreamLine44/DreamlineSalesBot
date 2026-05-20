/**
 * modules/restaurant/configs/index.js
 * Restaurant module — default config blueprint
 */

export const RESTAURANT_CONFIG = {
  businessMode: 'RESTAURANT',
  flows:        ['ORDER', 'BOOKING'],
  persona:      'friendly restaurant host who knows every dish and loves recommending the best pairings',

  steps: {
    ORDER:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    BOOKING: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },

  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: '🍔 Order Food'   },
      { id: 'BOOK',     title: '📅 Book a Table' },
      { id: 'QUESTION', title: '❓ Ask a Question'},
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '🍔 Order'    },
      { id: 'BOOK',     title: '📅 Book'     },
      { id: 'QUESTION', title: '❓ Question' },
    ],
    confirmButtons: [
      { id: 'CONFIRM', title: '✅ Confirm' },
      { id: 'CANCEL',  title: '❌ Cancel'  },
    ],
    upsellButtons: [
      { id: 'UPSELL_YES', title: '✅ Yes, add it' },
      { id: 'UPSELL_NO',  title: '❌ No thanks'   },
    ],
  },

  addOns: [
    { name: 'Soft Drink',    price: 50 },
    { name: 'Bottled Water', price: 30 },
    { name: 'Extra Sauce',   price: 25 },
    { name: 'Dessert',       price: 75 },
  ],

  messages: {
    welcome:         '👋 Welcome! What would you like to do today?',
    orderPrompt:     "Here's our menu — choose an item:",
    bookPrompt:      'What date would you like to book? 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)',
    servicePrompt:   'Please choose a table type or service:',
    timePrompt:      'What time works for you? ⏰',
    cancelMsg:       '✅ No problem! Type *Order* to order food, *Book* to reserve a table.',
    fallback:        'Would you like to *order*, *book*, or ask a *question*?',
  },
};
