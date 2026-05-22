/**
 * config/modes.js — WhatSalesAgent2
 * Returns the correct mode config for any business type.
 * All modules pull from here; never hardcode mode logic in controllers.
 *
 * FIX #24: RETAIL / SUPERMARKET / PHARMACY / DELIVERY no longer alias to
 *          RESTAURANT_CONFIG (which sent food-ordering buttons). Each now has
 *          a sensible generic config. Businesses that truly want the full
 *          restaurant flow should set businessMode = RESTAURANT explicitly.
 */

import { RESTAURANT_CONFIG } from '../modules/restaurant/configs/index.js';
import { BAKERY_CONFIG }     from '../modules/bakery/flows/index.js';
import { SALON_CONFIG, BARBERSHOP_CONFIG } from '../modules/salon/flows/index.js';
import { FASHION_CONFIG }    from '../modules/fashion/flows/index.js';
import { COSMETICS_CONFIG }  from '../modules/cosmetics/flows/index.js';
import { ELECTRONICS_CONFIG } from '../modules/electronics/flows/index.js';

// Generic retail/service config — ORDER + QUESTION, no food-specific labels
const RETAIL_CONFIG = {
  businessMode: 'RETAIL',
  flows: ['ORDER'],
  persona: 'friendly retail assistant who helps customers browse products and place orders',
  steps: { ORDER: ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'] },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: '🛒 Browse & Order' },
      { id: 'QUESTION', title: '❓ Ask a Question'  },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '🛒 Order'    },
      { id: 'QUESTION', title: '❓ Question' },
    ],
  },
  messages: {
    welcome:   '👋 Welcome! How can we help you today?',
    cancelMsg: '✅ Cancelled. Type *Order* to shop again.',
    fallback:  'Would you like to *browse our products* or ask a *question*?',
  },
};

const SUPERMARKET_CONFIG = {
  ...RETAIL_CONFIG,
  businessMode: 'SUPERMARKET',
  persona: 'helpful supermarket assistant who takes grocery orders',
  ui: {
    ...RETAIL_CONFIG.ui,
    welcomeButtons: [
      { id: 'ORDER',    title: '🛒 Place Order'    },
      { id: 'QUESTION', title: '❓ Ask a Question' },
    ],
  },
  messages: {
    ...RETAIL_CONFIG.messages,
    welcome: '👋 Welcome! What would you like to order today?',
  },
};

const PHARMACY_CONFIG = {
  ...RETAIL_CONFIG,
  businessMode: 'PHARMACY',
  persona: 'professional pharmacy assistant who helps customers find medications and health products',
  ui: {
    ...RETAIL_CONFIG.ui,
    welcomeButtons: [
      { id: 'ORDER',    title: '💊 Place Order'    },
      { id: 'QUESTION', title: '❓ Ask a Question' },
    ],
  },
  messages: {
    ...RETAIL_CONFIG.messages,
    welcome: '👋 Welcome to our pharmacy! How can we assist you today?',
  },
};

const DELIVERY_CONFIG = {
  ...RETAIL_CONFIG,
  businessMode: 'DELIVERY',
  persona: 'efficient delivery service assistant who helps customers track and place delivery orders',
  ui: {
    ...RETAIL_CONFIG.ui,
    welcomeButtons: [
      { id: 'ORDER',    title: '📦 Place Order'     },
      { id: 'TRACK_ORDER', title: '🔍 Track Order' },
      { id: 'QUESTION', title: '❓ Ask a Question'  },
    ],
  },
  messages: {
    ...RETAIL_CONFIG.messages,
    welcome: '👋 Welcome! Ready to place or track your delivery?',
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
  // Aliases — FIX #24: now have correct configs instead of restaurant food buttons
  FOOD:        RESTAURANT_CONFIG,
  CAFE:        RESTAURANT_CONFIG,
  RETAIL:      RETAIL_CONFIG,
  SUPERMARKET: SUPERMARKET_CONFIG,
  PHARMACY:    PHARMACY_CONFIG,
  DELIVERY:    DELIVERY_CONFIG,
};

export function getModeConfig(business) {
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  return MODE_MAP[mode] || RESTAURANT_CONFIG;
}

export function getLabel(business, key, ...args) {
  const cfg  = getModeConfig(business);
  const tmpl = cfg.messages?.[key] || null;
  if (!tmpl) return null;
  let out = tmpl;
  args.forEach((val, i) => {
    out = out.replace(new RegExp(`\\{${i}\\}`, 'g'), val ?? '');
  });
  return out;
}

export function getSupportedModes() {
  return Object.keys(MODE_MAP).filter(k => !['FOOD','CAFE','RETAIL','SUPERMARKET','PHARMACY','DELIVERY'].includes(k));
}
