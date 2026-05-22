/**
 * config/modes.js — WhatSalesAgent2
 * Returns the correct mode config for any business type.
 * All modules pull from here; never hardcode mode logic in controllers.
 */

import { RESTAURANT_CONFIG } from '../modules/restaurant/configs/index.js';
import { BAKERY_CONFIG }     from '../modules/bakery/flows/index.js';
import { SALON_CONFIG, BARBERSHOP_CONFIG } from '../modules/salon/flows/index.js';
import { FASHION_CONFIG }    from '../modules/fashion/flows/index.js';
import { COSMETICS_CONFIG }  from '../modules/cosmetics/flows/index.js';
import { ELECTRONICS_CONFIG } from '../modules/electronics/flows/index.js';

// ── Generic retail/shop config (used by RETAIL, SUPERMARKET) ─────────────────
const RETAIL_CONFIG = {
  businessMode: 'RETAIL',
  flows: ['ORDER'],
  steps: { ORDER: ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'] },
  messages: {
    welcome:  '👋 Welcome! How can we help you today?',
    fallback: 'How can I help you?',
  },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: '🛍 Shop Now'   },
      { id: 'SHOW_MENU', title: '📋 View Items' },
      { id: 'ENQUIRY',  title: '❓ Ask a Question' },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '🛍 Shop Now'   },
      { id: 'SHOW_MENU', title: '📋 View Items' },
    ],
  },
};

// ── Pharmacy config ────────────────────────────────────────────────────────────
const PHARMACY_CONFIG = {
  businessMode: 'PHARMACY',
  flows: ['ORDER'],
  steps: { ORDER: ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'] },
  messages: {
    welcome:  '💊 Welcome to our pharmacy! How can we assist you?',
    fallback: 'How can I help you today?',
  },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: '💊 Order Medication' },
      { id: 'SHOW_MENU', title: '📋 View Products'   },
      { id: 'ENQUIRY',  title: '❓ Ask a Pharmacist' },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '💊 Order Medication' },
      { id: 'SHOW_MENU', title: '📋 View Products'   },
    ],
  },
};

// ── Supermarket config ────────────────────────────────────────────────────────
const SUPERMARKET_CONFIG = {
  businessMode: 'SUPERMARKET',
  flows: ['ORDER'],
  steps: { ORDER: ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'] },
  messages: {
    welcome:  '🛒 Welcome! What can we get for you today?',
    fallback: 'How can I help you?',
  },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: '🛒 Place Order'   },
      { id: 'SHOW_MENU', title: '📋 View Products' },
      { id: 'ENQUIRY',  title: '❓ Ask a Question' },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '🛒 Place Order'   },
      { id: 'SHOW_MENU', title: '📋 View Products' },
    ],
  },
};

// ── Delivery config ───────────────────────────────────────────────────────────
const DELIVERY_CONFIG = {
  businessMode: 'DELIVERY',
  flows: ['ORDER'],
  steps: { ORDER: ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'] },
  messages: {
    welcome:  '🚚 Welcome! What would you like delivered today?',
    fallback: 'How can I help you?',
  },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: '🛍 Order Now'      },
      { id: 'SHOW_MENU', title: '📋 View Menu'      },
      { id: 'ENQUIRY',  title: '❓ Ask a Question'  },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '🛍 Order Now'   },
      { id: 'SHOW_MENU', title: '📋 View Menu'  },
    ],
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
  // Aliases
  FOOD:        RESTAURANT_CONFIG,
  CAFE:        RESTAURANT_CONFIG,
};

export function getModeConfig(business) {
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  return MODE_MAP[mode] || RETAIL_CONFIG;
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
  return Object.keys(MODE_MAP).filter(k => !['FOOD', 'CAFE'].includes(k));
}

