/**
 * services/modePresetService.js — WhatsBotLyn v3.1
 *
 * BUSINESS SELF-CONFIGURATION SYSTEM
 *
 * This service makes the bot sellable to business owners with NO coding knowledge.
 * It provides:
 *
 * 1. applyModePreset(business, mode) — one-call setup for a business mode
 * 2. validateBusinessConfig(data)    — friendly validation with plain-English errors
 * 3. buildSetupChecklist(business)   — tells owners exactly what's missing
 * 4. getDefaultConfig(mode)          — returns a ready-to-use starter config
 *
 * Philosophy:
 * - Business owners interact via API (businessRoutes) or a future dashboard UI
 * - They NEVER touch code
 * - All errors are in plain English, never technical jargon
 * - Defaults are smart — a new business works out of the box
 */

import BusinessConfig from '../models/BusinessConfig.js';
import logger from '../config/logger.js';

// ─── Mode preset templates ────────────────────────────────────────────────────
// These are the starter configs injected when a business selects a mode.
// Business owners can override any field via the API.

const MODE_PRESETS = {

  RESTAURANT: {
    businessMode: 'RESTAURANT',
    tone: { style: 'FRIENDLY', industry: 'RESTAURANT' },
    settings: {
      autoSuggestions: true,
      enableLearning:  true,
      sessionTimeout:  30,
      allowAfterHoursOrders: false,
      closedMessage: "We're closed right now! Our opening hours are displayed in our profile. We'll be happy to serve you when we open 😊",
    },
    customMessages: {
      welcomeMessage:  '',  // Auto-generated from mode if blank
      afterOrder:      "Thank you for your order! We'll have it ready shortly 🍳",
      afterBooking:    "Table reserved! We look forward to seeing you 😊",
      payment:         '',
      fallback:        '',  // Smart fallback buttons auto-generated from mode
      cancelMsg:       '',
      loopFallback:    '',
    },
  },

  SALON: {
    businessMode: 'SALON',
    tone: { style: 'PROFESSIONAL', industry: 'SALON' },
    settings: {
      autoSuggestions: true,
      enableLearning:  true,
      sessionTimeout:  30,
      allowAfterHoursOrders: false,
      closedMessage: "We're currently closed. Please message us during business hours to book your appointment ✨",
    },
    customMessages: {
      welcomeMessage:  '',
      afterBooking:    "Your appointment is confirmed! We look forward to seeing you ✨",
      fallback:        '',
      cancelMsg:       '',
      loopFallback:    '',
    },
  },

  RETAIL: {
    businessMode: 'RETAIL',
    tone: { style: 'PROFESSIONAL', industry: 'RETAIL' },
    settings: {
      autoSuggestions: true,
      enableLearning:  true,
      sessionTimeout:  30,
      allowAfterHoursOrders: true,
      closedMessage: "We're currently offline. You can still place an order and we'll process it when we're back!",
    },
    customMessages: {
      welcomeMessage:  '',
      afterOrder:      "Your order has been received! We'll process it and be in touch shortly 📦",
      fallback:        '',
      cancelMsg:       '',
      loopFallback:    '',
    },
  },
};

// ─── Apply mode preset ────────────────────────────────────────────────────────

/**
 * applyModePreset(phoneNumberId, mode)
 *
 * Sets the business mode and applies smart defaults.
 * Called when a business owner selects their mode for the first time
 * or switches modes.
 *
 * Does NOT overwrite: name, adminPhone, wavePhone, menu, services, faq, hours
 * DOES set: businessMode, tone, settings defaults, customMessages defaults
 *
 * Returns: { success, message, data }
 */
export async function applyModePreset(phoneNumberId, mode) {
  const modeKey = String(mode).toUpperCase();
  const preset  = MODE_PRESETS[modeKey];

  if (!preset) {
    return {
      success: false,
      message: `Unknown mode "${mode}". Valid modes are: RESTAURANT, SALON, RETAIL.`,
    };
  }

  try {
    const business = await BusinessConfig.findOne({ phoneNumberId });
    if (!business) {
      return {
        success: false,
        message: 'Business not found. Please create a business config first.',
      };
    }

    // Merge preset — only set defaults where the business hasn't customised
    business.businessMode = preset.businessMode;
    business.tone         = preset.tone;

    // Settings: only apply defaults that aren't already set
    if (!business.settings) business.settings = {};
    business.settings = {
      ...preset.settings,
      ...business.settings,
      // Always apply these from preset (they're mode-critical):
      sessionTimeout: preset.settings.sessionTimeout,
    };

    // Custom messages: only fill in blank fields
    if (!business.customMessages) business.customMessages = {};
    for (const [key, value] of Object.entries(preset.customMessages)) {
      if (!business.customMessages[key]?.trim()) {
        business.customMessages[key] = value;
      }
    }

    await business.save();

    logger.info(`[modePresetService] Mode applied: ${modeKey} for phoneNumberId ${phoneNumberId}`);

    return {
      success: true,
      message: `✅ Mode set to ${modeKey}! Your bot is now pre-configured for a ${modeKey.toLowerCase()} business.\n\n` +
               `Next steps:\n` +
               `1. Add your ${modeKey === 'SALON' ? 'services' : 'menu items'}\n` +
               `2. Set your business hours\n` +
               `3. Set your admin phone number to receive order/booking alerts`,
      data: business,
    };

  } catch (err) {
    logger.error('[modePresetService] applyModePreset error', { err: err.message });
    return { success: false, message: 'Something went wrong. Please try again.' };
  }
}

// ─── Validate business config ─────────────────────────────────────────────────

/**
 * validateBusinessConfig(data)
 *
 * Returns plain-English validation errors — no technical jargon.
 * Designed for API responses that a non-technical business owner can understand.
 *
 * Returns: { valid: boolean, errors: string[] }
 */
export function validateBusinessConfig(data) {
  const errors = [];

  if (!data.name?.trim()) {
    errors.push('Business name is required. Please add your business name.');
  }

  if (data.businessMode && !['RESTAURANT', 'SALON', 'RETAIL'].includes(data.businessMode.toUpperCase())) {
    errors.push(`"${data.businessMode}" is not a valid business mode. Please choose: RESTAURANT, SALON, or RETAIL.`);
  }

  if (data.menu && !Array.isArray(data.menu)) {
    errors.push('Menu must be a list of items. Please check your menu format.');
  }

  if (data.menu) {
    data.menu.forEach((item, i) => {
      if (!item.name?.trim()) {
        errors.push(`Menu item ${i + 1} is missing a name. Every menu item must have a name.`);
      }
      if (item.price != null && (typeof item.price !== 'number' || item.price < 0)) {
        errors.push(`Menu item "${item.name || i + 1}" has an invalid price. Prices must be a positive number.`);
      }
    });
  }

  if (data.services) {
    data.services.forEach((svc, i) => {
      if (!svc.name?.trim()) {
        errors.push(`Service ${i + 1} is missing a name. Every service must have a name.`);
      }
      if (svc.duration != null && (typeof svc.duration !== 'number' || svc.duration < 5)) {
        errors.push(`Service "${svc.name || i + 1}" has an invalid duration. Duration must be at least 5 minutes.`);
      }
    });
  }

  if (data.hours) {
    const { open, close } = data.hours;
    if (open != null && (open < 0 || open > 23)) {
      errors.push('Opening hour must be between 0 (midnight) and 23 (11pm).');
    }
    if (close != null && (close < 0 || close > 23)) {
      errors.push('Closing hour must be between 0 (midnight) and 23 (11pm).');
    }
    if (open != null && close != null && open >= close) {
      errors.push('Opening time must be earlier than closing time.');
    }
  }

  if (data.adminPhone && !/^\d{7,15}$/.test(data.adminPhone.replace(/\s/g, ''))) {
    errors.push('Admin phone number should only contain digits (e.g. 2207000000). No spaces or dashes.');
  }

  if (data.wavePhone && !/^\d{7,15}$/.test(data.wavePhone.replace(/\s/g, ''))) {
    errors.push('Wave phone number should only contain digits (e.g. 2207000000). No spaces or dashes.');
  }

  return { valid: errors.length === 0, errors };
}

// ─── Setup checklist ─────────────────────────────────────────────────────────

/**
 * buildSetupChecklist(business)
 *
 * Returns a checklist of what's complete and what's missing.
 * Friendly for non-technical business owners.
 *
 * Returns: { complete: boolean, score: number, items: [{done, label, tip?}] }
 */
export function buildSetupChecklist(business) {
  const mode = business?.businessMode || 'RESTAURANT';

  const items = [
    {
      done:  !!business?.name?.trim() && business.name !== 'Our Business',
      label: '✅ Business name set',
      tip:   'Go to Settings → Business Name to set your business name.',
    },
    {
      done:  !!business?.adminPhone?.trim(),
      label: '✅ Admin phone number set (for order/booking alerts)',
      tip:   'Set your adminPhone so you get notified when customers order or book.',
    },
    {
      done:  mode === 'SALON'
               ? (business?.services?.length > 0)
               : (business?.menu?.length > 0),
      label: mode === 'SALON'
               ? '✅ Services added'
               : '✅ Menu items added',
      tip:   mode === 'SALON'
               ? 'Add your salon services (name, duration, price) so customers can book them.'
               : 'Add your menu items (name, price) so customers can order.',
    },
    {
      done:  !!business?.hours?.enabled,
      label: '✅ Business hours configured',
      tip:   'Set your opening hours so the bot knows when to reply and when to show a closed message.',
    },
    {
      done:  !!business?.customMessages?.welcomeMessage?.trim(),
      label: '✅ Custom welcome message set (optional)',
      tip:   'Personalise the greeting customers see when they first message you.',
    },
    {
      done:  mode !== 'SALON' ? !!business?.wavePhone?.trim() : true,
      label: mode !== 'SALON' ? '✅ Wave payment number set (optional)' : '✅ N/A for salon mode',
      tip:   mode !== 'SALON'
               ? 'Add your Wave mobile money number so customers can pay digitally.'
               : null,
    },
  ].filter(item => item.label !== '✅ N/A for salon mode' || mode === 'SALON' === false);

  const doneCount = items.filter(i => i.done).length;
  const score     = Math.round((doneCount / items.length) * 100);

  return {
    complete: score === 100,
    score,
    summary: score === 100
      ? '🎉 Your bot is fully set up and ready to go!'
      : `⚙️ Setup ${score}% complete. Complete the remaining steps to get the most out of your bot.`,
    items,
  };
}

// ─── Get default config for a mode ───────────────────────────────────────────

/**
 * getDefaultConfig(mode)
 *
 * Returns a ready-to-use starter config for a new business.
 * Use this as the body for POST /business to get started quickly.
 */
export function getDefaultConfig(mode) {
  const modeKey = String(mode || 'RESTAURANT').toUpperCase();
  const preset  = MODE_PRESETS[modeKey] || MODE_PRESETS.RESTAURANT;

  const sampleMenu = [
    { name: 'Item 1', price: 50, description: 'Describe your first item here', available: true },
    { name: 'Item 2', price: 75, description: 'Describe your second item here', available: true },
  ];

  const sampleServices = [
    { name: 'Service 1', duration: 30, price: 100, available: true },
    { name: 'Service 2', duration: 60, price: 200, available: true },
  ];

  return {
    name:         'Your Business Name',
    description:  'Tell customers what your business does in 1-2 sentences.',
    ...preset,
    adminPhone:   '',
    wavePhone:    '',
    menu:         modeKey !== 'SALON' ? sampleMenu : [],
    services:     modeKey === 'SALON' ? sampleServices : [],
    hours: {
      enabled:  true,
      timezone: 'Africa/Banjul',
      open:     8,
      close:    20,
      days:     {},
    },
    faq: [
      {
        trigger: 'where are you located',
        reply:   'We are located at [your address here]. Feel free to ask us anything!',
      },
    ],
  };
}
