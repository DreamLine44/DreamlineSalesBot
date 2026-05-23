/**
 * config/modes.js — WhatSalesAgent2
 *
 * [FIX] RETAIL / SUPERMARKET / PHARMACY / DELIVERY aliases previously pointed
 *       to RESTAURANT_CONFIG — giving them "🍔 Order Food" and "📅 Book a Table"
 *       welcome buttons. These modes now get their own generic config with
 *       mode-appropriate labels.
 *
 * [FIX-BUG15] getLabel() checks business.customMessages FIRST so operator
 *             overrides actually take effect.
 */

import { RESTAURANT_CONFIG } from '../modules/restaurant/configs/index.js';
import { BAKERY_CONFIG }     from '../modules/bakery/flows/index.js';
import { SALON_CONFIG, BARBERSHOP_CONFIG } from '../modules/salon/flows/index.js';
import { FASHION_CONFIG }    from '../modules/fashion/flows/index.js';
import { COSMETICS_CONFIG }  from '../modules/cosmetics/flows/index.js';
import { ELECTRONICS_CONFIG } from '../modules/electronics/flows/index.js';

// ── Generic configs for alias modes ──────────────────────────────────────────
const RETAIL_CONFIG = {
  businessMode: 'RETAIL',
  flows: ['ORDER', 'BOOKING'],
  persona: 'helpful retail assistant',
  steps: { ORDER: ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'], BOOKING: ['DATE', 'TIME', 'CONFIRM'] },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: '🛍 Shop Now'       },
      { id: 'BOOK',     title: '📅 Book a Visit'   },
      { id: 'QUESTION', title: '❓ Ask a Question'  },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '🛍 Shop'      },
      { id: 'BOOK',     title: '📅 Book'      },
      { id: 'QUESTION', title: '❓ Question'  },
    ],
    confirmButtons: [{ id: 'CONFIRM', title: '✅ Confirm' }, { id: 'CANCEL', title: '❌ Cancel' }],
    upsellButtons:  [{ id: 'UPSELL_YES', title: '✅ Yes' }, { id: 'UPSELL_NO', title: '❌ No' }],
  },
  messages: {
    welcome:   '👋 Welcome! How can we help you today?',
    cancelMsg: '✅ No problem! Tap below whenever you\'re ready.',
    fallback:  'Would you like to *shop*, *book a visit*, or ask a *question*?',
  },
};

const SUPERMARKET_CONFIG = {
  ...RETAIL_CONFIG,
  businessMode: 'SUPERMARKET',
  ui: {
    ...RETAIL_CONFIG.ui,
    welcomeButtons: [
      { id: 'ORDER',    title: '🛒 Shop Groceries' },
      { id: 'QUESTION', title: '❓ Ask a Question'  },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '🛒 Shop'     },
      { id: 'QUESTION', title: '❓ Question' },
    ],
  },
  messages: {
    welcome:   '🛒 Welcome! What would you like to order today?',
    cancelMsg: '✅ No problem! Tap below to start shopping.',
    fallback:  'Would you like to *shop* or ask a *question*?',
  },
};

const PHARMACY_CONFIG = {
  ...RETAIL_CONFIG,
  businessMode: 'PHARMACY',
  ui: {
    ...RETAIL_CONFIG.ui,
    welcomeButtons: [
      { id: 'ORDER',    title: '💊 Order Medicine'  },
      { id: 'QUESTION', title: '❓ Ask Pharmacist'   },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '💊 Order'    },
      { id: 'QUESTION', title: '❓ Question' },
    ],
  },
  messages: {
    welcome:   '💊 Welcome! How can our pharmacy assist you today?',
    cancelMsg: '✅ No problem. Tap below whenever you need us.',
    fallback:  'Would you like to *order medicine* or speak to a *pharmacist*?',
  },
};

const DELIVERY_CONFIG = {
  ...RETAIL_CONFIG,
  businessMode: 'DELIVERY',
  ui: {
    ...RETAIL_CONFIG.ui,
    welcomeButtons: [
      { id: 'ORDER',    title: '🛵 Place Delivery'  },
      { id: 'TRACK_ORDER', title: '📦 Track Order'  },
      { id: 'QUESTION', title: '❓ Ask a Question'  },
    ],
    fallbackButtons: [
      { id: 'ORDER',       title: '🛵 Order'   },
      { id: 'TRACK_ORDER', title: '📦 Track'   },
      { id: 'QUESTION',    title: '❓ Question' },
    ],
  },
  messages: {
    welcome:   '🛵 Welcome! Ready to place a delivery order?',
    cancelMsg: '✅ No problem! Tap below whenever you\'re ready.',
    fallback:  'Would you like to *place an order* or *track* a delivery?',
  },
};

const MODE_MAP = {
  RESTAURANT:  RESTAURANT_CONFIG,
  BAKERY:      BAKERY_CONFIG,
  SALON:       SALON_CONFIG,
  BARBERSHOP:  BARBERSHOP_CONFIG,
  FASHION:     FASHION_CONFIG,
  COSMETICS:   COSMETICS_CONFIG,
  ELECTRONICS: ELECTRONICS_CONFIG,
  RETAIL:      RETAIL_CONFIG,
  SUPERMARKET: SUPERMARKET_CONFIG,
  PHARMACY:    PHARMACY_CONFIG,
  DELIVERY:    DELIVERY_CONFIG,
  // Legacy aliases
  FOOD:        RESTAURANT_CONFIG,
  CAFE:        RESTAURANT_CONFIG,
};

// customMessages key → module messages key mapping
const CUSTOM_MSG_KEY_MAP = {
  welcomeMessage: 'welcome',
  afterOrder:     'afterOrder',
  afterBooking:   'afterBooking',
  cancelMsg:      'cancelMsg',
  fallback:       'fallback',
  orderPrompt:    'orderPrompt',
  bookPrompt:     'bookPrompt',
  servicePrompt:  'servicePrompt',
  timePrompt:     'timePrompt',
  closed:         'closed',
};

export function getModeConfig(business) {
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  return MODE_MAP[mode] || RETAIL_CONFIG;
}

/**
 * getLabel(business, key, ...args)
 * [FIX-BUG15] Checks business.customMessages FIRST, falls back to module default.
 */
export function getLabel(business, key, ...args) {
  const cfg       = getModeConfig(business);
  const customKey = Object.keys(CUSTOM_MSG_KEY_MAP).find(k => CUSTOM_MSG_KEY_MAP[k] === key) || key;
  const customMsg = business?.customMessages?.[customKey] || business?.customMessages?.[key];
  const tmpl      = (customMsg?.trim()) || cfg.messages?.[key] || null;
  if (!tmpl) return null;
  let out = tmpl;
  args.forEach((val, i) => { out = out.replace(new RegExp(`\\{${i}\\}`, 'g'), val ?? ''); });
  return out;
}

export function getSupportedModes() {
  return ['RESTAURANT','BAKERY','SALON','BARBERSHOP','FASHION','COSMETICS','ELECTRONICS',
          'RETAIL','SUPERMARKET','PHARMACY','DELIVERY'];
}
