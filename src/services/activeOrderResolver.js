/**
 * services/activeOrderResolver.js
 *
 * Single source of truth for "does this customer have an active order, and
 * if so, what should the bot say right now?"
 *
 * Called by webhookController at step 8.6 — BEFORE intent detection,
 * BEFORE AI responses, BEFORE welcome menus.
 *
 * Resolution priority (highest unresolved state wins):
 *   1. PAYMENT_REJECTED       — paymentStatus = 'rejected'
 *   2. PAYMENT_PENDING        — paymentStatus = 'proof_received' | 'payment_pending_verification'
 *   3. PAYMENT_VERIFIED       — paymentStatus in ['confirmed','self_confirmed','paid'] + status = 'confirmed'
 *   4. PREPARING              — status = 'preparing'
 *   5. READY                  — status = 'ready'
 *   6. OUT_FOR_DELIVERY       — status = 'out_for_delivery'
 *   7. DELIVERED (recent)     — status = 'delivered', delivered within past 2 hours
 *   8. MULTIPLE_ACTIVE_ORDERS — more than one unresolved active order found
 *   9. NO_ACTIVE_ORDER        — nothing to intercept
 *
 * Database is the source of truth. Session state is never consulted here.
 * This makes order context survive session TTL expiry, server restarts,
 * and human handoff resets.
 *
 * Returns:
 *   {
 *     order:           Order | null,
 *     orders:          Order[],        // all active orders found
 *     state:           string,         // one of the constants above
 *     shouldIntercept: boolean,        // true → skip normal routing
 *     uiResponse:      UIResponse | null,
 *   }
 */

import Order  from '../models/Order.js';
import logger from '../config/logger.js';
import { formatMoney } from '../utils/formatCurrency.js';
import { formatOrderItemSummary } from './orderService.js';
import {
  buildActiveOrderFilter,
  DELIVERED_CONTEXT_WINDOW_MS,
  expireStaleActivities,
} from './activityLifecycleService.js';

// ── Active order state constants ───────────────────────────────────────────────
export const ACTIVE_ORDER_STATES = {
  PAYMENT_REJECTED:       'PAYMENT_REJECTED',
  PAYMENT_PENDING:        'PAYMENT_PENDING',
  PAYMENT_VERIFIED:       'PAYMENT_VERIFIED',
  PREPARING:              'PREPARING',
  READY:                  'READY',
  OUT_FOR_DELIVERY:       'OUT_FOR_DELIVERY',
  DELIVERED:              'DELIVERED',
  MULTIPLE_ACTIVE_ORDERS: 'MULTIPLE_ACTIVE_ORDERS',
  NO_ACTIVE_ORDER:        'NO_ACTIVE_ORDER',
};

// How long after delivery do we still show a "your order was delivered" context
// rather than the normal welcome menu? Default 2 hours.
// Re-exported from activityLifecycleService for backward compatibility.
export { DELIVERED_CONTEXT_WINDOW_MS } from './activityLifecycleService.js';

/**
 * resolveActiveOrder
 *
 * @param {string} customerPhone
 * @param {string|ObjectId} tenantId
 * @param {object} business  — BusinessConfig lean doc (for currency, adminPhone, etc.)
 * @param {object} session   — current session (for customerName)
 * @returns {Promise<{order, orders, state, shouldIntercept, uiResponse}>}
 */
export async function resolveActiveOrder(customerPhone, tenantId, business = null, session = null) {
  try {
    await expireStaleActivities(customerPhone, tenantId);

    const activeOrders = await Order.find(buildActiveOrderFilter(customerPhone, tenantId))
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    if (!activeOrders.length) {
      return _noActiveOrder();
    }

    // ── Multiple active orders ─────────────────────────────────────────────
    if (activeOrders.length > 1) {
      return _multipleOrders(activeOrders, business);
    }

    // ── Single active order — resolve state ───────────────────────────────
    const order = activeOrders[0];
    return _resolveState(order, business, session);

  } catch (err) {
    logger.warn('[ActiveOrderResolver] DB error — falling through to normal routing', {
      customerPhone, err: err.message,
    });
    return _noActiveOrder();
  }
}

// ── State resolution ──────────────────────────────────────────────────────────

function _resolveState(order, business, session) {
  const { paymentStatus, status, updatedAt } = order;

  const currency    = business?.payment?.currency || 'D';
  const adminPhone  = business?.adminPhone || null;
  const custName    = session?.customerName ? `, ${session.customerName}` : '';
  const shortId     = order.shortId || '???';
  const itemSummary = formatOrderItemSummary(order);
  const priceStr    = order.totalPrice ? `${currency}${formatMoney(order.totalPrice)}` : null;

  // Priority 1 — Rejected payment
  // [FIX-AOR-REJECT] paymentStatus === 'rejected' is checked for forward-compat,
  // but no code path in this codebase actually writes that literal value.
  // adminCommandService.rejectPayment() intentionally writes
  // { status: 'pending', paymentStatus: 'unpaid', paymentReviewedAt: <Date> } instead —
  // 'unpaid' is required so paymentService.receiveProof() will accept the customer's
  // retry screenshot (it specifically queries paymentStatus:'unpaid'). That means this
  // branch — and the "Payment Not Approved" card with the rejection reason and
  // RESEND_PROOF button — was unreachable through the real rejection flow: a customer
  // whose session expired (TTL) after a rejection and returned later got silently routed
  // to NO_ACTIVE_ORDER instead, losing all context including rejectedNote. paymentReviewedAt
  // is only ever set by confirmPayment (which moves status/paymentStatus away from
  // pending/unpaid) and rejectPayment, so `pending + unpaid + paymentReviewedAt set` is an
  // unambiguous signal that this specific order was administratively rejected and is
  // awaiting a retry.
  const wasAdminRejected = status === 'pending' && paymentStatus === 'unpaid' && !!order.paymentReviewedAt;
  if (paymentStatus === 'rejected' || wasAdminRejected) {
    const reason = order.rejectedNote || null;
    return {
      order, orders: [order],
      state: ACTIVE_ORDER_STATES.PAYMENT_REJECTED,
      shouldIntercept: true,
      uiResponse: {
        type: 'buttons',
        body:
          `❌ *Payment Not Approved*\n\n` +
          `Order *#${shortId}* — ${itemSummary}` +
          (priceStr ? `\n💰 Amount: *${priceStr}*` : '') +
          (reason ? `\n\n*Reason:* ${reason}` : `\n\n_Please contact us for more details._`) +
          `\n\nWhat would you like to do?`,
        buttons: [
          { id: 'RESEND_PROOF', title: '📸 Upload New Proof' },
          { id: 'SUPPORT',      title: '💬 Contact Business' },
          { id: 'CANCEL',       title: '❌ Cancel Order'     },
        ],
      },
    };
  }

  // Priority 2 — Payment proof submitted, awaiting admin verification
  if (paymentStatus === 'proof_received' || paymentStatus === 'payment_pending_verification') {
    const submittedAt = order.proofReceivedAt
      ? _formatDate(order.proofReceivedAt)
      : null;
    return {
      order, orders: [order],
      state: ACTIVE_ORDER_STATES.PAYMENT_PENDING,
      shouldIntercept: true,
      uiResponse: {
        type: 'buttons',
        body:
          `⏳ *Payment Under Review*\n\n` +
          `Order *#${shortId}* — ${itemSummary}` +
          (priceStr ? `\n💰 Amount: *${priceStr}*` : '') +
          (submittedAt ? `\n📅 Screenshot received: *${submittedAt}*` : '') +
          `\n\nOur team is reviewing your payment. We'll notify you once it's confirmed. 🙏`,
        buttons: [
          { id: 'TRACK_ORDER', title: '🔍 Check Status'    },
          { id: 'SUPPORT',     title: '💬 Contact Business'},
        ],
      },
    };
  }

  // Priority 3 — Payment confirmed, order being processed
  const isPaymentVerified = ['confirmed', 'self_confirmed', 'paid'].includes(paymentStatus);
  if (isPaymentVerified && status === 'confirmed') {
    return {
      order, orders: [order],
      state: ACTIVE_ORDER_STATES.PAYMENT_VERIFIED,
      shouldIntercept: true,
      uiResponse: _preparingCard(order, business, session, 'confirmed'),
    };
  }

  // Priority 4 — Preparing
  if (status === 'preparing') {
    return {
      order, orders: [order],
      state: ACTIVE_ORDER_STATES.PREPARING,
      shouldIntercept: true,
      uiResponse: _preparingCard(order, business, session, 'preparing'),
    };
  }

  // Priority 5 — Ready
  if (status === 'ready') {
    return {
      order, orders: [order],
      state: ACTIVE_ORDER_STATES.READY,
      shouldIntercept: true,
      uiResponse: {
        type: 'buttons',
        body:
          `✅ *Your order is ready${custName}!*\n\n` +
          `Order *#${shortId}* — ${itemSummary}` +
          (priceStr ? `\n💰 Amount: *${priceStr}*` : '') +
          `\n\nPlease come collect at the counter! 😊`,
        // [FIX-READY-CARD] COLLECTED_ button lets customer confirm pickup in one tap.
        // Previously only 'Contact Business' and 'Order Again' were shown — no way to
        // acknowledge collection, so orders stayed in 'ready' state forever in the DB.
        buttons: [
          { id: shortId ? `COLLECTED_${shortId}` : 'SUPPORT', title: '✅ Collected — Thanks!' },
          { id: 'SUPPORT', title: '💬 Contact Business' },
        ],
      },
    };
  }

  // Priority 6 — Out for delivery
  if (status === 'out_for_delivery') {
    return {
      order, orders: [order],
      state: ACTIVE_ORDER_STATES.OUT_FOR_DELIVERY,
      shouldIntercept: true,
      uiResponse: {
        type: 'buttons',
        body:
          `🚗 *Your order is on its way${custName}!*\n\n` +
          `Order *#${shortId}* — ${itemSummary}` +
          `\n\nSit tight — your delivery is en route! 🙏`,
        buttons: [
          { id: 'SUPPORT', title: '💬 Contact Business' },
          { id: 'ORDER',   title: '🛒 Order Again'      },
        ],
      },
    };
  }

  // Priority 7 — Delivered (within context window)
  if (status === 'delivered') {
    const deliveredAt = updatedAt ? new Date(updatedAt) : null;
    const withinWindow = deliveredAt
      ? (Date.now() - deliveredAt.getTime()) < DELIVERED_CONTEXT_WINDOW_MS
      : false;
    if (withinWindow) {
      return {
        order, orders: [order],
        state: ACTIVE_ORDER_STATES.DELIVERED,
        shouldIntercept: true,
        uiResponse: {
          type: 'buttons',
          body:
            `🎉 *Your order has been delivered${custName}!*\n\n` +
            `Order *#${shortId}* — ${itemSummary}\n\n` +
            `Thank you for ordering with us! We hope you enjoy it. 😊`,
          buttons: [
            { id: 'ORDER',   title: '🛒 Order Again'     },
            { id: 'SUPPORT', title: '💬 Contact Business' },
          ],
        },
      };
    }
  }

  return _noActiveOrder();
}

// ── UI builders ───────────────────────────────────────────────────────────────

function _preparingCard(order, business, session, stage) {
  const currency   = business?.payment?.currency || 'D';
  const custName   = session?.customerName ? `, ${session.customerName}` : '';
  const shortId    = order.shortId || '???';
  const itemSummary = formatOrderItemSummary(order);
  const priceStr   = order.totalPrice ? `${currency}${formatMoney(order.totalPrice)}` : null;

  const statusLine = stage === 'preparing'
    ? `🟡 Status: *Preparing*`
    : `✅ Status: *Payment Confirmed*`;

  return {
    type: 'buttons',
    body:
      `👋 *Welcome back${custName}!*\n\n` +
      `Your order *#${shortId}* is currently in progress.\n\n` +
      `🍽 ${itemSummary}` +
      (priceStr ? `\n💰 *${priceStr}*` : '') +
      `\n${statusLine}\n\n` +
      `We'll notify you when it's ready. 🙏`,
    buttons: [
      { id: 'TRACK_ORDER', title: '🔍 Track Order'      },
      { id: 'ORDER',       title: '🛒 Order Again'      },
      { id: 'SUPPORT',     title: '💬 Contact Business' },
    ],
  };
}

function _multipleOrders(orders, business) {
  // [FIX-LIST-LIMIT] WhatsApp enforces a hard cap of 10 rows across ALL sections
  // in a single list message. We always include a CANCEL_ALL action row (1 row),
  // so order rows must be capped at 9. With .limit(10) in the query, up to 10 orders
  // can come back — the 10th would push the total to 11, causing Meta to reject the
  // entire message with a 400 error and silently drop the response to the customer.
  const MAX_ORDER_ROWS = 9;
  const displayOrders = orders.slice(0, MAX_ORDER_ROWS);

  const rows = displayOrders.map(o => ({
    id:          `ORDER_STATUS_${o.shortId || String(o._id).slice(-6).toUpperCase()}`,
    title:       `#${o.shortId || '???'} — ${(o.item || 'Order').slice(0, 24)}`,
    description: `${_statusLabel(o.status)} · ${_paymentLabel(o.paymentStatus)}`,
  }));

  const overflowNote = orders.length > MAX_ORDER_ROWS
    ? ` _(showing ${MAX_ORDER_ROWS} of ${orders.length})_`
    : '';

  return {
    order:  orders[0],
    orders,
    state:  ACTIVE_ORDER_STATES.MULTIPLE_ACTIVE_ORDERS,
    shouldIntercept: true,
    uiResponse: {
      type: 'list',
      body: `📦 You have *${orders.length} active orders*.${overflowNote}\n\nWhich one would you like to check?`,
      // [FIX-AOR-BTNLABEL] Was 'buttonText' — the dispatcher's list builder only reads
      // ui.button / ui.buttonLabel (see core/whatsapp/dispatcher.js), so this custom
      // label was silently ignored and every multiple-orders list rendered with the
      // generic 'Choose option' fallback instead of 'View My Orders'.
      button: 'View My Orders',
      sections: [
        {
          title: 'Active Orders',
          rows,
        },
        {
          title: 'Actions',
          rows: [{
            id:          'CANCEL_ALL',
            title:       '❌ Cancel All Orders',
            description: 'Cancel all your active orders and bookings',
          }],
        },
      ],
    },
  };
}

function _noActiveOrder() {
  return {
    order:  null,
    orders: [],
    state:  ACTIVE_ORDER_STATES.NO_ACTIVE_ORDER,
    shouldIntercept: false,
    uiResponse: null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _formatDate(date) {
  try {
    const d  = new Date(date);
    const dd = String(d.getDate()).padStart(2, '0');
    const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${dd} ${mo} ${hh}:${mm}`;
  } catch {
    return null;
  }
}

function _statusLabel(status) {
  const MAP = {
    pending:                     'Pending',
    payment_pending_verification:'Awaiting Payment',
    confirmed:                   'Confirmed',
    preparing:                   'Preparing',
    ready:                       'Ready',
    out_for_delivery:            'Out for Delivery',
    delivered:                   'Delivered',
    completed:                   'Completed',
    cancelled:                   'Cancelled',
    rejected:                    'Rejected',
    payment_failed:              'Payment Failed',
  };
  return MAP[status] || status || 'Unknown';
}

function _paymentLabel(paymentStatus) {
  const MAP = {
    unpaid:                      'Unpaid',
    proof_received:              'Screenshot received',
    payment_pending_verification:'Under review',
    self_confirmed:              'Self-confirmed',
    confirmed:                   'Payment confirmed',
    paid:                        'Paid',
    rejected:                    'Payment rejected',
    payment_failed:              'Payment failed',
    cancelled:                   'Cancelled',
    refunded:                    'Refunded',
  };
  return MAP[paymentStatus] || paymentStatus || '';
}
