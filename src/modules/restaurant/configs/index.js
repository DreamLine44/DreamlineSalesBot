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
    // [RESTORE-LISTNAV-1] Restored per explicit request: the welcome screen
    // must render as the single "Choose an option ▼" interactive list, not
    // the 3-button + "⋯ More" set. buildWelcomeSequence() (moduleRouter.js)
    // checks cfg.ui.welcomeList FIRST and, when present, returns ONE merged
    // list message (greeting + prompt in the body, rows below) instead of
    // the [text, buttons] two-message array — this branch was already fully
    // built and wired (dormant, not deleted) from before the prior
    // AUDIT-FIX-WELCOMELIST-REMOVE pass, so restoring it here is the only
    // change needed. Row ids (ORDER/BOOK/BROWSE_CATALOG/QUESTION) are the
    // SAME ids welcomeButtons/moreMenuButtons already used, so every
    // downstream case in moduleRouter.js (case 'BROWSE_CATALOG', 'QUESTION',
    // ACTION_REGISTRY 'START_ORDER'/'START_BOOKING', etc.) keeps working
    // completely unchanged — only the outbound message SHAPE changes.
    welcomeList: {
      button: 'Choose an option',
      rows: [
        { id: 'ORDER',           title: '🍔 Order Food',      description: 'Browse the menu and place an order' },
        { id: 'BOOK',            title: '📅 Book a Table',    description: 'Reserve a table for your visit'      },
        { id: 'BROWSE_CATALOG',  title: '🛍 Browse Catalog',  description: 'View our full product catalog'      },
        { id: 'QUESTION',        title: '❓ Ask a Question',  description: 'Get a quick answer'                  },
      ],
    },
    // [NAV-META3] Meta-compliant main navigation: 3 primary buttons, with
    // "⋯ More" opening a secondary screen (moreMenuButtons below) rather than
    // overflowing past Meta's 3-reply-button limit. See moduleRouter.js cases
    // 'MORE_MENU' / 'MAIN_MENU' / 'BROWSE_CATALOG'.
    // NOTE: with welcomeList restored above, GREET/MAIN_MENU no longer send
    // this 3-button set as the primary welcome — they send the single list
    // instead. welcomeButtons/moreMenuButtons are kept for two reasons: (1)
    // the shared button set is reused by many OTHER replies throughout the
    // codebase (post-order-confirmation "what next?", About, Cancel-All,
    // payment confirmations, lead capture, etc. — see moduleRouter.js,
    // postFlowHandler.js, adminCommandService.js), and (2) MORE_MENU/
    // MAIN_MENU stay wired as a harmless backward-compat path for any "⋯
    // More" button a customer may already have open from before this
    // restore.
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
