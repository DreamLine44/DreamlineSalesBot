/**
 * modules/electronics/configs/index.js
 *
 * Electronics module — configuration blueprint.
 *
 * Electronics bots behave fundamentally differently from food/service bots:
 *   • Customers browse by CATEGORY before picking an item
 *   • Product specs, compatibility, and warranty are first-class concerns
 *   • Customers often compare products before buying
 *   • Fulfilment has two modes: in-store pick-up vs. delivery
 *   • Questions are deeply technical — AI is the primary answer tool
 *
 * Flows:
 *   ORDER        — category → item → specs confirm → quantity → fulfilment → confirm → [payment?]
 *   SPEC_REQUEST — open AI-powered tech Q&A (no purchase)
 *   COMPARE      — side-by-side comparison of two products
 *   WARRANTY     — warranty + after-sales enquiry
 */

export const ELECTRONICS_CONFIG = {
  businessMode: 'ELECTRONICS',

  flows: ['ORDER', 'SPEC_REQUEST', 'COMPARE', 'WARRANTY'],

  persona:
    'knowledgeable electronics expert who gives accurate spec details, helps customers ' +
    'pick the right product for their needs, and explains technical concepts clearly',

  steps: {
    ORDER:   ['BROWSE_CATEGORY', 'SELECT_ITEM', 'ITEM_DETAIL', 'QUANTITY', 'FULFILMENT', 'CONFIRM'],
    COMPARE: ['SELECT_FIRST', 'SELECT_SECOND', 'SHOW_COMPARISON'],
    WARRANTY: ['WARRANTY_QUERY'],
  },

  ui: {
    welcomeButtons: [
      { id: 'ORDER',        title: '🛒 Shop Products'    },
      { id: 'SPEC_REQUEST', title: '📋 Tech Specs / Help' },
      { id: 'COMPARE',      title: '⚖️ Compare Products'  },
    ],
    fallbackButtons: [
      { id: 'ORDER',        title: '🛒 Shop'       },
      { id: 'SPEC_REQUEST', title: '📋 Tech Help'  },
      { id: 'COMPARE',      title: '⚖️ Compare'    },
    ],
    confirmButtons: [
      { id: 'CONFIRM', title: '✅ Confirm Order' },
      { id: 'CANCEL',  title: '❌ Cancel'         },
    ],
    fulfilmentButtons: [
      { id: 'PICKUP',   title: '🏪 Pick Up In-Store' },
      { id: 'DELIVERY', title: '🚚 Delivery'          },
    ],
  },

  messages: {
    welcome:
      '📱 *Welcome!* Looking for the best tech deals?\n\n' +
      'Browse our products, get expert tech advice, or compare devices.',
    orderPrompt:  '�️ Browse our products below — tap any item to see more.',
    cancelMsg:    '✅ No problem! Come back anytime — we\'re here to help. 📱',
    fallback:
      'I can help you *shop for products*, answer *tech questions*, or *compare devices*.\n\n' +
      'What would you like to do?',
    afterOrder:
      '✅ *Order received!*\n\n' +
      'Our team will verify stock and contact you with confirmation details. Thank you! 📱',
  },
};
