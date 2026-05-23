/**
 * config/modes.js — WhatSalesAgent (Merged)
 *
 * [FIX-BUG15] getLabel() now checks business.customMessages FIRST, then falls
 *             back to module config defaults. Previously customMessages was saved
 *             to the DB but getLabel() only read from module configs — owner
 *             overrides silently had no effect on any bot message.
 */

import { RESTAURANT_CONFIG } from '../modules/restaurant/configs/index.js';
import { BAKERY_CONFIG }     from '../modules/bakery/flows/index.js';
import { SALON_CONFIG, BARBERSHOP_CONFIG } from '../modules/salon/flows/index.js';
import { FASHION_CONFIG }    from '../modules/fashion/flows/index.js';
import { COSMETICS_CONFIG }  from '../modules/cosmetics/flows/index.js';
import { ELECTRONICS_CONFIG } from '../modules/electronics/flows/index.js';

const MODE_MAP = {
  RESTAURANT:  RESTAURANT_CONFIG,
  BAKERY:      BAKERY_CONFIG,
  SALON:       SALON_CONFIG,
  BARBERSHOP:  BARBERSHOP_CONFIG,
  FASHION:     FASHION_CONFIG,
  COSMETICS:   COSMETICS_CONFIG,
  ELECTRONICS: ELECTRONICS_CONFIG,
  // Aliases
  FOOD:        RESTAURANT_CONFIG,
  CAFE:        RESTAURANT_CONFIG,
  RETAIL:      RESTAURANT_CONFIG,
  SUPERMARKET: RESTAURANT_CONFIG,
  PHARMACY:    RESTAURANT_CONFIG,
  DELIVERY:    RESTAURANT_CONFIG,
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
  return MODE_MAP[mode] || RESTAURANT_CONFIG;
}

/**
 * getLabel(business, key, ...args)
 *
 * [FIX-BUG15] Checks business.customMessages FIRST (operator overrides),
 * then falls back to the module default from cfg.messages.
 *
 * Supports {0}, {1} template substitution.
 */
export function getLabel(business, key, ...args) {
  const cfg = getModeConfig(business);

  // 1. Check customMessages override (operator-defined, stored in BusinessConfig)
  const customKey = Object.keys(CUSTOM_MSG_KEY_MAP).find(k => CUSTOM_MSG_KEY_MAP[k] === key) || key;
  const customMsg = business?.customMessages?.[customKey] || business?.customMessages?.[key];

  const tmpl = (customMsg && customMsg.trim()) || cfg.messages?.[key] || null;
  if (!tmpl) return null;

  let out = tmpl;
  args.forEach((val, i) => {
    out = out.replace(new RegExp(`\\{${i}\\}`, 'g'), val ?? '');
  });
  return out;
}

export function getSupportedModes() {
  return Object.keys(MODE_MAP).filter(k =>
    !['FOOD','CAFE','RETAIL','SUPERMARKET','PHARMACY','DELIVERY'].includes(k)
  );
}
