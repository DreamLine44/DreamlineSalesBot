/**
 * services/flowService.js — WhatsBotLyn v3.1
 *
 * LAYER 2 — FLOW LOGIC ONLY.
 *
 * v3.1 = v3.0 UX improvements + v2.6 critical bug fixes merged:
 *
 * BUG FIXES (from v2.6):
 * loadBusiness: session.tenantId stored as String but BusinessConfig.tenantId
 *         is ObjectId in MongoDB — plain string query never matches. Cast to ObjectId.
 * handleFinalize: added null-guard on business._id (ORDER + BOOKING paths).
 *         Null business from FIX-1 failure crashes Order.create(); now returns
 *         graceful retry UI instead of unhandled TypeError.
 * CANCEL at CONFIRM step goes through flowService (not brain short-circuit).
 *         See webhookController .
 *
 * v3.0 UX improvements preserved:
 * - buildSmartFallbackUI / buildLoopFallbackUI replace dead-end text fallbacks
 * - Loop recovery shows mode-appropriate action buttons
 * - DATE_CONFIRM / TIME_CONFIRM use CONFIRM/CANCEL buttons (not typed YES/NO)
 * - SELECT_ITEM low-confidence suggestion uses buttons
 * - RETAIL mode supported via getModeConfig()
 */

import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import BusinessConfig from '../models/BusinessConfig.js';
import mongoose       from 'mongoose';

import { updateSession, clearSession }                                        from './sessionService.js';
import { trackOrderAnalytics, trackBookingAnalytics, trackFailedInteraction } from './analyticsService.js';
import { trackUser }                                                          from './learningService.js';
import { getAIReply }                                                         from './groqService.js';
import { dispatch }                                                           from './messageService.js';
import logger                                                                 from '../config/logger.js';

import {
  getModeConfig,
  getLabel,
} from '../config/modes.js';

import {
  buildMenuUI,
  buildServicesUI,
  buildWelcomeUI,
  buildConfirmUI,
  buildInterruptUI,
  buildOrderSuccessUI,
  buildBookingSuccessUI,
  buildCancelUI,
  buildSmartFallbackUI,
  buildLoopFallbackUI,
  buildUpsellUI,
  buildPaymentInstructionsUI,
  buildAdminOrderAlert,
  buildAdminBookingAlert,
} from '../utils/messageBuilders.js';

import { findBestMatch } from '../utils/matchEngine.js';
import { initiatePayment } from './paymentService.js';

// ─── Normalisation ────────────────────────────────────────────────────────────

const normalize = (text) =>
  String(text || '').toLowerCase().replace(/[^\w\s]/g, '').trim();

const getName = (item) => (typeof item === 'string' ? item : item.name);

// ─── Local intent helpers ─────────────────────────────────────────────────────

const isConfirm = (msg) =>
  ['yes', 'ok', 'okay', 'y', 'confirm', 'yep', 'sure', 'yup', 'yeah'].includes(msg);

const isReject = (msg) =>
  ['no', 'nope', 'nah', 'n'].includes(msg);

const isCancel = (msg) =>
  ['cancel', 'stop', 'exit', 'quit', 'reset'].includes(msg);

const isBtnConfirm = (raw) => raw === 'CONFIRM' || isConfirm(normalize(raw));
const isBtnCancel  = (raw) => raw === 'CANCEL'  || isCancel(normalize(raw));
const isBtnReject  = (raw) => raw === 'CANCEL'  || isReject(normalize(raw));
const isSwitchYes  = (raw) => raw === 'SWITCH_YES' || isConfirm(normalize(raw));
const isSwitchNo   = (raw) => raw === 'SWITCH_NO'  || isReject(normalize(raw));

// ─── Word-to-number ───────────────────────────────────────────────────────────

const WORD_NUMBERS = {
  one:1, two:2, three:3, four:4, five:5,
  six:6, seven:7, eight:8, nine:9, ten:10,
};

// Negation patterns that indicate the client does NOT want a quantity
// e.g. "i don't want 4", "not 4", "maybe 4", "not interested in 4", "no 4"
const NEGATION_PATTERN = /\b(don'?t|do not|not|no|nope|never|cancel|stop|skip|none|neither|nor|without|except|refuse|reject|not interested|maybe|perhaps|unsure|idk|i don'?t know)\b/i;

const parseQuantity = (raw) => {
  const trimmed = raw.trim();

  // 0. Negation guard — if the message contains a negation word/phrase,
  //    do NOT extract a number from it. Return null so the bot asks again.
  if (NEGATION_PATTERN.test(trimmed)) return null;

  // 1. Plain integer — "4", "  2 "
  const direct = parseInt(trimmed, 10);
  if (!isNaN(direct) && String(direct) === trimmed.replace(/\s/g, '')) return direct;

  // 2. Single word-number — "four", "two"
  const wordNum = WORD_NUMBERS[trimmed.toLowerCase()];
  if (wordNum !== undefined) return wordNum;

  // 3. Natural-language phrases — "I want 4", "give me 3", "just 2 please", "x2"
  // Extract the first digit sequence from anywhere in the string.
  // Match digit sequence anywhere — handles "x2", "×3", "qty:4", "I want 4"
  const phraseMatch = trimmed.match(/(?:^|[^\d])(\d+)(?:[^\d]|$)/);
  if (phraseMatch) {
    const n = parseInt(phraseMatch[1], 10);
    if (!isNaN(n)) return n;
  }

  // 4. Word-number embedded in phrase — "I want four", "just two"
  const lower = trimmed.toLowerCase();
  for (const [word, num] of Object.entries(WORD_NUMBERS)) {
    // Match whole word, not substring (e.g. "one" in "money" should not match)
    if (new RegExp(`\\b${word}\\b`).test(lower)) return num;
  }

  return null;
};

// ─── Date / Time validators ───────────────────────────────────────────────────

const looksLikeDate = (input) => {
  const s = input.trim().toLowerCase();
  if (s.length < 2) return false;
  if (['today','tomorrow','yesterday','next','this','coming','following'].some(p => s.startsWith(p))) return true;
  if (['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].some(m => s.includes(m))) return true;
  if (['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].some(d => s.includes(d))) return true;
  if (/^\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?$/.test(s)) return true;
  if (/\d+\s+\w+/.test(s) || /\w+\s+\d+/.test(s)) return true;
  // Ordinal numbers: "6th", "1st", "2nd", "3rd", "6th of this month", etc.
  if (/^\d{1,2}(st|nd|rd|th)(\s+.*)?$/.test(s)) return true;
  return false;
};

const looksLikeTime = (input) => {
  const s = input.trim().toLowerCase();
  if (s.length < 2) return false;
  if (['morning','afternoon','evening','night','noon','midnight','midday'].some(p => s.includes(p))) return true;
  if (/am|pm/i.test(s)) return true;
  if (/:\d{2}/.test(s)) return true;
  if (/(in the|past|to|half|quarter)\s+\w+/.test(s)) return true;
  return false;
};

// ─── DB-persisted loop prevention ────────────────────────────────────────────

const LOOP_THRESHOLD = 3;

async function checkLoop(session, raw) {
  if (session.lastLoopMessage === raw && session.lastLoopStep === session.step) {
    const newCount = (session.loopCount || 0) + 1;
    await updateSession(session.customerPhone, session.tenantId, { loopCount: newCount });
    return newCount;
  }
  await updateSession(session.customerPhone, session.tenantId, {
    loopCount: 1,
    lastLoopMessage: raw,
    lastLoopStep:    session.step,
  });
  return 1;
}

// ─── Load business ────────────────────────────────────────────────────────────

async function loadBusiness(session) {
  // phoneNumberId is the most reliable lookup path
  if (session.phoneNumberId) {
    const b = await BusinessConfig.findOne({ phoneNumberId: session.phoneNumberId }).catch(() => null);
    if (b) return b;
  }
  // session.tenantId is a String (sessionService uses String(tenantId)).
  // BusinessConfig.tenantId is an ObjectId in Mongo — string query never matches.
  // Cast to ObjectId before querying.
  if (session.tenantId) {
    let tid = session.tenantId;
    try { tid = new mongoose.Types.ObjectId(session.tenantId); } catch { /* keep string as fallback */ }
    return BusinessConfig.findOne({ tenantId: tid }).catch(() => null);
  }
  return null;
}

// ─── Step history ─────────────────────────────────────────────────────────────

async function pushStep(session, step) {
  const history = [...(session.stepHistory || []), step].slice(-5);
  await updateSession(session.customerPhone, session.tenantId, { stepHistory: history });
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ═════════════════════════════════════════════════════════════════════════════

export const handleFlow = async (session, message, tenant = null, isInteractive = false) => {
  if (!session) return { type: 'text', body: '⚠️ Something went wrong. Please type *Hi* to start fresh.' };

  const raw   = String(message || '').trim();
  const clean = normalize(raw);

  await updateSession(session.customerPhone, session.tenantId, { lastMessage: raw });

  const business = await loadBusiness(session);
  if (!business) return 'Business configuration not found. Please contact support.';

  if (!session.currentFlow) return null;

  // ── Loop detection ────────────────────────────────────────────────────────
  const loopCount = await checkLoop(session, raw);
  if (loopCount >= LOOP_THRESHOLD) {
    await updateSession(session.customerPhone, session.tenantId, { loopCount: 0 });
    trackFailedInteraction(
      session.customerPhone || session.phone?.split('_')[0],
      raw, 'REPEAT', session.phoneNumberId,
    ).catch(() => {});
    const aiReply = await getAIReply(raw, business, session, 'REPEAT');
    if (aiReply) return { type: 'text', body: aiReply };
    return buildLoopFallbackUI(business);
  }

  // ── Global: cancel ────────────────────────────────────────────────────────
  if (isBtnCancel(raw)) {
    await clearSession(session.customerPhone, session.tenantId);
    return buildCancelUI(business);
  }

  // ── Global: "0" → main menu ───────────────────────────────────────────────
  if (raw === '0') {
    await clearSession(session.customerPhone, session.tenantId);
    return buildWelcomeUI(business);
  }

  // ── INTERRUPT step ────────────────────────────────────────────────────────
  if (session.step === 'INTERRUPT') {
    return handleInterrupt(session, raw, business, tenant);
  }

  // ── UPSELL step ───────────────────────────────────────────────────────────
  // One-shot add-on suggestion shown after ORDER confirmation.
  // UPSELL_YES / UPSELL_NO button taps arrive here with isInteractive=true.
  if (session.step === 'UPSELL') {
    const { item, quantity, totalPrice } = session.data || {};
    const pendingAddOn = session.pendingAddOn;
    const addOnAccepted = raw === 'UPSELL_YES' || isBtnConfirm(raw);
    const addOnDeclined = raw === 'UPSELL_NO'  || isBtnReject(raw);

    // Quantity never changes on upsell — add-ons don't affect item count
    const updatedQty   = quantity;
    // Guard: if totalPrice is null (item had no price), treat as 0 when
    // calculating upsell total so payment instructions never show "null".
    const updatedTotal = addOnAccepted && pendingAddOn
      ? (totalPrice || 0) + pendingAddOn.price
      : totalPrice;
    const updatedItem  = addOnAccepted && pendingAddOn
      ? `${item} + ${pendingAddOn.name}`
      : item;

    if (addOnAccepted && pendingAddOn) {
      logger.info('[flowService] Upsell accepted', { addOn: pendingAddOn.name, customerPhone: session.customerPhone });
    } else if (addOnDeclined || isBtnCancel(raw)) {
      // Declined — proceed with original item/total
    } else {
      // Unclear input — re-show upsell prompt
      return pendingAddOn
        ? {
            type: 'buttons',
            body: `Would you like to add a *${pendingAddOn.name}* for *D${pendingAddOn.price}*? 🥤`,
            buttons: [
              { id: 'UPSELL_YES', title: '✅ Yes, add it' },
              { id: 'UPSELL_NO',  title: '❌ No thanks'   },
            ],
          }
        : buildSmartFallbackUI(business);
    }

    // [FLOW-UPSELL SPEC]:
    // IF YES → show updated summary → then show confirm buttons
    // IF NO  → go directly to confirm buttons
    const finalTotal = addOnAccepted && pendingAddOn ? updatedTotal : totalPrice;
    const finalItem  = addOnAccepted && pendingAddOn ? updatedItem  : item;
    const finalQty   = updatedQty;

    await updateSession(session.customerPhone, session.tenantId, {
      step:         'CONFIRM',
      pendingAddOn: null,
      data: { item: finalItem, quantity: finalQty, totalPrice: finalTotal },
    });
    await pushStep(session, 'CONFIRM');

    if (addOnAccepted && pendingAddOn) {
      // STEP 3: Updated summary + confirm
      const updatedSummary =
        `🧾 *Updated Order*\n\n` +
        `🍽️ ${item} × ${quantity}\n` +
        `🥤 ${pendingAddOn.name} × 1\n` +
        `💰 Total: *D${finalTotal}*`;

      return buildConfirmUI(business, updatedSummary);
    }

    // STEP 4: Straight to confirm (upsell declined)
    const confirmText =
      getLabel(business, 'confirmOrder', finalItem, finalQty, finalTotal) ||
      `🧾 *Order Summary*\n\n🍽️ Item: *${finalItem}*\n🔢 Quantity: *${finalQty}*` +
      (finalTotal ? `\n💰 Total: *D${finalTotal}*` : '');

    return buildConfirmUI(business, confirmText);
  }


  // CANCEL at CONFIRM also goes through here — no brain short-circuit.
  if (session.step === 'CONFIRM') {
    if (isBtnConfirm(raw)) return handleFinalize(session, business, tenant);
    if (isBtnReject(raw)) {
      await clearSession(session.customerPhone, session.tenantId);
      return buildCancelUI(business);
    }
    const fallbackSummary = session.currentFlow === 'ORDER'
      ? `🧾 *Order Summary*\n\n🍽️ Item: *${session.data?.item || '?'}*\n🔢 Quantity: *${session.data?.quantity || '?'}*` +
        (session.data?.totalPrice ? `\n💰 Total: *D${session.data.totalPrice}*` : '')
      : session.data?.service
        ? `📋 *Appointment Summary*\n\n💅 Service: *${session.data.service}*\n📅 Date: *${session.data?.date || '?'}*` +
          (session.data?.time ? `\n⏰ Time: *${session.data.time}*` : '')
        : `📋 *Booking Summary*\n\n📅 Date: *${session.data?.date || '?'}*` +
          (session.data?.time ? `\n⏰ Time: *${session.data.time}*` : '');

    return buildConfirmUI(
      business,
      session.currentFlow === 'ORDER'
        ? (getLabel(business, 'confirmOrder', session.data?.item, session.data?.quantity, session.data?.totalPrice) || fallbackSummary)
        : session.data?.service
            ? (getLabel(business, 'confirmBooking', session.data.service, session.data.date, session.data.time) || fallbackSummary)
            : (getLabel(business, 'confirmBooking', session.data?.date, session.data?.time) || fallbackSummary),
    );
  }

  switch (session.currentFlow) {
    case 'ORDER':   return handleOrder(session, raw, clean, business, isInteractive);
    case 'BOOKING': return handleBooking(session, raw, clean, business);
    default:
      await clearSession(session.customerPhone, session.tenantId);
      return buildWelcomeUI(business);
  }
};


// ═════════════════════════════════════════════════════════════════════════════
// ORDER FLOW
// ═════════════════════════════════════════════════════════════════════════════

async function handleOrder(session, raw, clean, business, isInteractive = false) {
  const menu = (business?.menu || []).filter((i) => i.available !== false);

  if (session.suggestion) {
    if (isBtnConfirm(raw)) {
      const selected = session.suggestion;
      await updateSession(session.customerPhone, session.tenantId, {
        data: { ...session.data, item: selected }, step: 'QUANTITY', suggestion: null,
      });
      await pushStep(session, 'QUANTITY');
      return `Great choice 👍\n\nHow many *${selected}* would you like?\n\n(Enter a number, e.g. *1*, *2*)`;
    }
    if (isBtnReject(raw)) {
      await updateSession(session.customerPhone, session.tenantId, { suggestion: null });
      return buildMenuUI(business);
    }
    await updateSession(session.customerPhone, session.tenantId, { suggestion: null });
  }

  switch (session.step) {

    case 'SELECT_ITEM': {
      const index = parseInt(raw, 10);
      if (!isNaN(index) && index > 0) {
        if (!menu[index - 1]) return `Please choose a number between *1* and *${menu.length}*.`;
        const item = getName(menu[index - 1]);
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, item }, step: 'QUANTITY',
        });
        await pushStep(session, 'QUANTITY');
        return `Great choice 👍\n\nHow many *${item}* would you like?\n\n(Enter a number, e.g. *1*, *2*)`;
      }

      if (!clean) return buildMenuUI(business);

      const { item, confidenceLevel } = findBestMatch(menu, clean);

      if (!item || confidenceLevel === 'NONE') return buildMenuUI(business);

      const name = getName(item);

      if (confidenceLevel === 'HIGH') {
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, item: name }, step: 'QUANTITY',
        });
        await pushStep(session, 'QUANTITY');
        return `Great choice 👍\n\nHow many *${name}* would you like?\n\n(Enter a number, e.g. *1*, *2*)`;
      }

      // LOW confidence — buttons (v3.0)
      await updateSession(session.customerPhone, session.tenantId, { suggestion: name });
      return {
        type:    'buttons',
        body:    `Did you mean *${name}*?`,
        buttons: [
          { id: 'CONFIRM', title: '✅ Yes, that one' },
          { id: 'CANCEL',  title: '❌ No, pick again' },
        ],
      };
    }

    case 'QUANTITY': {
      // Interactive taps at QUANTITY are menu re-selections, not quantities
      if (isInteractive) {
        const itemName = session.data?.item;
        return itemName
          ? `Please *type* a number for the quantity of *${itemName}* 😊\n\n(e.g. *1*, *2*, *3*)`
          : 'Please *type* a number for the quantity (e.g. *1*, *2*, *3*).';
      }

      const qty = parseQuantity(raw);
      if (qty > 100) return 'Maximum quantity is 100. Please enter a number between *1* and *100*.';

      if (!qty || qty < 1) {
        // If the message is long/conversational (complaint, question, off-topic),
        // route through Groq so the customer gets a real, helpful reply.
        // Short/garbled input just gets the simple nudge.
        if (raw.trim().length >= 6 && !/^\d+$/.test(raw.trim())) {
          const itemName = session.data?.item;
          const aiReply  = await getAIReply(raw, business, session, 'FALLBACK').catch(() => null);
          if (aiReply) return { type: 'text', body: aiReply };
          return itemName
            ? `How many *${itemName}* would you like? Please reply with a number (e.g. *1*, *2*, *3*).`
            : 'Please reply with a *number* for the quantity (e.g. *1*, *2*, *3*).';
        }
        return session.data?.item
          ? `How many *${session.data.item}* would you like? Reply with a number (e.g. *1*, *2*, *3*).`
          : 'Please enter a *number* for the quantity (e.g. *1*, *2*, *3*).';
      }

      const itemName = session.data?.item;
      if (!itemName) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM' });
        return buildMenuUI(business);
      }

      const menuItem   = (business?.menu || []).find(m => getName(m).toLowerCase() === itemName.toLowerCase());
      const unitPrice  = menuItem?.price || 0;
      const totalPrice = unitPrice > 0 ? unitPrice * qty : null;

      // [FLOW-UPSELL] Decide UPSELL vs CONFIRM before writing to DB — only one write needed.
      // Step transitions: QUANTITY → UPSELL (if add-ons available) OR CONFIRM (direct)
      const cfg    = getModeConfig(business);
      const addOns = cfg.addOns || [];

      // Build the summary message (no confirm buttons yet — that comes next turn)
      const summaryText =
        `🧾 *Order Summary*\n\n` +
        `🍽️ Item: *${itemName}*\n` +
        `🔢 Quantity: *${qty}*` +
        (totalPrice ? `\n💰 Total: *D${totalPrice}*` : '');

      if (addOns.length > 0 && !session.upsellSent) {
        // Pick a random add-on and queue upsell immediately after summary
        const addOn = addOns[Math.floor(Math.random() * addOns.length)];
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, quantity: qty, totalPrice },
          step: 'UPSELL',
          upsellSent:  true,
          pendingAddOn: { name: addOn.name, price: addOn.price },
        });
        await pushStep(session, 'UPSELL');

        // Return summary + upsell as a SINGLE structured response
        // webhookController dispatches this via dispatch() which calls sendMessage()
        // We send two messages: summary (text) then upsell (buttons)
        // Since we can only return ONE ui object, combine them cleanly:
        return {
          type: 'buttons',
          body: summaryText + `\n\n➕ Would you like to add a *${addOn.name}* for *D${addOn.price}*? 🥤`,
          buttons: [
            { id: 'UPSELL_YES', title: '✅ Yes, add it' },
            { id: 'UPSELL_NO',  title: '❌ No thanks'   },
          ],
        };
      }

      // No upsell → go straight to confirm prompt
      await updateSession(session.customerPhone, session.tenantId, {
        data: { ...session.data, quantity: qty, totalPrice }, step: 'CONFIRM',
      });
      await pushStep(session, 'CONFIRM');

      const confirmText =
        getLabel(business, 'confirmOrder', itemName, qty, totalPrice) ||
        summaryText;

      return buildConfirmUI(business, confirmText);
    }

    case 'PAYMENT_PROOF': {
      // Client sent text while waiting to upload screenshot — do NOT reset the flow.
      // Answer their question via AI if possible, then re-show the payment instructions.
      const { totalPrice } = session.data || {};

      // Try AI for conversational messages (questions, complaints, etc.)
      if (raw.trim().length >= 4) {
        const aiReply = await getAIReply(raw, business, session, 'FALLBACK').catch(() => null);
        if (aiReply) {
          // Append a short reminder so client knows they still need to send the screenshot
          const reminder = '\n\n💳 Reminder: please send your *Wave payment screenshot* to complete your order.';
          return { type: 'text', body: aiReply + reminder };
        }
      }

      // Fallback: re-show full payment instructions (handles null totalPrice safely)
      return buildPaymentInstructionsUI(business, totalPrice, String(session.customerPhone).slice(-4));
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM' });
      return buildMenuUI(business);
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// BOOKING FLOW
// ═════════════════════════════════════════════════════════════════════════════

async function handleBooking(session, raw, clean, business) {
  switch (session.step) {

    case 'SELECT_SERVICE': {
      const services = (business?.services || []).filter(s => s.available !== false);

      // No services configured — skip to DATE step rather than looping
      if (services.length === 0) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'DATE' });
        const prompt = getLabel(business, 'bookPrompt') || 'What date would you like?';
        return `No booking types are currently listed, but we can still book you in!\n\n${prompt} 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)`;
      }

      const index = parseInt(raw, 10);
      if (!isNaN(index) && index > 0) {
        if (!services[index - 1]) return `Please choose a number between *1* and *${services.length}*.`;
        const svc = services[index - 1];
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, service: svc.name, serviceDuration: svc.duration }, step: 'DATE',
        });
        await pushStep(session, 'DATE');
        const prompt = getLabel(business, 'bookPrompt') || 'What date would you like?';
        return `Great! *${svc.name}* selected ✅\n\n${prompt} 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)`;
      }
      const { item: svcMatch, confidenceLevel } = findBestMatch(services, clean);
      if (svcMatch && confidenceLevel === 'HIGH') {
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, service: svcMatch.name, serviceDuration: svcMatch.duration }, step: 'DATE',
        });
        await pushStep(session, 'DATE');
        const prompt = getLabel(business, 'bookPrompt') || 'What date would you like?';
        return `Great! *${svcMatch.name}* selected ✅\n\n${prompt} 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)`;
      }
      return buildServicesUI(business);
    }

    case 'DATE': {
      const dateInput = raw.trim();
      if (dateInput.length < 2) {
        return getLabel(business, 'bookPrompt') || 'Please tell me the *date* for your booking 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)';
      }
      if (isConfirm(clean) || isReject(clean)) {
        return 'I need a *date* for your booking 📅\n\nWhat date works for you?\n(e.g. *25 June*, *next Friday*, *tomorrow*)';
      }
      if (!looksLikeDate(dateInput)) {
        // Long/conversational input → Groq handles it (complaint, question, etc.)
        if (dateInput.length >= 8 && !/\d/.test(dateInput)) {
          const aiReply = await getAIReply(dateInput, business, session, 'FALLBACK').catch(() => null);
          if (aiReply) return { type: 'text', body: aiReply };
        }
        return (
          `Sorry, I couldn't understand "*${dateInput}*" as a date 📅\n\n` +
          `Please give me a clearer date, for example:\n` +
          `• *25 June*\n• *tomorrow*\n• *next Friday*\n• *25/06/2025*`
        );
      }
      await updateSession(session.customerPhone, session.tenantId, {
        data: { ...session.data, date: dateInput }, step: 'DATE_CONFIRM',
      });
      await pushStep(session, 'DATE_CONFIRM');
      return {
        type:    'buttons',
        body:    `Just to confirm — did you mean *${dateInput}*? 📅`,
        buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'CANCEL', title: '❌ No, re-enter' }],
      };
    }

    case 'DATE_CONFIRM': {
      if (isConfirm(clean) || isBtnConfirm(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'TIME' });
        await pushStep(session, 'TIME');
        const timePrompt = getLabel(business, 'timePrompt') || 'What time would you prefer?';
        return `Got it — *${session.data?.date}* ✅\n\n${timePrompt} ⏰\n\n(e.g. *2pm*, *14:00*, *morning*)`;
      }
      if (isReject(clean) || isBtnReject(raw)) {
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, date: null }, step: 'DATE',
        });
        return "No problem! Let's try again.\n\nWhat *date* would you like to book? 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)";
      }
      const newDate = raw.trim();
      if (looksLikeDate(newDate)) {
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, date: newDate }, step: 'DATE_CONFIRM',
        });
        return {
          type:    'buttons',
          body:    `Just to confirm — did you mean *${newDate}*? 📅`,
          buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'CANCEL', title: '❌ No, re-enter' }],
        };
      }
      return `Please tap *Yes* to confirm *${session.data?.date}* or *No* to change it.`;
    }

    case 'TIME': {
      const timeInput = raw.trim();
      if (timeInput.length < 2) {
        return getLabel(business, 'timePrompt') || 'Please enter a *time* for your booking ⏰\n\n(e.g. *2pm*, *14:00*, *morning*)';
      }
      if (isConfirm(clean) || isReject(clean)) {
        return 'I need a *time* for your booking ⏰\n\nWhat time works for you?\n(e.g. *2pm*, *14:00*, *morning*)';
      }
      if (!looksLikeTime(timeInput)) {
        // Long/conversational input → Groq handles it
        if (timeInput.length >= 8 && !/\d/.test(timeInput) && !/am|pm/i.test(timeInput)) {
          const aiReply = await getAIReply(timeInput, business, session, 'FALLBACK').catch(() => null);
          if (aiReply) return { type: 'text', body: aiReply };
        }
        return (
          `Sorry, I couldn't understand "*${timeInput}*" as a time ⏰\n\n` +
          `Please give me a clearer time, for example:\n` +
          `• *2pm* or *2:00pm*\n• *14:00*\n• *morning*\n• *6 in the morning*`
        );
      }
      await updateSession(session.customerPhone, session.tenantId, {
        data: { ...session.data, time: timeInput }, step: 'TIME_CONFIRM',
      });
      await pushStep(session, 'TIME_CONFIRM');
      return {
        type:    'buttons',
        body:    `Just to confirm — did you mean *${timeInput}*? ⏰`,
        buttons: [{ id: 'CONFIRM', title: '✅ Yes, that time' }, { id: 'CANCEL', title: '❌ No, re-enter' }],
      };
    }

    case 'TIME_CONFIRM': {
      if (isConfirm(clean) || isBtnConfirm(raw)) {
        const { date, time, service } = session.data || {};
        await updateSession(session.customerPhone, session.tenantId, { step: 'CONFIRM' });
        await pushStep(session, 'CONFIRM');
        const summaryText = service
          ? getLabel(business, 'confirmBooking', service, date, time)
            || `📋 *Appointment Summary*\n\n💅 Service: *${service}*\n📅 Date: *${date}*${time ? `\n⏰ Time: *${time}*` : ''}`
          : getLabel(business, 'confirmBooking', date, time)
            || `📋 *Booking Summary*\n\n📅 Date: *${date || 'Not specified'}*${time ? `\n⏰ Time: *${time}*` : ''}`;
        return buildConfirmUI(business, summaryText);
      }
      if (isReject(clean) || isBtnReject(raw)) {
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, time: null }, step: 'TIME',
        });
        return "No problem! Let's try again.\n\nWhat *time* would you prefer? ⏰\n\n(e.g. *2pm*, *14:00*, *morning*)";
      }
      const newTime = raw.trim();
      if (looksLikeTime(newTime)) {
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, time: newTime }, step: 'TIME_CONFIRM',
        });
        return {
          type:    'buttons',
          body:    `Just to confirm — did you mean *${newTime}*? ⏰`,
          buttons: [{ id: 'CONFIRM', title: '✅ Yes, that time' }, { id: 'CANCEL', title: '❌ No, re-enter' }],
        };
      }
      return `Please tap *Yes* to confirm *${session.data?.time}* or *No* to change it.`;
    }

    default: {
      const cfg = getModeConfig(business);
      let firstStep = cfg.bookingSteps[0] || 'DATE';
      // Skip SELECT_SERVICE when no services are configured
      if (firstStep === 'SELECT_SERVICE') {
        const availableSvcs = (business?.services || []).filter(s => s.available !== false);
        if (availableSvcs.length === 0) firstStep = 'DATE';
      }
      await updateSession(session.customerPhone, session.tenantId, { step: firstStep });
      if (firstStep === 'SELECT_SERVICE') return buildServicesUI(business);
      return getLabel(business, 'bookPrompt') || "Let's start over 😊\n\nWhat *date* would you like to book? 📅";
    }
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// FINALIZE
// ═════════════════════════════════════════════════════════════════════════════

async function handleFinalize(session, business, tenant) {

  const gracefulRetryUI = (flow) => {
    const bizName = business?.name || 'us';
    const action  = flow === 'ORDER' ? '*Order*' : '*Book*';
    return {
      type: 'text',
      body: `We're having a little trouble right now 🙏\n\nYour request didn't go through — but it's not your fault!\n\nPlease try again by typing ${action}, or contact *${bizName}* directly if the problem continues.`,
    };
  };

  if (session.currentFlow === 'ORDER') {
    const { item, quantity, totalPrice } = session.data || {};

    if (!item || !quantity) {
      logger.error('[flowService] Order finalize: missing item or quantity', { item, quantity, customerPhone: session.customerPhone });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('ORDER');
    }

    // Guard against null/incomplete business object
    if (!business?._id) {
      logger.error('[flowService] Order finalize: business not found or missing _id', {
        tenantId: session.tenantId, phoneNumberId: session.phoneNumberId, customerPhone: session.customerPhone,
      });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('ORDER');
    }

    if (!tenant?._id) {
      logger.error('[flowService] Order finalize: no tenant _id', { tenantId: session.tenantId, customerPhone: session.customerPhone });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('ORDER');
    }

    const customerPhone = session.customerPhone || session.phone;

    try {
      await Order.create({
        phone:         customerPhone,
        customerPhone,
        businessId:    business._id,
        tenantId:      tenant._id,
        item,
        quantity,
        totalPrice:    totalPrice || null,
        status:        'pending',
        paymentMethod: 'wave',
        paymentStatus: 'unpaid',
      });
    } catch (err) {
      logger.error('[flowService] Order save error', { err: err.message, item, quantity, customerPhone });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('ORDER');
    }

    trackOrderAnalytics(item, session.phoneNumberId, quantity).catch(() => {});
    trackUser(customerPhone, item, 'ORDER', { item }).catch(() => {});

    if (business.adminPhone) {
      const alert = buildAdminOrderAlert(customerPhone, item, quantity, business, totalPrice);
      dispatch(business.adminPhone, { type: 'text', body: alert }, tenant).catch((err) =>
        logger.error('[flowService] Admin order alert failed', { err: err.message }));
    }

    // [FLOW-UPSELL] Upsell now fires at QUANTITY step, NOT here.
    // handleFinalize receives the final confirmed item/quantity/totalPrice from session.data.
    // ── Wave payment flow ─────────────────────────────────────────────────
    const wavePhone = business.wavePhone?.trim();
    const waveInstr = business.customMessages?.payment?.trim() ||
                      business.customMessages?.paymentInstructions?.trim();
    const effectiveWavePhone = business?.payment?.wavePhone?.trim() || wavePhone;

    if (effectiveWavePhone || waveInstr) {
      // Find the order just created — narrow to last 60s + unpaid to avoid matching stale orders
      const savedOrder = await Order.findOne(
        {
          customerPhone,
          tenantId: tenant._id,
          status: 'pending',
          paymentStatus: 'unpaid',
          createdAt: { $gte: new Date(Date.now() - 60_000) },
        },
        null,
        { sort: { createdAt: -1 } }
      ).catch(() => null);

      let paymentMsg;
      if (savedOrder) {
        try {
          paymentMsg = await initiatePayment(savedOrder._id, business);
        } catch { /* fallback to builder */ }
      }

      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER', step: 'PAYMENT_PROOF', data: { item, quantity, totalPrice },
      });
      return paymentMsg
        ? { type: 'text', body: paymentMsg }
        : buildPaymentInstructionsUI(business, totalPrice, String(customerPhone).slice(-4));
    }

    // No payment configured — clear session and confirm
    await clearSession(session.customerPhone, session.tenantId);
    const successMsg =
      getLabel(business, 'afterOrder') ||
      `✅ *Order confirmed.* We're preparing it now. 🙏`;
    return { type: 'text', body: successMsg };
  }

  if (session.currentFlow === 'BOOKING') {
    const { date, time, service, serviceDuration } = session.data || {};

    if (!date && !service) {
      logger.error('[flowService] Booking finalize: missing date and service', { customerPhone: session.customerPhone });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('BOOKING');
    }

    // Guard against null business for BOOKING path too
    if (!business?._id) {
      logger.error('[flowService] Booking finalize: business not found or missing _id', {
        tenantId: session.tenantId, phoneNumberId: session.phoneNumberId, customerPhone: session.customerPhone,
      });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('BOOKING');
    }

    if (!tenant?._id) {
      logger.error('[flowService] Booking finalize: no tenant _id', { tenantId: session.tenantId, customerPhone: session.customerPhone });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('BOOKING');
    }

    const customerPhone = session.customerPhone || session.phone;

    try {
      await Booking.create({
        phone:         customerPhone,
        customerPhone,
        businessId:    business._id,
        tenantId:      tenant._id,
        date:          date    || null,
        time:          time    || null,
        service:       service || null,
        duration:      serviceDuration || null,
        status:        'pending',
        notifiedAt:    null,
      });
    } catch (err) {
      logger.error('[flowService] Booking save error', { err: err.message, date, time, service, customerPhone });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('BOOKING');
    }

    trackBookingAnalytics({ date, time, phoneNumberId: session.phoneNumberId }).catch(() => {});
    trackUser(customerPhone, date || service, 'BOOKING', {}).catch(() => {});

    if (business.adminPhone) {
      const alert = buildAdminBookingAlert(customerPhone, date || 'TBD', time, business, service);
      dispatch(business.adminPhone, { type: 'text', body: alert }, tenant).catch((err) =>
        logger.error('[flowService] Admin booking alert failed', { err: err.message }));
    }

    await clearSession(session.customerPhone, session.tenantId);
    return buildBookingSuccessUI(business, date || null, time, service || null);
  }

  await clearSession(session.customerPhone, session.tenantId);
  return buildWelcomeUI(business);
}


// ═════════════════════════════════════════════════════════════════════════════
// INTERRUPT
// ═════════════════════════════════════════════════════════════════════════════

async function handleInterrupt(session, raw, business, tenant) {

  if (isSwitchYes(raw)) {
    const newFlow = session.pendingIntent;
    if (!newFlow || !['ORDER', 'BOOKING'].includes(newFlow)) {
      await clearSession(session.customerPhone, session.tenantId);
      return buildWelcomeUI(business);
    }
    const cfg = getModeConfig(business);
    let firstStep = newFlow === 'ORDER' ? cfg.orderSteps[0] || 'SELECT_ITEM' : cfg.bookingSteps[0] || 'DATE';

    // Skip SELECT_SERVICE when no services are configured
    if (newFlow === 'BOOKING' && firstStep === 'SELECT_SERVICE') {
      const availableSvcs = (business?.services || []).filter(s => s.available !== false);
      if (availableSvcs.length === 0) firstStep = 'DATE';
    }

    await updateSession(session.customerPhone, session.tenantId, {
      currentFlow: newFlow, step: firstStep, data: {},
      pendingIntent: null, previousStep: null, previousFlow: null, suggestion: null,
    });
    if (newFlow === 'ORDER')            return buildMenuUI(business);
    if (firstStep === 'SELECT_SERVICE') return buildServicesUI(business);
    return `Sure! Let's set up your booking 📅\n\nWhat *date* would you like?\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)`;
  }

  if (isSwitchNo(raw)) {
    const prevStep = session.previousStep ||
      (session.currentFlow === 'ORDER' ? 'SELECT_ITEM' : 'DATE');
    await updateSession(session.customerPhone, session.tenantId, {
      step: prevStep, pendingIntent: null, previousStep: null,
    });

    if (session.currentFlow === 'BOOKING') {
      if (prevStep === 'TIME' || prevStep === 'TIME_CONFIRM') {
        const d = session.data?.date || 'your booking';
        return `No problem! Continuing your booking.\n\nWhat *time* would you like for *${d}*? ⏰`;
      }
      if (prevStep === 'DATE_CONFIRM') {
        return {
          type:    'buttons',
          body:    `No problem! Continuing your booking.\n\nJust to confirm — did you mean *${session.data?.date}*? 📅`,
          buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'CANCEL', title: '❌ No, re-enter' }],
        };
      }
      if (prevStep === 'SELECT_SERVICE') return buildServicesUI(business);
      if (prevStep === 'CONFIRM') {
        const { date, time, service } = session.data || {};
        const summaryText = service
          ? `📋 *Appointment Summary*\n\n💅 Service: *${service}*\n📅 Date: *${date}*${time ? `\n⏰ Time: *${time}*` : ''}`
          : `📋 *Booking Summary*\n\n📅 Date: *${date}*${time ? `\n⏰ Time: *${time}*` : ''}`;
        return buildConfirmUI(business, summaryText);
      }
      return "No problem! Continuing your booking.\n\nWhat *date* would you like? 📅";
    }

    if (prevStep === 'QUANTITY' && session.data?.item) {
      return `No problem! Continuing your order.\n\nHow many *${session.data.item}* would you like?`;
    }
    if (prevStep === 'CONFIRM' && session.data?.item) {
      return buildConfirmUI(
        business,
        `🧾 *Order Summary*\n\n🍽️ Item: *${session.data.item}*\n🔢 Quantity: *${session.data.quantity}*`,
      );
    }
    return buildMenuUI(business);
  }

  return buildInterruptUI(business, session.currentFlow, session.pendingIntent || 'ORDER');
}


// ═════════════════════════════════════════════════════════════════════════════
// FLOW STARTERS
// ═════════════════════════════════════════════════════════════════════════════

export async function startOrderFlow(session, business) {
  const cfg = getModeConfig(business);
  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'ORDER', step: cfg.orderSteps[0] || 'SELECT_ITEM', data: {}, suggestion: null,
  });
  return buildMenuUI(business);
}

export async function startBookingFlow(session, business) {
  const cfg = getModeConfig(business);
  let firstStep = cfg.bookingSteps[0] || 'DATE';

  // If SELECT_SERVICE is the first step but no services are configured,
  // skip straight to DATE so the customer isn't shown an empty/stale services list.
  const availableServices = (business?.services || []).filter(s => s.available !== false);
  if (firstStep === 'SELECT_SERVICE' && availableServices.length === 0) {
    firstStep = 'DATE';
    logger.warn('[flowService] startBookingFlow: SELECT_SERVICE step skipped — no services configured', {
      tenantId: session.tenantId,
    });
  }

  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'BOOKING', step: firstStep, data: {}, suggestion: null,
  });
  if (firstStep === 'SELECT_SERVICE') return buildServicesUI(business);
  const prompt = getLabel(business, 'bookPrompt') || 'What date would you like to book?';
  return { type: 'text', body: `Sure 👍\n\n${prompt} 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)` };
}
