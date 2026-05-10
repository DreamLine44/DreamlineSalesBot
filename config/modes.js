/**
 * config/modes.js — Dreamline Sales Bot v3.1
 *
 * BUSINESS MODES — each a complete pre-packaged config bundle.
 * A business owner picks a mode; everything (flows, labels, UI) is pre-configured.
 *
 * v3.1 SALES ASSISTANT improvements:
 * - Upsell config per mode: addOns list + buildUpsellMessage label
 * - Payment labels: short, clear, action-driven (no long paragraphs)
 * - cancelMsg redirects back to action buttons (not dead-end)
 * - fallback / loopFallback ask ONE question, not a menu dump
 * - "Type *0* to return" hint in all dead-end messages
 * - RETAIL: trackBtn removed (not a revenue action)
 *
 * Modes: RESTAURANT | SALON | RETAIL
 *
 * v3.0 improvements preserved:
 * - getModeRestrictionMessage() for polite mode-blocking
 * - getLabel() handles string and function labels uniformly
 * - Legacy mode key mapping (BOTH→RESTAURANT, ORDER→RETAIL, BOOKING→SALON)
 */

export const MODES = {

  // ─────────────────────────────────────────────────────────────────────────
  // RESTAURANT — order food + book a table + FAQ
  // ─────────────────────────────────────────────────────────────────────────
  RESTAURANT: {
    flows: ['ORDER', 'BOOKING', 'INQUIRY'],

    intentMap: {
      ORDER:   'START_ORDER',
      BOOKING: 'START_BOOKING',
      INQUIRY: 'ABOUT',
      UNKNOWN: 'FALLBACK',
    },

    tone: { style: 'FRIENDLY', industry: 'RESTAURANT' },

    // [SA-M1] Add-ons for upsell suggestions (one shown after order summary)
    addOns: [
      { name: 'Soft Drink', price: 50 },
      { name: 'Bottled Water', price: 30 },
      { name: 'Extra Sauce', price: 25 },
    ],

    labels: {
      welcome:       '👋 Welcome! What would you like to do today?',
      orderBtn:      '🍔 Order Food',
      bookBtn:       '📅 Book a Table',
      orderPrompt:   "Here's our menu — choose an item:",
      bookPrompt:    'What date would you like to book? 📅',
      // [SA-M4] servicePrompt shown at SELECT_SERVICE step in RESTAURANT mode
      servicePrompt: 'Please choose a table type or service:',
      timePrompt:    'What time works for you? ⏰',

      confirmOrder: (item, qty, price) =>
        `🧾 *Order Summary*\n\n🍽️ *${item}* × ${qty}` +
        (price ? `\n💰 Total: *D${price}*` : ''),

      // [SA-M4] Updated to accept (service, date, time) — service is first arg when present
      confirmBooking: (serviceOrDate, dateOrTime, timeOrUndefined) => {
        // Detect call signature: 3 truthy args = (service, date, time), else (date, time)
        const hasService = timeOrUndefined !== undefined;
        const service = hasService ? serviceOrDate : null;
        const date    = hasService ? dateOrTime    : serviceOrDate;
        const time    = hasService ? timeOrUndefined : dateOrTime;
        return (
          `📋 *Booking Summary*\n\n` +
          (service ? `🍽️ *${service}*\n` : '') +
          `📅 *${date}*` +
          (time ? `\n⏰ *${time}*` : '')
        );
      },

      orderSuccess: (item, qty) =>
        `✅ *Order placed!*\n\n🍳 *${qty}× ${item}* — we're preparing it now.\n\nThank you! 😊`,

      bookingSuccess: (date, time) =>
        `✅ *Booking confirmed!*\n\n📅 *${date}*` +
        (time ? `\n⏰ *${time}*` : '') +
        '\n\nWe look forward to seeing you!',

      // [SA-M2] Payment instructions: short, clear, action-driven
      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\n` +
        `Total: *D${amount}*\n` +
        `Send via *Wave* to: *${wavePhone}*\n\n` +
        `After paying, send your *screenshot* here.`,

      paymentProofReceived:
        `✅ *Payment proof received.*\n\n⏳ We're verifying your payment — this usually takes a few minutes.`,

      paymentConfirmed:
        `✅ *Payment confirmed!*\n\nYour order is now being processed. Thank you! 🙏`,

      paymentRejected:
        `❌ *Payment could not be verified.*\n\nPlease check the amount and Wave number, then try again.\nOr type *Order* to start a new order.`,

      // [SA-M3] Cancel message redirects to action — no dead ends
      cancelMsg:    '✅ Cancelled. Type *Order* to order food, or *Book* to reserve a table.',
      fallback:     "What would you like to do — *order*, *book*, or ask a *question*?",
      loopFallback: "Let me help you get started:",

      // [SA-B2] Upsell prompt shown ONCE after order summary
      upsellPrompt: (addOnName, addOnPrice) =>
        `Would you like to add a *${addOnName}* for D${addOnPrice}? 🥤`,
    },

    ui: {
      welcomeButtons: [
        { id: 'ORDER',    title: '🍔 Order Food' },
        { id: 'BOOK',     title: '📅 Book a Table' },
        { id: 'QUESTION', title: '❓ Ask a Question' },
      ],
      confirmButtons: [
        { id: 'CONFIRM', title: '✅ Confirm' },
        { id: 'CANCEL',  title: '❌ Cancel' },
      ],
      switchButtons: [
        { id: 'SWITCH_YES', title: '✅ Yes, switch' },
        { id: 'SWITCH_NO',  title: '❌ No, continue' },
      ],
      fallbackButtons: [
        { id: 'ORDER',    title: '🍔 Order' },
        { id: 'BOOK',     title: '📅 Book' },
        { id: 'QUESTION', title: '❓ Question' },
      ],
      upsellButtons: [
        { id: 'UPSELL_YES', title: '✅ Yes, add it' },
        { id: 'UPSELL_NO',  title: '❌ No thanks' },
      ],
    },

    orderSteps:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    // [SA-M4] SELECT_SERVICE added as first booking step so RESTAURANT mode
    //         shows available table types/services before asking for date/time.
    //         Matches spec: "Show available services → Let user choose → Ask date/time"
    bookingSteps: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SALON — appointment booking + FAQ (service → date → time)
  // ─────────────────────────────────────────────────────────────────────────
  SALON: {
    flows: ['BOOKING', 'INQUIRY'],

    intentMap: {
      BOOKING: 'START_BOOKING',
      INQUIRY: 'ABOUT',
      UNKNOWN: 'FALLBACK',
    },

    tone: { style: 'PROFESSIONAL', industry: 'SALON' },

    addOns: [], // No product upsells for salon

    labels: {
      welcome:       '👋 Welcome! How can we help you today?',
      bookBtn:       '💇 Book Appointment',
      contactBtn:    '📞 Contact Us',
      orderPrompt:   null,
      bookPrompt:    'Which service would you like to book?',
      servicePrompt: 'Please choose a service:',
      timePrompt:    'What time works best for you? ⏰',

      confirmBooking: (service, date, time) =>
        `📋 *Appointment Summary*\n\n💅 *${service}*\n📅 *${date}*` +
        (time ? `\n⏰ *${time}*` : ''),

      bookingSuccess: (service, date, time) =>
        `✅ *Appointment confirmed!*\n\n💅 *${service}*\n📅 *${date}*` +
        (time ? `\n⏰ *${time}*` : '') +
        '\n\nSee you then! ✨',

      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\nTotal: *D${amount}*\nWave to: *${wavePhone}*\n\nSend your screenshot here after paying.`,

      paymentProofReceived:
        `✅ *Screenshot received.*\n\n⏳ We're verifying your payment — we'll confirm shortly.`,

      paymentConfirmed:
        `✅ *Payment confirmed!* Your appointment is booked. See you soon! 💇`,

      paymentRejected:
        `❌ *Payment could not be verified.*\n\nPlease check the amount and try again, or contact us directly.`,

      cancelMsg:    '✅ Cancelled. Type *Book* whenever you\'re ready.',
      fallback:     'Would you like to *book an appointment*?',
      loopFallback: 'Let me help you schedule your appointment:',

      upsellPrompt: null, // Disabled for salon
    },

    ui: {
      welcomeButtons: [
        { id: 'BOOK',     title: '💇 Book Appointment' },
        { id: 'QUESTION', title: '❓ Ask a Question' },
      ],
      confirmButtons: [
        { id: 'CONFIRM', title: '✅ Confirm' },
        { id: 'CANCEL',  title: '❌ Cancel' },
      ],
      switchButtons: [
        { id: 'SWITCH_YES', title: '✅ Yes, switch' },
        { id: 'SWITCH_NO',  title: '❌ No, continue' },
      ],
      fallbackButtons: [
        { id: 'BOOK',     title: '💇 Book Appointment' },
        { id: 'QUESTION', title: '❓ Question' },
      ],
      upsellButtons: [], // Disabled for salon
    },

    orderSteps:   [],
    bookingSteps: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // RETAIL — browse & order products + FAQ (no table booking)
  // ─────────────────────────────────────────────────────────────────────────
  RETAIL: {
    flows: ['ORDER', 'INQUIRY'],

    intentMap: {
      ORDER:   'START_ORDER',
      INQUIRY: 'ABOUT',
      UNKNOWN: 'FALLBACK',
    },

    tone: { style: 'PROFESSIONAL', industry: 'RETAIL' },

    addOns: [], // Upsell via product list, not add-ons

    labels: {
      welcome:       '👋 Welcome! What would you like to do?',
      orderBtn:      '🛍️ View Products',
      orderPrompt:   'Here are our products — choose one:',
      bookPrompt:    null,
      servicePrompt: null,
      timePrompt:    null,

      confirmOrder: (item, qty, price) =>
        `🧾 *Order Summary*\n\n📦 *${item}* × ${qty}` +
        (price ? `\n💰 Total: *D${price}*` : ''),

      orderSuccess: (item, qty) =>
        `✅ *Order received!*\n\n📦 *${qty}× ${item}*\n\nWe'll process your order shortly. Thank you! 🙏`,

      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\nTotal: *D${amount}*\nWave to: *${wavePhone}*\n\nSend your payment screenshot here.`,

      paymentProofReceived:
        `✅ *Payment proof received.*\n\n⏳ We're verifying — this usually takes a few minutes.`,

      paymentConfirmed:
        `✅ *Payment confirmed!* Your order is being processed. Thank you!`,

      paymentRejected:
        `❌ *Payment could not be verified.*\n\nPlease check the amount and try again.\nType *Order* to start a new order.`,

      cancelMsg:    '✅ Cancelled. Type *Order* to shop again.',
      fallback:     "Would you like to *view our products*?",
      loopFallback: 'Let me show you what we have:',

      upsellPrompt: null, // Not used for retail (products are the upsell)
    },

    ui: {
      welcomeButtons: [
        { id: 'ORDER',    title: '🛍️ View Products' },
        { id: 'QUESTION', title: '❓ Ask a Question' },
      ],
      confirmButtons: [
        { id: 'CONFIRM', title: '✅ Confirm Order' },
        { id: 'CANCEL',  title: '❌ Cancel' },
      ],
      switchButtons: [
        { id: 'SWITCH_YES', title: '✅ Yes, switch' },
        { id: 'SWITCH_NO',  title: '❌ No, continue' },
      ],
      fallbackButtons: [
        { id: 'ORDER',    title: '🛍️ View Products' },
        { id: 'QUESTION', title: '❓ Question' },
      ],
      upsellButtons: [],
    },

    orderSteps:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    bookingSteps: [],
  },
};

// ─── getModeConfig ────────────────────────────────────────────────────────────

export function getModeConfig(businessOrMode) {
  const raw =
    typeof businessOrMode === 'string'
      ? businessOrMode
      : (businessOrMode?.businessMode || businessOrMode?.mode || 'RESTAURANT');

  // Legacy key mapping
  const legacyMap = { BOTH: 'RESTAURANT', ORDER: 'RETAIL', BOOKING: 'SALON' };
  const key = legacyMap[raw?.toUpperCase()] ?? raw?.toUpperCase();

  return MODES[key] ?? MODES.RESTAURANT;
}

// ─── isFlowEnabled ────────────────────────────────────────────────────────────

export function isFlowEnabled(business, flowName) {
  return getModeConfig(business).flows.includes(flowName);
}

// ─── getLabel ─────────────────────────────────────────────────────────────────
// Priority: BusinessConfig.customMessages → mode default.
// Handles string labels and function labels uniformly.

export function getLabel(business, labelKey, ...args) {
  const custom = business?.customMessages?.[labelKey];
  if (custom && typeof custom === 'string' && custom.trim()) return custom.trim();

  const label = getModeConfig(business).labels[labelKey];
  if (!label) return '';
  return typeof label === 'function' ? label(...args) : label;
}

// ─── getModeRestrictionMessage ────────────────────────────────────────────────
// Polite message when a flow is not enabled for this business mode.

export function getModeRestrictionMessage(business, flow) {
  const name = business?.name || 'this business';
  if (flow === 'ORDER') {
    return `Sorry, *${name}* doesn't accept orders through this bot.\n\nType *Book* to make an appointment instead, or type *0* to see options.`;
  }
  if (flow === 'BOOKING') {
    return `Sorry, *${name}* doesn't accept bookings through this bot.\n\nType *Order* to place an order instead, or type *0* to see options.`;
  }
  return `That option isn't available right now. Type *0* to see what I can help you with.`;
}
