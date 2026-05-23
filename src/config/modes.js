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
