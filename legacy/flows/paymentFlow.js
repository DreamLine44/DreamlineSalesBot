'use strict';

/**
 * Payment Flow — Handles checkout, delivery address, payment method selection,
 * proof upload, and verification. Session is NEVER cleared prematurely.
 *
 * KEY FIX: Payment context persists for 24 hours. No "No active order found" errors.
 */

const { sendText, sendButtons, sendList } = require('../services/waSender');
const { sessionStore } = require('../services/sessionStore');
const { parseQuantity, detectIntent } = require('../utils/nlp');
const config = require('../config/businessConfig');
const { logger } = require('../utils/logger');
const { formatCurrency, generateOrderId } = require('../utils/helpers');
const { cartTotal, askOrderType } = require('./orderFlow');

// ─── Start Checkout ───────────────────────────────────────────────────────────
async function startCheckout({ session, userId, phoneNumberId }) {
  if (!session.currentOrder.length) {
    return sendButtons(phoneNumberId, userId,
      `Your cart is empty! 🛒 Add some items first.`,
      [{ id: 'action_order', title: '📋 Browse Menu' }]
    );
  }

  // Ask order type if not set
  if (!session.orderType) {
    return askOrderType({ session, userId, phoneNumberId });
  }

  return continueCheckout({ session, userId, phoneNumberId });
}

// ─── Continue Checkout (after order type set) ─────────────────────────────────
async function continueCheckout({ session, userId, phoneNumberId }) {
  if (session.orderType === 'delivery' && !session.deliveryAddress) {
    session.state = 'AWAITING_DELIVERY_ADDRESS';
    sessionStore.save(session);
    return sendText(phoneNumberId, userId,
      `📍 *Delivery Details*\n\nPlease share your delivery address.\nExample: _"15 Pipeline Road, Bakau"_\n\nWe deliver to: ${config.delivery.zones.join(', ')}`
    );
  }

  return showOrderSummaryAndPayment({ session, userId, phoneNumberId });
}

// ─── Order Summary + Payment Selection ───────────────────────────────────────
async function showOrderSummaryAndPayment({ session, userId, phoneNumberId }) {
  const subtotal = cartTotal(session.currentOrder);
  const deliveryFee = session.orderType === 'delivery' && subtotal < config.delivery.freeAbove
    ? config.delivery.fee : 0;
  const total = subtotal + deliveryFee;

  // Generate order ID if not exists
  if (!session.payment.orderId) {
    session.payment.orderId = generateOrderId();
  }
  session.state = 'AWAITING_PAYMENT_METHOD';
  sessionStore.save(session);

  let summary = `📋 *Order Confirmation*\n${'─'.repeat(25)}\n`;
  for (const item of session.currentOrder) {
    summary += `• ${item.qty}x ${item.name} — ${formatCurrency(item.qty * item.price)}\n`;
  }
  summary += `${'─'.repeat(25)}\n`;
  summary += `Subtotal: ${formatCurrency(subtotal)}\n`;
  if (deliveryFee > 0) summary += `Delivery: ${formatCurrency(deliveryFee)}\n`;
  if (session.deliveryAddress) summary += `📍 ${session.deliveryAddress}\n`;
  summary += `${'─'.repeat(25)}\n*Total: ${formatCurrency(total)}*\n\nOrder ID: *${session.payment.orderId}*\n\nChoose payment method:`;

  const payMethods = config.payment.methods.map(m => ({
    id: `pay_${m.id}`,
    title: m.name.substring(0, 20),
    description: m.id === 'cash' ? 'Pay on delivery' : `Send to ${m.number || 'our account'}`,
  }));

  return sendList(
    phoneNumberId, userId,
    summary,
    '💳 Choose Payment',
    [{ title: 'Payment Methods', rows: payMethods }],
    '💳 *Select Payment*',
    `Estimated: ${config.delivery.estimatedMinutes} mins`
  );
}

// ─── Select Payment Method ─────────────────────────────────────────────────────
async function selectMethod({ session, methodId, userId, phoneNumberId }) {
  const method = config.payment.methods.find(m => m.id === methodId);
  if (!method) {
    return sendText(phoneNumberId, userId, `Payment method not found. Please choose again.`);
  }

  session.payment.method = method;
  session.payment.status = 'pending';
  sessionStore.save(session); // CRITICAL: save payment context before any further steps

  if (methodId === 'cash') {
    // Cash — no proof needed
    session.payment.status = 'verified';
    session.state = 'IDLE';
    sessionStore.save(session);
    return sendOrderConfirmation({ session, userId, phoneNumberId, paymentNote: 'Pay in cash on delivery.' });
  }

  // Mobile money — need proof
  session.state = 'AWAITING_PAYMENT_PROOF';
  sessionStore.save(session);

  const subtotal = cartTotal(session.currentOrder);
  const deliveryFee = session.orderType === 'delivery' && subtotal < config.delivery.freeAbove
    ? config.delivery.fee : 0;
  const total = subtotal + deliveryFee;

  const instructions = method.instructions
    .replace('{number}', method.number || '')
    .replace('{orderId}', session.payment.orderId);

  return sendButtons(phoneNumberId, userId,
    `💳 *Payment Instructions*\n${'─'.repeat(25)}\n${instructions}\n\n*Amount: ${formatCurrency(total)}*\nReference: *${session.payment.orderId}*\n\nAfter sending, please *upload your payment screenshot* here.`,
    [
      { id: 'action_resend_proof', title: '📷 Already Sent?' },
      { id: 'action_human',        title: '👤 Need Help' },
    ],
    null,
    '📸 Screenshot required'
  );
}

// ─── Main Payment Flow Handler (text) ─────────────────────────────────────────
async function handle({ session, parsed, userId, phoneNumberId, intent }) {
  const text = parsed.text || '';

  if (session.state === 'AWAITING_DELIVERY_ADDRESS') {
    return handleDeliveryAddress({ session, text, userId, phoneNumberId });
  }

  if (session.state === 'AWAITING_PAYMENT_METHOD') {
    // If they typed a payment method name
    const lower = text.toLowerCase();
    for (const m of config.payment.methods) {
      if (lower.includes(m.id) || lower.includes(m.name.toLowerCase())) {
        return selectMethod({ session, methodId: m.id, userId, phoneNumberId });
      }
    }
    return showOrderSummaryAndPayment({ session, userId, phoneNumberId });
  }

  if (session.state === 'AWAITING_PAYMENT_PROOF') {
    if (intent?.primary === 'PAYMENT_PROOF') {
      return promptResendProof({ session, userId, phoneNumberId });
    }
    return sendButtons(phoneNumberId, userId,
      `📸 We're waiting for your payment screenshot!\n\nOnce you've paid via *${session.payment.method?.name || 'mobile money'}*, please upload a screenshot of the confirmation here.`,
      [
        { id: 'action_resend_proof', title: '📷 How to Send' },
        { id: 'action_human',        title: '👤 Need Help' },
      ]
    );
  }

  if (session.state === 'CHECKOUT') {
    return startCheckout({ session, userId, phoneNumberId });
  }

  // Default
  return startCheckout({ session, userId, phoneNumberId });
}

// ─── Handle Delivery Address ───────────────────────────────────────────────────
async function handleDeliveryAddress({ session, text, userId, phoneNumberId }) {
  if (text.length < 5) {
    return sendText(phoneNumberId, userId,
      `Please share your full delivery address.\nExample: _"15 Pipeline Road, Bakau"_`
    );
  }
  session.deliveryAddress = text;
  sessionStore.save(session);
  return showOrderSummaryAndPayment({ session, userId, phoneNumberId });
}

// ─── Handle Proof Reminder ─────────────────────────────────────────────────────
async function handleProofReminder({ session, userId, phoneNumberId }) {
  if (!session.currentOrder.length) {
    return sendButtons(phoneNumberId, userId,
      `I don't see an active order. Would you like to start a new order? 😊`,
      [{ id: 'action_order', title: '📋 Start Ordering' }]
    );
  }

  if (session.payment.status === 'uploaded') {
    return sendText(phoneNumberId, userId,
      `✅ We already received your payment proof! We're verifying it now.\nOrder ID: *${session.payment.orderId}*\n\nExpected confirmation in ${config.payment.verificationTimeMinutes} minutes.`
    );
  }

  if (session.payment.status === 'pending') {
    return promptResendProof({ session, userId, phoneNumberId });
  }

  return startCheckout({ session, userId, phoneNumberId });
}

// ─── Prompt Resend Proof ──────────────────────────────────────────────────────
async function promptResendProof({ session, userId, phoneNumberId }) {
  session.state = 'AWAITING_PAYMENT_PROOF';
  sessionStore.save(session);

  return sendText(phoneNumberId, userId,
    `📸 *How to send payment proof:*\n\n1️⃣ Make your mobile money transfer\n2️⃣ Take a screenshot of the confirmation\n3️⃣ *Send the screenshot directly in this chat*\n\nWe'll verify and confirm your order within ${config.payment.verificationTimeMinutes} minutes.\n\nOrder ID: *${session.payment.orderId || 'N/A'}*`
  );
}

// ─── Handle Screenshot Upload (called from mediaFlow) ─────────────────────────
async function handleScreenshotUpload({ session, userId, phoneNumberId, mediaId }) {
  // CRITICAL FIX: Always check if there's an order — never say "no active order" 
  // if cart exists or payment context is pending
  const hasOrder = session.currentOrder.length > 0 || session.payment?.orderId;

  if (!hasOrder) {
    return sendButtons(phoneNumberId, userId,
      `Thanks for the screenshot! However, I don't see an active order linked to your account.\n\nWould you like to start a new order? 😊`,
      [{ id: 'action_order', title: '🛒 Start Order' }]
    );
  }

  // Update payment context
  session.payment.status = 'uploaded';
  session.payment.screenshotReceived = true;
  session.payment.uploadedAt = Date.now();
  session.payment.retryCount = (session.payment.retryCount || 0) + 1;
  session.state = 'AWAITING_PAYMENT_PROOF'; // Keep state active
  sessionStore.save(session); // CRITICAL: save immediately

  // Notify admin (fire-and-forget)
  notifyAdmin({ session, mediaId }).catch(e => logger.warn('Admin notify failed:', e.message));

  const orderId = session.payment.orderId || 'N/A';
  const total = cartTotal(session.currentOrder);

  return sendButtons(phoneNumberId, userId,
    `✅ *Payment screenshot received!*\n\nOrder ID: *${orderId}*\nAmount: *${formatCurrency(total)}*\n\nWe're verifying your payment now. You'll receive confirmation within *${config.payment.verificationTimeMinutes} minutes*.\n\n_If there are any issues, our team will contact you._`,
    [
      { id: 'action_track',  title: '📦 Track Order' },
      { id: 'action_human',  title: '👤 Contact Us' },
    ],
    null,
    '🕐 Verification in progress'
  );
}

// ─── Order Confirmation ────────────────────────────────────────────────────────
async function sendOrderConfirmation({ session, userId, phoneNumberId, paymentNote = '' }) {
  const orderId = session.payment.orderId || generateOrderId();
  const total = cartTotal(session.currentOrder);

  let msg = `🎉 *Order Confirmed!*\n\n`;
  msg += `Order ID: *${orderId}*\n`;
  msg += `Total: *${formatCurrency(total)}*\n`;
  if (session.orderType === 'delivery') {
    msg += `📍 ${session.deliveryAddress}\n`;
    msg += `⏱️ Estimated: ${config.delivery.estimatedMinutes} minutes\n`;
  }
  if (paymentNote) msg += `\n${paymentNote}`;
  msg += `\n\nThank you for ordering from *DreamLine Restaurant*! 😊🍽️`;

  return sendButtons(phoneNumberId, userId, msg,
    [
      { id: 'action_track',     title: '📦 Track Order' },
      { id: 'action_back_home', title: '🏠 Main Menu' },
    ]
  );
}

// ─── Admin Notification ────────────────────────────────────────────────────────
async function notifyAdmin({ session, mediaId }) {
  if (!config.contact.adminWhatsApp) return;
  const { sendText: st } = require('../services/waSender');
  const phoneNumberId = session.phoneNumberId;
  const adminId = config.contact.adminWhatsApp;
  const total = cartTotal(session.currentOrder);
  const items = session.currentOrder.map(i => `${i.qty}x ${i.name}`).join(', ');
  const msg = `🔔 *New Payment Proof*\nCustomer: ${session.contactName} (${session.userId})\nOrder: ${session.payment.orderId}\nItems: ${items}\nTotal: ${formatCurrency(total)}\nMedia ID: ${mediaId}`;
  await st(phoneNumberId, adminId, msg).catch(() => {});
}

module.exports = {
  handle, startCheckout, continueCheckout, selectMethod,
  handleProofReminder, promptResendProof, handleScreenshotUpload,
  sendOrderConfirmation,
};
