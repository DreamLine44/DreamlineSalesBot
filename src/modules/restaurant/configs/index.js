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
    // [AUDIT-FIX-WELCOMELIST-REMOVE] The "Choose an option ▼" list dropdown
    // (formerly [LIST-NAV-1] here) has been removed entirely for RESTAURANT.
    // It duplicated the greeting's own question ("What would you like to do
    // today?" immediately followed by "Choose an option below to get
    // started ▼"), forced an extra tap-to-open-the-list step Meta's direct
    // reply buttons don't need, and — because buildWelcomeSequence() returns
    // a single list object for any cfg.ui.welcomeList config instead of the
    // two-element [text, buttons] array every other case expects — it was
    // silently breaking the existing 'RESTAURANT is unaffected — still
    // exactly its static 3-button Order/Book/⋯More set' regression test in
    // tests/auditFixButtonsMenuSystemic.test.mjs. Removing this config key is
    // enough: buildWelcomeSequence() (moduleRouter.js) already falls straight
    // through to the NAV-META3 3-button + "⋯More" path below whenever
    // cfg.ui.welcomeList is absent — no other file needed to change. This
    // does NOT touch VIEW_MENU: that's a fully separate action (case
    // 'VIEW_MENU' in moduleRouter.js, still starts the ORDER flow and shows
    // the real menu exactly as before) that was never part of this welcome
    // list in the first place.
    // [NAV-META3] Meta-compliant main navigation: 3 primary buttons, with
    // "⋯ More" opening a secondary screen (moreMenuButtons below) rather than
    // overflowing past Meta's 3-reply-button limit. See moduleRouter.js cases
    // 'MORE_MENU' / 'MAIN_MENU' / 'BROWSE_CATALOG'.
    // This IS what buildWelcomeSequence() sends for GREET/MAIN_MENU now that
    // welcomeList has been removed above. Also kept as the shared 3-button
    // set reused by many OTHER replies throughout the
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
