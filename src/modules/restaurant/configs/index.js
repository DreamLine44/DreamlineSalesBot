/**
 * modules/restaurant/configs/index.js
 * Restaurant module — default config blueprint
 */

export const RESTAURANT_CONFIG = {
  businessMode: 'RESTAURANT',
  flows:        ['ORDER', 'BOOKING'],
  persona:      'friendly restaurant host who knows every dish and loves recommending the best pairings',

  steps: {
    // [MULTICART-v40] Restaurant uses ITEM_ADDED (post-add prompt) → CONFIRM
    // (final cart review). Bakery/cosmetics use CART_REVIEW instead — do not
    // add CART_REVIEW here unless orderFlow.js implements that case.
    ORDER:   ['SELECT_ITEM', 'QUANTITY', 'ITEM_ADDED', 'CONFIRM'],
    BOOKING: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },

  ui: {
    // [LIST-NAV-1] Single Interactive List navigation — replaces the previous
    // 3-button + "⋯ More" submenu (NAV-META3, kept just below) as the layout
    // buildWelcomeSequence() actually sends for GREET/MAIN_MENU. One "Choose
    // an option ▼" list opens all four primary options with descriptions in
    // a single tap. Row ids are UNCHANGED from the buttons below
    // (ORDER/BOOK/BROWSE_CATALOG/QUESTION), so BUTTON_ID_MAP, ACTION_REGISTRY,
    // and every downstream flow/case handle a tap here exactly as they always
    // have — only the outbound message shape changed, not routing or logic.
    welcomeList: {
      button: 'Choose an option ▼',
      rows: [
        { id: 'ORDER',          title: '🍔 Order Food',     description: 'Browse our menu & place an order' },
        { id: 'BOOK',           title: '📅 Book a Table',   description: 'Reserve a table in advance'        },
        { id: 'BROWSE_CATALOG', title: '🛍 Browse Catalog', description: 'Shop our products & collections'   },
        { id: 'QUESTION',       title: '❓ Ask a Question', description: 'Get help from our team'            },
      ],
    },
    // [NAV-META3] Meta-compliant main navigation: 3 primary buttons, with
    // "⋯ More" opening a secondary screen (moreMenuButtons below) rather than
    // overflowing past Meta's 3-reply-button limit. See moduleRouter.js cases
    // 'MORE_MENU' / 'MAIN_MENU' / 'BROWSE_CATALOG'.
    // No longer used by buildWelcomeSequence() now that welcomeList (above)
    // takes precedence there — but kept as-is because welcomeButtons is also
    // the shared 3-button set reused by many OTHER replies throughout the
    // codebase (post-order-confirmation "what next?", About, Cancel-All,
    // payment confirmations, lead capture, etc. — see moduleRouter.js,
    // postFlowHandler.js, adminCommandService.js). Removing or resizing it
    // would ripple into all of those unrelated call sites for no reason.
    // moreMenuButtons/MORE_MENU/MAIN_MENU also stay fully wired in
    // moduleRouter.js as a harmless backward-compat path for any "⋯ More" /
    // "🏠 Main Menu" button a customer may already have open from before
    // this change shipped.
    welcomeButtons: [
      { id: 'ORDER',     title: '🍔 Order Food'   },
      { id: 'BOOK',      title: '📅 Book a Table' },
      { id: 'MORE_MENU', title: '⋯ More'          },
    ],
    // [NAV-META3] Secondary menu reached via the "⋯ More" button.
    moreMenuButtons: [
      { id: 'BROWSE_CATALOG', title: '🛍 Browse Catalog'  },
      { id: 'QUESTION',       title: '❓ Ask a Question'  },
      { id: 'MAIN_MENU',      title: '🏠 Main Menu'       },
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
    moreMenuPrompt:  'What else would you like to do?',
    cancelMsg:       '✅ No problem! What would you like to do next?',
    fallback:        'I can help you order food, book a table, or answer questions.',
    afterOrder:      '✅ Your order is placed! We\'ll get it ready for you.',
    afterBooking:    '✅ Booking confirmed! We look forward to seeing you.',
  },
};
