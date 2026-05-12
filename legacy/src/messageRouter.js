'use strict';

/**
 * Message Router — Parses incoming WhatsApp messages and routes to flow handlers.
 * Handles: text, interactive replies, images, voice notes, stickers, documents.
 */

const { sessionStore } = require('../services/sessionStore');
const { markRead } = require('../services/waSender');
const { detectIntent } = require('../utils/nlp');
const { logger } = require('../utils/logger');

const welcomeFlow   = require('../flows/welcomeFlow');
const orderFlow     = require('../flows/orderFlow');
const bookingFlow   = require('../flows/bookingFlow');
const paymentFlow   = require('../flows/paymentFlow');
const helpFlow      = require('../flows/helpFlow');
const mediaFlow     = require('../flows/mediaFlow');

// Deduplication: track recent message IDs to prevent double-processing
const _processedIds = new Set();
setInterval(() => { if (_processedIds.size > 2000) _processedIds.clear(); }, 10 * 60 * 1000);

async function handleIncomingMessage({ message, contact, metadata }) {
  const msgId = message.id;

  // Dedup
  if (_processedIds.has(msgId)) {
    logger.debug(`Duplicate message ignored: ${msgId}`);
    return;
  }
  _processedIds.add(msgId);

  const userId = message.from;
  const phoneNumberId = metadata.phone_number_id;
  const contactName = contact?.profile?.name || 'Friend';

  // Mark as read (best-effort)
  markRead(phoneNumberId, msgId);

  // Get/create session
  const session = sessionStore.getOrCreate(userId, contactName);
  session.interactionCount += 1;
  session.phoneNumberId = phoneNumberId;

  // ─── Parse Message Content ─────────────────────────────────────────────────
  const parsed = parseMessage(message);
  logger.info(`[${userId}] type=${parsed.type} state=${session.state} text="${parsed.text?.substring(0, 60)}"`);

  // ─── Route by Session State ────────────────────────────────────────────────
  try {
    // Image/media always goes to media flow (handles payment proof)
    if (parsed.type === 'image' || parsed.type === 'document') {
      return await mediaFlow.handle({ session, parsed, userId, phoneNumberId });
    }
    if (['sticker', 'voice', 'video', 'audio'].includes(parsed.type)) {
      return await mediaFlow.handleUnsupported({ session, parsed, userId, phoneNumberId });
    }

    // Interactive button/list replies
    if (parsed.type === 'interactive') {
      return await routeInteractive({ session, parsed, userId, phoneNumberId });
    }

    // Text messages
    if (parsed.type === 'text') {
      return await routeText({ session, parsed, userId, phoneNumberId });
    }

    // Empty or unknown
    return await welcomeFlow.handleUnknown({ session, userId, phoneNumberId });

  } catch (err) {
    logger.error(`[${userId}] Flow error: ${err.message}`, err);
    await helpFlow.sendErrorRecovery({ userId, phoneNumberId, session });
  }
}

// ─── Text Routing ─────────────────────────────────────────────────────────────
async function routeText({ session, parsed, userId, phoneNumberId }) {
  const text = parsed.text;
  const intent = detectIntent(text);

  // Store in message history (rolling window of 10)
  session.messageHistory.push({ text, intent: intent.primary, ts: Date.now() });
  if (session.messageHistory.length > 10) session.messageHistory.shift();
  session.lastIntent = intent.primary;
  sessionStore.save(session);

  // ── If awaiting confirmation, handle YES/NO first ─────────────────────────
  if (session.awaitingConfirmation) {
    if (intent.primary === 'YES') return await resolveConfirmation(session, 'yes', { userId, phoneNumberId });
    if (intent.primary === 'NO')  return await resolveConfirmation(session, 'no', { userId, phoneNumberId });
  }

  // ── Global high-priority intents (override any state) ─────────────────────
  if (intent.primary === 'GREETING') {
    return await welcomeFlow.handle({ session, parsed, userId, phoneNumberId, intent });
  }
  if (intent.primary === 'HUMAN') {
    return await helpFlow.escalateToHuman({ session, userId, phoneNumberId });
  }
  if (intent.primary === 'CANCEL') {
    return await handleCancel({ session, userId, phoneNumberId, intent });
  }
  if (intent.primary === 'HELP') {
    return await helpFlow.handle({ session, parsed, userId, phoneNumberId });
  }
  if (intent.primary === 'PAYMENT_PROOF') {
    return await paymentFlow.handleProofReminder({ session, userId, phoneNumberId });
  }

  // ── Route by current session state ───────────────────────────────────────
  switch (session.state) {

    case 'IDLE':
    case 'WELCOME':
      return await welcomeFlow.handle({ session, parsed, userId, phoneNumberId, intent });

    case 'BROWSING_MENU':
    case 'ORDERING':
    case 'AWAITING_QUANTITY':
    case 'AWAITING_ADDON':
    case 'AWAITING_ORDER_TYPE':
    case 'CART_REVIEW':
      return await orderFlow.handle({ session, parsed, userId, phoneNumberId, intent });

    case 'CHECKOUT':
    case 'AWAITING_DELIVERY_ADDRESS':
    case 'AWAITING_PAYMENT_METHOD':
    case 'AWAITING_PAYMENT_PROOF':
      return await paymentFlow.handle({ session, parsed, userId, phoneNumberId, intent });

    case 'BOOKING':
    case 'AWAITING_BOOKING_DATE':
    case 'AWAITING_BOOKING_TIME':
    case 'AWAITING_BOOKING_PARTY':
      return await bookingFlow.handle({ session, parsed, userId, phoneNumberId, intent });

    case 'HELP':
      return await helpFlow.handle({ session, parsed, userId, phoneNumberId, intent });

    default:
      // Unknown state — try to infer from intent
      return await inferAndRoute({ session, parsed, userId, phoneNumberId, intent });
  }
}

// ─── Interactive Routing ──────────────────────────────────────────────────────
async function routeInteractive({ session, parsed, userId, phoneNumberId }) {
  const id = parsed.interactiveId;
  const title = parsed.interactiveTitle;

  // Map button IDs to intents/actions
  if (id === 'action_order')   return await orderFlow.startBrowsing({ session, userId, phoneNumberId });
  if (id === 'action_book')    return await bookingFlow.startBooking({ session, userId, phoneNumberId });
  if (id === 'action_help')    return await helpFlow.handle({ session, parsed, userId, phoneNumberId });
  if (id === 'action_menu')    return await orderFlow.startBrowsing({ session, userId, phoneNumberId });
  if (id === 'action_cart')    return await orderFlow.showCart({ session, userId, phoneNumberId });
  if (id === 'action_checkout') return await paymentFlow.startCheckout({ session, userId, phoneNumberId });
  if (id === 'action_clear_cart') return await orderFlow.clearCart({ session, userId, phoneNumberId });
  if (id === 'action_continue') return await orderFlow.startBrowsing({ session, userId, phoneNumberId });
  if (id === 'action_back_home') return await welcomeFlow.handle({ session, parsed, userId, phoneNumberId });
  if (id === 'confirm_yes')     return await resolveConfirmation(session, 'yes', { userId, phoneNumberId });
  if (id === 'confirm_no')      return await resolveConfirmation(session, 'no', { userId, phoneNumberId });
  if (id === 'action_human')    return await helpFlow.escalateToHuman({ session, userId, phoneNumberId });
  if (id === 'action_resend_proof') return await paymentFlow.promptResendProof({ session, userId, phoneNumberId });

  // Order type
  if (id === 'order_delivery') return await orderFlow.setOrderType({ session, type: 'delivery', userId, phoneNumberId });
  if (id === 'order_pickup')   return await orderFlow.setOrderType({ session, type: 'pickup', userId, phoneNumberId });
  if (id === 'order_dinein')   return await orderFlow.setOrderType({ session, type: 'dinein', userId, phoneNumberId });

  // Payment method
  if (id?.startsWith('pay_'))  return await paymentFlow.selectMethod({ session, methodId: id.replace('pay_', ''), userId, phoneNumberId });

  // Menu category selection
  if (id?.startsWith('cat_'))  return await orderFlow.showCategory({ session, categoryId: id.replace('cat_', ''), userId, phoneNumberId });

  // Menu item selection
  if (id?.startsWith('item_')) return await orderFlow.selectItem({ session, itemId: id.replace('item_', ''), userId, phoneNumberId });

  // Quantity quick-picks
  if (id?.startsWith('qty_'))  return await orderFlow.setQuantityFromButton({ session, qty: parseInt(id.replace('qty_', ''), 10), userId, phoneNumberId });

  // Addon
  if (id?.startsWith('addon_')) return await orderFlow.addAddon({ session, addonId: id.replace('addon_', ''), userId, phoneNumberId });
  if (id === 'addon_skip')     return await orderFlow.skipAddon({ session, userId, phoneNumberId });

  // Upsell
  if (id?.startsWith('upsell_')) return await orderFlow.selectItem({ session, itemId: id.replace('upsell_', ''), userId, phoneNumberId });
  if (id === 'upsell_skip')    return await orderFlow.showCart({ session, userId, phoneNumberId });

  // Fallback: treat button title as a text message
  logger.warn(`[${userId}] Unknown interactive id: ${id}`);
  parsed.text = title || id;
  return await routeText({ session, parsed, userId, phoneNumberId });
}

// ─── Confirmation Resolution ──────────────────────────────────────────────────
async function resolveConfirmation(session, answer, { userId, phoneNumberId }) {
  const conf = session.awaitingConfirmation;
  if (!conf) return;
  session.awaitingConfirmation = null;
  sessionStore.save(session);

  switch (conf.type) {
    case 'fuzzy_item':
      if (answer === 'yes') {
        return await orderFlow.selectItem({ session, itemId: conf.data.itemId, userId, phoneNumberId });
      }
      return await orderFlow.startBrowsing({ session, userId, phoneNumberId });

    case 'large_qty':
      if (answer === 'yes') {
        return await orderFlow.confirmItemAdd({ session, qty: conf.data.qty, userId, phoneNumberId });
      }
      return await orderFlow.askQuantity({ session, userId, phoneNumberId });

    case 'clear_cart':
      if (answer === 'yes') {
        return await orderFlow.clearCart({ session, userId, phoneNumberId, confirmed: true });
      }
      return await orderFlow.showCart({ session, userId, phoneNumberId });

    case 'cancel_order':
      if (answer === 'yes') {
        session.currentOrder = [];
        session.state = 'IDLE';
        sessionStore.save(session);
        return await welcomeFlow.handle({ session, parsed: { text: '' }, userId, phoneNumberId });
      }
      return await orderFlow.showCart({ session, userId, phoneNumberId });
  }
}

// ─── Cancel Handler ───────────────────────────────────────────────────────────
async function handleCancel({ session, userId, phoneNumberId }) {
  if (session.currentOrder.length > 0) {
    session.awaitingConfirmation = { type: 'cancel_order', data: {} };
    sessionStore.save(session);
    const { sendButtons } = require('../services/waSender');
    return sendButtons(phoneNumberId, userId,
      'Are you sure you want to cancel your current order? 🤔\nYour items will be cleared.',
      [
        { id: 'confirm_yes', title: '✅ Yes, Cancel' },
        { id: 'confirm_no',  title: '❌ Keep My Order' },
      ]
    );
  }
  session.state = 'IDLE';
  sessionStore.save(session);
  return await welcomeFlow.sendWelcome({ session, userId, phoneNumberId });
}

// ─── Infer & Route (unknown state recovery) ────────────────────────────────────
async function inferAndRoute({ session, parsed, userId, phoneNumberId, intent }) {
  logger.warn(`[${userId}] Unknown state "${session.state}" — inferring from intent: ${intent.primary}`);
  session.state = 'IDLE';
  sessionStore.save(session);

  if (['ORDER', 'MENU'].includes(intent.primary))    return await orderFlow.startBrowsing({ session, userId, phoneNumberId });
  if (intent.primary === 'BOOK')                     return await bookingFlow.startBooking({ session, userId, phoneNumberId });
  if (intent.primary === 'CHECKOUT')                 return await paymentFlow.startCheckout({ session, userId, phoneNumberId });

  return await welcomeFlow.handle({ session, parsed, userId, phoneNumberId, intent });
}

// ─── Message Parser ───────────────────────────────────────────────────────────
function parseMessage(message) {
  const type = message.type;

  if (type === 'text') {
    return { type: 'text', text: message.text?.body?.trim() || '' };
  }

  if (type === 'interactive') {
    const iType = message.interactive?.type;
    if (iType === 'button_reply') {
      return {
        type: 'interactive',
        interactiveType: 'button',
        interactiveId: message.interactive.button_reply?.id,
        interactiveTitle: message.interactive.button_reply?.title,
        text: message.interactive.button_reply?.title,
      };
    }
    if (iType === 'list_reply') {
      return {
        type: 'interactive',
        interactiveType: 'list',
        interactiveId: message.interactive.list_reply?.id,
        interactiveTitle: message.interactive.list_reply?.title,
        text: message.interactive.list_reply?.title,
      };
    }
  }

  if (type === 'image') {
    return { type: 'image', mediaId: message.image?.id, caption: message.image?.caption };
  }

  if (type === 'document') {
    return { type: 'document', mediaId: message.document?.id, filename: message.document?.filename };
  }

  return { type, raw: message };
}

module.exports = { handleIncomingMessage };
