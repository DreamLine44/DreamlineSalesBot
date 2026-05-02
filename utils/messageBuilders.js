/**
 * utils/messageBuilders.js — WhatsBotLyn v3.1
 *
 * LAYER 3 — DELIVERY STRUCTURE ONLY.
 * Builds WhatsApp-ready UI objects. NEVER imports messageService.
 * NEVER calls sendMessage. NEVER contains business logic.
 *
 * Every builder returns one of:
 *   { type: 'text',    body: string }
 *   { type: 'buttons', body: string, buttons: [{id, title}] }
 *   { type: 'list',    header, body, buttonLabel, rows: [{id, title, description?}] }
 *
 * v3.1 SALES ASSISTANT additions:
 * [SA-MB1] buildUpsellUI: one-shot add-on suggestion with UPSELL_YES / UPSELL_NO buttons.
 *          Only shown once per session (flowService tracks upsellSent).
 * [SA-MB2] buildPaymentInstructionsUI: structured payment message with total, Wave number,
 *          and screenshot instruction — matches spec exactly.
 * [SA-MB3] buildPaymentProofReceivedUI / buildPaymentConfirmedUI / buildPaymentRejectedUI:
 *          three distinct payment status messages from modes labels.
 * [SA-MB4] buildClarificationUI: plain text question for unknown intents (not a menu dump).
 * [SA-MB5] buildWelcomeUI: single-button mode → text fallback (WhatsApp requires ≥2 buttons).
 *
 * v3.0 improvements preserved:
 * - buildSmartFallbackUI: mode-appropriate action buttons, never dead-end text
 * - buildLoopFallbackUI: friendly loop recovery
 * - buildServicesUI: salon service list
 * - All builders use getLabel() — zero hardcoded business strings
 */

import { getModeConfig, getLabel } from '../config/modes.js';

// ─── Internal helpers ─────────────────────────────────────────────────────────

const clean = (text) => String(text || '').replace(/\n{3,}/g, '\n\n').trim();
const formatPrice = (price) => (price != null && price > 0 ? ` (D${price})` : '');

// ─── WELCOME ──────────────────────────────────────────────────────────────────

/**
 * buildWelcomeUI(business)
 * [SA-MB5] Single-button modes fall back to text (WhatsApp requires ≥2 for buttons).
 */
export function buildWelcomeUI(business) {
  const cfg     = getModeConfig(business);
  const body    = getLabel(business, 'welcomeMessage') || getLabel(business, 'welcome') || '👋 Welcome! How can we help?';
  const buttons = cfg.ui.welcomeButtons;

  if (buttons.length === 1) {
    return {
      type: 'text',
      body: clean(
        `${body}\n\nTap *${buttons[0].id}* to get started.\n\nType *0* anytime to return here.`,
      ),
    };
  }

  return { type: 'buttons', body: clean(body), buttons };
}

// Backward-compat alias
export const buildWelcome = (business) => buildWelcomeUI(business).body;

// ─── MENU / PRODUCT LIST ──────────────────────────────────────────────────────

export function buildMenuUI(business) {
  const allItems = Array.isArray(business?.menu) ? business.menu : [];
  const items    = allItems.filter((i) => i.available !== false);
  const name     = business?.name || 'Our Menu';
  const prompt   = getLabel(business, 'orderPrompt') || "Here's what's available:";

  if (!items.length) {
    return {
      type: 'text',
      body: clean(`🍽️ *${name}*\n\nOur menu is currently being updated. Please check back soon!\n\nType *0* to return.`),
    };
  }

  const rows = items.slice(0, 10).map((item, i) => ({
    id:          String(i + 1),
    title:       String(item.name).slice(0, 24),
    description: item.price > 0 ? `D${item.price}` : (item.description?.slice(0, 72) || undefined),
  }));

  return {
    type:        'list',
    header:      `🍽️ ${name}`,
    body:        clean(prompt),
    buttonLabel: 'View Menu',
    rows,
  };
}

export const buildMenu = (business) => {
  const allItems = Array.isArray(business?.menu) ? business.menu : [];
  const items    = allItems.filter((i) => i.available !== false);
  const name     = business?.name || 'Our Menu';
  if (!items.length) return `🍽️ *${name}*\n\nMenu is being updated.`;
  const list = items.map((item, i) => `${i + 1}. ${item.name}${formatPrice(item.price)}`).join('\n');
  return clean(`🍽️ *${name}*\n\nHere's what's available:\n\n${list}\n\nReply with the item *number* or *name*.`);
};

// ─── SERVICES LIST (Salon) ────────────────────────────────────────────────────

export function buildServicesUI(business) {
  const allServices  = Array.isArray(business?.services) ? business.services : [];
  const services     = allServices.filter((s) => s.available !== false);
  const cfg          = getModeConfig(business);
  // isRestaurant = business has BOTH ORDER and BOOKING flows (table booking for restaurant)
  // Pure salon/service-only business only has BOOKING
  const isRestaurant = cfg.flows.includes('ORDER') && cfg.flows.includes('BOOKING');

  // Mode-aware defaults so a restaurant table-booking list doesn't show salon emoji/copy
  const headerEmoji = isRestaurant ? '🍽️' : '💅';
  const defaultName = business?.name || (isRestaurant ? 'Our Restaurant' : 'Our Salon');
  // [FIX-1] When services array is empty, show a meaningful fallback with contact info
  // instead of the stale "Booking options are being updated" placeholder message.
  const contactHint = business?.adminPhone
    ? `Please contact us directly at *${business.adminPhone}* to book.`
    : 'Please contact us directly to book.';
  const emptyMsg = getLabel(business, 'noServicesMessage')
    || (isRestaurant
      ? `No booking options are available right now.\n\n${contactHint}`
      : `Our services are being updated.\n\n${contactHint}`);
  const prompt      = getLabel(business, 'servicePrompt')
    || (isRestaurant ? 'Please choose a booking type:' : 'Please choose a service:');

  if (!services.length) {
    return {
      type: 'text',
      body: clean(`${headerEmoji} *${defaultName}*\n\n${emptyMsg}`),
    };
  }

  const rows = services.slice(0, 10).map((svc, i) => ({
    id:          String(i + 1),
    title:       String(svc.name).slice(0, 24),
    description: [
      svc.duration ? `${svc.duration} min` : null,
      svc.price > 0 ? `D${svc.price}` : null,
    ].filter(Boolean).join(' · ').slice(0, 72) || undefined,
  }));

  return {
    type:        'list',
    header:      `${headerEmoji} ${defaultName}`,
    body:        clean(prompt),
    buttonLabel: isRestaurant ? 'View Options' : 'View Services',
    rows,
  };
}

// ─── CONFIRMATION ─────────────────────────────────────────────────────────────

export function buildConfirmUI(business, summaryText) {
  const cfg = getModeConfig(business);
  return {
    type:    'buttons',
    body:    clean(`${summaryText}\n\n━━━━━━━━━━━━━━━━\nIs this correct?`),
    buttons: cfg.ui.confirmButtons,
  };
}

// Backward-compat plain-text confirm
export const confirmPrompt = (text) =>
  clean(`${text}\n\n━━━━━━━━━━━━━━━━\nIs this correct?\n\n✅ Reply *YES* to confirm\n❌ Reply *NO* to cancel`);

// ─── [SA-MB1] UPSELL UI ───────────────────────────────────────────────────────

/**
 * buildUpsellUI(business, addOnName, addOnPrice)
 * Shows ONCE after order summary — never repeated.
 * Requires ≥2 buttons so always uses button format.
 */
export function buildUpsellUI(business, addOnName, addOnPrice) {
  const cfg    = getModeConfig(business);
  const prompt = getLabel(business, 'upsellPrompt', addOnName, addOnPrice)
    || `Would you like to add a *${addOnName}* for D${addOnPrice}?`;

  const buttons = cfg.ui.upsellButtons;
  if (!buttons || buttons.length < 2) {
    // Fallback: text only (shouldn't happen in normal config)
    return {
      type: 'text',
      body: clean(`${prompt}\n\nReply *YES* to add, or *NO* to skip.`),
    };
  }

  return {
    type:    'buttons',
    body:    clean(prompt),
    buttons: buttons.slice(0, 2),
  };
}

// ─── [SA-MB2] PAYMENT INSTRUCTIONS UI ────────────────────────────────────────

/**
 * buildPaymentInstructionsUI(business, amount, orderId)
 * Short, clear, action-driven. Matches the spec exactly:
 *   Total: D300
 *   Send via Wave to: 7XXXXXXX
 *   After payment, upload your screenshot here.
 */
export function buildPaymentInstructionsUI(business, amount, orderId = null) {
  const wavePhone = business?.wavePhone?.trim() ||
                    business?.payment?.wavePhone?.trim() ||
                    'N/A';
  // [FIX-CUR] Use 'GMD' as fallback to match paymentService.buildPaymentInstructions.
  // Previously used 'D' which produced "D150" instead of "GMD 150".
  const currency  = business?.payment?.currency || 'GMD';
  const idLine    = orderId ? `\nRef: *#${orderId}*` : '';

  // Try custom label first, then build structured message
  const custom = getLabel(business, 'paymentInstructions', amount, wavePhone);
  if (custom) return { type: 'text', body: clean(custom) };

  const totalLine = (amount != null && amount > 0)
    ? `Total: *${currency}${amount}*\n`
    : '';

  return {
    type: 'text',
    body: clean(
      `💳 *Payment*\n\n` +
      totalLine +
      `Send via *Wave* to: *${wavePhone}*${idLine}\n\n` +
      `After paying, *send your screenshot* here.\n` +
      `We'll verify and confirm your order. ✅`,
    ),
  };
}

// ─── [SA-MB3] PAYMENT STATUS MESSAGES ────────────────────────────────────────

export function buildPaymentProofReceivedUI(business) {
  const msg = getLabel(business, 'paymentProofReceived') ||
    `✅ *Payment proof received.*\n\n⏳ We're verifying your payment — this usually takes a few minutes.`;
  return { type: 'text', body: clean(msg) };
}

export function buildPaymentConfirmedUI(business) {
  const msg = getLabel(business, 'paymentConfirmed') ||
    `✅ *Payment confirmed!*\n\nYour order is now being processed. Thank you! 🙏`;
  return { type: 'text', body: clean(msg) };
}

export function buildPaymentRejectedUI(business, reason = null) {
  const base = getLabel(business, 'paymentRejected') ||
    `❌ *Payment could not be verified.*\n\nPlease check the amount and Wave number, then try again.`;
  const extra = reason ? `\n\nReason: ${reason}` : '';
  return { type: 'text', body: clean(base + extra) };
}

// ─── [SA-MB4] CLARIFICATION UI ───────────────────────────────────────────────

/**
 * buildClarificationUI(business)
 * [SA-MB4] One focused question when intent is unknown.
 * Never dumps the full menu. Mode-aware.
 */
export function buildClarificationUI(business) {
  const cfg      = getModeConfig(business);
  const canOrder = cfg.flows.includes('ORDER');
  const canBook  = cfg.flows.includes('BOOKING');

  let question;
  if (canOrder && canBook) question = "What would you like to do — *order*, *book*, or ask a *question*?";
  else if (canOrder)       question = "Would you like to place an order?";
  else if (canBook)        question = "Would you like to book an appointment?";
  else                     question = "How can I help you? Type *0* to see options.";

  // Use buttons if we have ≥2 options
  const buttons = cfg.ui.fallbackButtons;
  if (buttons && buttons.length >= 2) {
    return { type: 'buttons', body: clean(question), buttons: buttons.slice(0, 3) };
  }

  return { type: 'text', body: clean(question) };
}

// ─── SMART FALLBACK UI ────────────────────────────────────────────────────────

/**
 * buildSmartFallbackUI(business)
 * Shows mode-appropriate buttons. NEVER a dead-end "I don't understand" message.
 */
export function buildSmartFallbackUI(business) {
  const cfg          = getModeConfig(business);
  const fallbackText = getLabel(business, 'fallback') || "What would you like to do?";
  const buttons      = cfg.ui.fallbackButtons;

  if (!buttons || buttons.length < 2) {
    const singleBtn = buttons?.[0];
    const hint = singleBtn ? `\n\nType *${singleBtn.id}* to get started.` : '\n\nType *0* to see options.';
    return { type: 'text', body: clean(fallbackText + hint) };
  }

  return { type: 'buttons', body: clean(fallbackText), buttons: buttons.slice(0, 3) };
}

// Backward-compat alias
export function buildFallbackUI(business) {
  return buildSmartFallbackUI(business);
}

// ─── LOOP FALLBACK UI ─────────────────────────────────────────────────────────

export function buildLoopFallbackUI(business) {
  const cfg      = getModeConfig(business);
  const loopText = getLabel(business, 'loopFallback') || "Let me show you what I can do:";
  const buttons  = cfg.ui.welcomeButtons;

  if (buttons.length < 2) {
    const hint = buttons[0] ? `\n\nType *${buttons[0].id}* to get started.` : '\n\nType *0* to see options.';
    return { type: 'text', body: clean(loopText + hint) };
  }

  return { type: 'buttons', body: clean(loopText), buttons: buttons.slice(0, 3) };
}

// ─── INTERRUPT (flow switch prompt) ──────────────────────────────────────────

export function buildInterruptUI(business, currentFlow, newFlow) {
  const cfg     = getModeConfig(business);
  const current = currentFlow === 'ORDER' ? 'ordering' : 'booking';
  const next    = newFlow    === 'ORDER' ? 'place an order' : 'make a booking';
  return {
    type:    'buttons',
    body:    clean(`You're in the middle of ${current}.\n\nSwitch and ${next} instead?`),
    buttons: cfg.ui.switchButtons,
  };
}

export const interruptPrompt = (currentFlow, newFlow) => {
  const current = currentFlow === 'ORDER' ? 'ordering' : 'booking';
  const next    = newFlow    === 'ORDER' ? 'place an order' : 'make a booking';
  return clean(
    `You're in the middle of ${current}.\n\nSwitch and ${next} instead?\n\n` +
    `✅ Reply *YES* to switch\n❌ Reply *NO* to continue`,
  );
};

// ─── SUCCESS MESSAGES ─────────────────────────────────────────────────────────

export function buildOrderSuccessUI(business, item, quantity) {
  const base   = getLabel(business, 'orderSuccess', item, quantity)
                 || `✅ Order confirmed!\n\n${quantity > 1 ? `${quantity}× ` : ''}*${item}* — we're on it! 🍳`;
  const custom = business?.customMessages?.afterOrder?.trim();
  return { type: 'text', body: clean(custom ? `${base}\n\n${custom}` : base) };
}

export function buildBookingSuccessUI(business, date, time, service = null) {
  const base = service
    ? getLabel(business, 'bookingSuccess', service, date || service, time)
      || `✅ Appointment confirmed!\n\n💅 *${service}*${date ? `\n📅 *${date}*` : ''}${time ? `\n⏰ *${time}*` : ''}\n\nSee you soon! ✨`
    : getLabel(business, 'bookingSuccess', date, time)
      || `✅ Booking confirmed!\n\n📅 *${date}*${time ? `\n⏰ *${time}*` : ''}\n\nLooking forward to it! 😊`;
  const custom = business?.customMessages?.afterBooking?.trim();
  return { type: 'text', body: clean(custom ? `${base}\n\n${custom}` : base) };
}

// Backward-compat plain strings
export const orderSuccess   = (item, qty) => `✅ *Order confirmed!*\n\n${qty > 1 ? `${qty}× ` : ''}*${item}* — we're preparing it now.\nThank you! 😊`;
export const bookingSuccess = (date, time) => `✅ *Booking confirmed!*\n\n📅 Date: *${date}*${time ? `\n⏰ Time: *${time}*` : ''}\n\nWe look forward to seeing you!`;

// ─── CANCEL ───────────────────────────────────────────────────────────────────

export function buildCancelUI(business) {
  const msg = getLabel(business, 'cancelMsg') || '✅ Cancelled. Type *Hi* to start again.';
  return { type: 'text', body: clean(msg) };
}

export const cancelMessage = () =>
  "✅ *Cancelled*\n\nWhenever you're ready:\n• Type *Order* to place an order\n• Type *Book* to make a reservation";

export const fallback = (business) => buildSmartFallbackUI(business).body;

// ─── ADMIN ALERTS ─────────────────────────────────────────────────────────────

export const buildAdminOrderAlert = (customerPhone, item, quantity, business, totalPrice = null) => {
  const bizName   = business?.name || 'Your Business';
  const now       = new Date().toLocaleString('en-GB', { timeZone: 'UTC', hour12: true });
  const priceLine = totalPrice ? `\n💰 Total: *D${totalPrice}*` : '';
  return clean(
    `🔔 *New Order — ${bizName}*\n\n` +
    `👤 Customer: ${customerPhone}\n` +
    `🍽️ Item: *${item}* × ${quantity}${priceLine}\n` +
    `🕐 Time: ${now} (UTC)\n\n` +
    `Status: *Pending* — please prepare.`,
  );
};

export const buildAdminBookingAlert = (customerPhone, date, time, business, service = null) => {
  const bizName  = business?.name || 'Your Business';
  const timeLine = time    ? `\n⏰ Time: *${time}*`       : '';
  const svcLine  = service ? `\n💅 Service: *${service}*` : '';
  const now = new Date().toLocaleString('en-GB', { timeZone: 'UTC', hour12: true });
  return clean(
    `🔔 *New Booking — ${bizName}*\n\n` +
    `👤 Customer: ${customerPhone}\n` +
    `📅 Date: *${date}*${timeLine}${svcLine}\n` +
    `🕐 Received: ${now} (UTC)\n\n` +
    `Status: *Pending* — please confirm.`,
  );
};

// ─── MENU LIST ROWS (backward-compat for webhookController) ──────────────────

export const buildMenuListRows = (business) => {
  const allItems = Array.isArray(business?.menu) ? business.menu : [];
  const items    = allItems.filter((i) => i.available !== false);
  return items.slice(0, 10).map((item, i) => ({
    id:          String(i + 1),
    title:       String(item.name).slice(0, 24),
    description: item.price > 0 ? `D${item.price}` : undefined,
  }));
};

// ─── MISC backward-compat ─────────────────────────────────────────────────────

export const buildWelcomeButtons  = (business) => buildWelcome(business);
export const greeting              = (business) => buildWelcome(business);
export const invalidOption         = (menuLength) =>
  `That doesn't match anything.\n\nPlease reply with a valid item *name* or *number*${menuLength ? ` between 1 and ${menuLength}` : ''}.`;
