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
const DELIVERED_CONTEXT_WINDOW_MS = 2 * 60 * 60 * 1000;

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
    // ── Query: all non-terminal orders for this customer / tenant ─────────
    // Exclude orders that are definitively done and old:
    //   cancelled / completed / payment_failed older than 24h
    // Delivered orders within the last 2h are included so we can show context.
    //
    // [AUDIT-FIX-2] cutoff24h was declared but never wired into the query below —
    // every 'pending' order was treated as active forever, regardless of age. A
    // customer who started an order, abandoned it, and came back three weeks later
    // would still have that stale pending order intercept every new message
    // ("you have an active order...") instead of letting them start fresh. This is
    // the exact "stale pending+unpaid orders older than 24h" bug from past audits —
    // the fix was written (the cutoff variable) but never actually applied to the
    // query. 'pending' orders are now only considered active if created within the
    // last 24h; once past that window they're abandoned carts, not active orders,
    // and should not block new intents. Other non-terminal statuses (confirmed,
    // preparing, ready, out_for_delivery, payment verification states) are left
    // unbounded since those represent orders genuinely in progress in the real
    // world and a stale one is an admin/ops problem, not a "let the bot keep
    // nagging the customer" problem.
    const cutoff24h  = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activeOrders = await Order.find({
      customerPhone,
      tenantId,
      $or: [
        // [AUDIT-FIX-2] 'pending' bounded to last 24h — abandoned carts age out.
        { status: 'pending', createdAt: { $gte: cutoff24h } },
        // Genuinely in-progress statuses — no age bound.
        { status: { $in: ['payment_pending_verification', 'confirmed', 'preparing', 'ready', 'out_for_delivery'] } },
        // Delivered within the context window
        { status: 'delivered', updatedAt: { $gte: new Date(Date.now() - DELIVERED_CONTEXT_WINDOW_MS) } },
        // Rejected payments (order.status may be 'pending' after a reject+retry window)
        { paymentStatus: 'rejected' },
        // Proof submitted, still awaiting admin decision
        { paymentStatus: { $in: ['proof_received', 'payment_pending_verification'] } },
        // [AUDIT-FIX-AOR-QUERY-REJECT] Admin-rejected orders (see _resolveState's
        // `wasAdminRejected` below — status:'pending' + paymentStatus:'unpaid' +
        // paymentReviewedAt set is the real written signal for a rejection, since
        // rejectPayment() never writes the literal paymentStatus:'rejected'). The
        // clause above for the general 'pending' status is bounded to the last 24h
        // so abandoned carts age out — but that same bound was silently swallowing
        // rejected orders too: an admin who reviews/rejects an order more than 24h
        // after it was originally placed (routine — admins don't always respond
        // same-day) produces exactly this state, yet the order's `createdAt` is
        // already outside the window, so it never reached _resolveState at all and
        // a customer whose session expired afterward was routed to NO_ACTIVE_ORDER
        // instead of the "Payment Not Approved" card — the same bug FIX-AOR-REJECT
        // fixed downstream, but only for orders less than a day old. A rejection is
        // an explicit admin action awaiting the customer's retry or cancellation,
        // not an abandoned cart, so it must not be subject to the abandoned-cart
        // age bound at all.
        { status: 'pending', paymentStatus: 'unpaid', paymentReviewedAt: { $ne: null } },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(10)  // hard cap — no customer should have more than 10 unresolved orders
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
  // [AUDIT-FLOWS-9] Removed a dead `adminPhone` variable — none of the customer-facing
  // status cards built below surface the admin's phone number.
  const custName    = session?.customerName ? `, ${session.customerName}` : '';
  const shortId     = order.shortId || '???';
  const itemSummary = `*${order.item}* × ${order.quantity}`;
  const priceStr    = order.totalPrice ? `${currency}${order.totalPrice}` : null;

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

  // Priority 3 — Order confirmed (accepted), regardless of how payment was settled.
  // [AUDIT-AOR-CONFIRMED] Previously gated on `isPaymentVerified && status === 'confirmed'`,
  // where isPaymentVerified required paymentStatus to be one of
  // ['confirmed','self_confirmed','paid']. That excluded orders that are genuinely
  // confirmed-and-in-progress but never touch those paymentStatus values:
  //   - Cash orders accepted via AWAIT_ADMIN_CONFIRM (paymentStatus stays 'unpaid' —
  //     see adminCommandService.markOrderReady's FIX-MARK-READY-GUARD comment, which
  //     explicitly documents this state as reachable)
  //   - Orders confirmed via the dashboard PATCH endpoint (dashboardController
  //     updateOrderStatus), which sets status:'confirmed' without touching paymentStatus
  // Those orders matched the DB query above (status:'confirmed' is in the $in list) but
  // then fell through every priority branch here and resolved to NO_ACTIVE_ORDER —
  // silently disabling interception for a real in-progress order. status === 'confirmed'
  // is itself the authoritative "order accepted" signal; paymentStatus only changes which
  // wording the resolver would otherwise pick, not whether the order is active.
  if (status === 'confirmed') {
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
  const itemSummary = `*${order.item}* × ${order.quantity}`;
  const priceStr   = order.totalPrice ? `${currency}${order.totalPrice}` : null;

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
            description: 'Cancel all your pending and confirmed orders',
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
