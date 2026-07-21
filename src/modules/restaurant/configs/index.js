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
      { id: 'ORDER',    title: '🍔 Order Food'    },
      { id: 'BOOK',     title: '📅 Book a Table'  },
      { id: 'QUESTION', title: '❓ Ask a Question' },
    ],
    // [FIX-WELCOME-LIST] Full 4-option welcome menu, always rendered as a
    // WhatsApp interactive *list* (header + per-row description), never the
    // 3-button chip UI — a 4th chip would silently vanish (dispatcher.js
    // hard-caps 'buttons' at 3). Used by moduleRouter.js's GREET/SHOW_MENU
    // cases instead of welcomeButtons. "🛍️ Browse Catalog" is shown here
    // unconditionally — it's a real, always-visible menu option even for
    // tenants who haven't configured the WA Commerce Catalog backend yet;
    // tapping it falls back gracefully to the normal ordering flow in that
    // case (see catalog/waCatalogFlow.js#browseCatalogExplicit).
    welcomeList: [
      { id: 'ORDER',          title: '🍔 Order Food',      description: 'Browse our menu & place an order' },
      { id: 'BOOK',           title: '📅 Book a Table',    description: 'Reserve a table in advance'        },
      { id: 'BROWSE_CATALOG', title: '🛍️ Browse Catalog',  description: 'Shop our products & collections'   },
      { id: 'QUESTION',       title: '❓ Ask a Question',  description: 'Get help from our team'            },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '🍔 Order Food'    },
      { id: 'BOOK',     title: '📅 Book a Table'  },
      { id: 'QUESTION', title: '❓ Ask a Question' },
    ],
    confirmButtons: [
      { id: 'CONFIRM', title: '✅ Confirm'   },
      { id: 'CANCEL',  title: '❌ Cancel'    },
    ],
    upsellButtons: [
      { id: 'UPSELL_YES', title: '✅ Yes please' },
      { id: 'UPSELL_NO',  title: '❌ No thanks'  },
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
    cancelMsg:       '✅ No problem! What would you like to do next?',
    fallback:        'I can help you order food, book a table, or answer questions.',
    afterOrder:      '✅ Your order is placed! We\'ll get it ready for you.',
    afterBooking:    '✅ Booking confirmed! We look forward to seeing you.',
  },
};
