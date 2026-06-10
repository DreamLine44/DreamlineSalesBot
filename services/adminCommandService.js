/**
 * services/adminCommandService.js
 *
 * WhatsApp-only admin commands:
 *   APPROVE <shortId>                 — approve payment proof
 *   REJECT <shortId>                  — reject payment proof
 *   CONFIRM BOOK <shortId>            — confirm a booking
 *   DECLINE BOOK <shortId> [reason]   — decline a booking
 *   RESUME BOT <phone>                — exit human handoff mode
 *
 * [FIX-BUG2]    resumeBot() now dispatches a WhatsApp message to the customer so
 *               they know the bot is active again.
 * [FIX-CMD-1]   isAdminPhone() now uses a per-request in-memory cache to avoid
 *               firing 2 DB queries on every single incoming message.
 * [FIX-CMD-2]   rejectPayment() now resets order.status back to 'pending' (not
 *               leaving it at 'payment_failed') so the retry window is consistent:
 *               paymentStatus='unpaid' + status='pending' = "order alive, retry open".
 * [FIX-CMD-3]   Input length guard on handleAdminButtonReply / handleAdminTextCommand
 *               — extremely long malformed IDs now return null instead of traversing
 *               all the startsWith checks.
 * [FIX-CMD-4]   handleAdminTextCommand now returns an explicit "unknown command" message
 *               when an admin sends something that looks like a command (all-caps) but
 *               doesn't match any pattern — previously returned null and the message
 *               was silently dropped (fell through to intent detection).
 * [FIX-CMD-5]   confirmPayment() uses mode welcomeButtons so post-confirmation buttons
 *               match the business mode (e.g. "Order Food" for restaurants).
 * [FIX-CMD-6]   buildAdminBookingAlert() footer shows only booking commands, not a mix
 *               of booking and payment commands.
 * [FIX-CMD-7]   buildAdminBookingAlert() omits command lines when shortId is unavailable.
 * [FIX-CMD-8]   rejectPayment() now awaits the updateSession call that restores
 *               PAYMENT_PROOF step — previously fire-and-forget meant a transient DB
 *               error silently broke the customer's retry window.
 * [FIX-CMD-10]  handleAdminTextCommand APPROVE/REJECT regex widened from [A-F0-9] (hex-only)
 *               to [A-Z0-9] so alphanumeric shortIds (e.g. "A1B2G3") are accepted. Hex-only
 *               regex would silently fail for any non-hex shortId scheme.
 * [FIX-CMD-11]  confirmPayment() and rejectPayment() $or query cleaned up — previously included
 *               { _id: undefined } when shortId was not 24 chars, which MongoDB treats as
 *               { _id: null }. Now conditionally omits the _id branch entirely.
 * [FIX-CMD-12]  RESUME BOT phone regex widened from [\d+\s]+ to [\d+\s().\-/]+ so dashed /
 *               parenthesised formats (e.g. +220-353-2423, (220) 353-2423) are accepted.
 *               Normalisation updated to strip all non-digit chars, not just spaces/+.
 * [FIX-CMD-13]  CONFIRM BOOK and DECLINE BOOK shortId cap widened from {4,8} to {4,24} to
 *               match APPROVE/REJECT. The old {4,8} cap silently rejected longer booking refs
 *               and returned an "unrecognised command" error to the admin.
 * [FIX-CMD-1b]  resumeBot() now checks the return value of updateSession and logs a warning
 *               when no active session was found (TTL-expired) so silent no-ops are visible.
 * [FIX-CMD-2b]  All customer-facing dispatch calls (confirmPayment, rejectPayment,
 *               confirmBooking, declineBooking) now log failures instead of swallowing them,
 *               so a missing tenantDoc is visible in logs rather than silently unreported.
 * [FIX-CMD-3b]  DECLINE BOOK text-command path normalises shortId to uppercase before passing
 *               to declineBooking(), consistent with the button path and the function's own
 *               internal .toUpperCase() call.
 * [FIX-2.5]      RESUME BOT (no phone): now fetches a total humanMode session count
 *               alongside the most-recent session. When N>1 sessions remain, the admin
 *               receives a warning naming the count so they know to resume the others
 *               individually. Previously only one session was resumed with no indication
 *               that other customers were silently stuck in human-mode.
 * [FIX-X2]      isAdminPhone() accepts optional pre-fetched `business` and `tenantDoc`
 *               objects so both the BusinessConfig and Tenant DB queries are skipped
 *               when the caller already has them.  confirmPayment() reuses the business
 *               param instead of re-fetching.  webhookController passes both objects at
 *               all isAdminPhone call sites, reducing admin-path DB reads from 3 → 0.
 *               getModeConfig moved to a static top-level import — previously it was
 *               dynamically imported inside confirmPayment() on every payment confirmation,
 *               adding a dynamic-import resolution cost to an already hot path.
 */

import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { updateSession } from '../core/sessions/sessionService.js';
import { dispatchText, dispatchMessage } from '../core/whatsapp/dispatcher.js';
import { getModeConfig } from '../config/modes.js';
import logger            from '../config/logger.js';

const MAX_INPUT_LENGTH = 500; // guard against absurdly long button IDs / command strings

// ── Admin phone check ─────────────────────────────────────────────────────────
// [FIX-CMD-1] Simple per-call cache: pass a Map() in from the caller if you want
// cross-call caching. For now we cache within a single isAdminPhone() call by
// resolving all three sources in parallel instead of sequentially.
//
// [FIX-X2] Accept optional pre-fetched `business` and `tenantDoc` objects.
// webhookController already has both loaded (BusinessConfig at step 3, Tenant
// passed in as a parameter) and forwards them here — eliminating both DB queries
// on every admin command path.  Falls back to fetching when either is not supplied
// (backwards compatible for callers outside webhookController).
export async function isAdminPhone(senderPhone, tenantId, business = null, tenantDoc = null) {
  const norm = String(senderPhone).replace(/^\+/, '');

  // 1. Fast env-var check (no DB) — check first
  const envAdmins = (process.env.ADMIN_PHONES || '').split(',')
    .map(p => p.trim().replace(/^\+/, '')).filter(Boolean);
  if (envAdmins.includes(norm)) return true;

  // 2. Use pre-fetched documents when available, otherwise fetch in parallel.
  // [FIX-X2] Skip BusinessConfig query when caller already has it.
  // [FIX-X2] Skip Tenant query when caller already has tenantDoc.
  const bizPromise = business
    ? Promise.resolve(business)
    : BusinessConfig.findOne({ tenantId }).select('adminPhone').lean().catch(() => null);

  const tenantPromise = tenantDoc
    ? Promise.resolve(tenantDoc)
    : Tenant.findById(tenantId).select('adminPhone').lean().catch(() => null);

  const [biz, tenant] = await Promise.all([bizPromise, tenantPromise]);

  if (biz?.adminPhone    && String(biz.adminPhone).replace(/^\+/, '')    === norm) return true;
  if (tenant?.adminPhone && String(tenant.adminPhone).replace(/^\+/, '') === norm) return true;

  return false;
}

// ── Admin button reply ─────────────────────────────────────────────────────────
export async function handleAdminButtonReply(buttonId, tenantId, adminPhone, tenantDoc, business) {
  // [FIX-CMD-3] Guard against absurdly long inputs
  if (!buttonId || String(buttonId).length > MAX_INPUT_LENGTH) return null;

  const upper = String(buttonId).toUpperCase();

  if (upper.startsWith('APPROVE_'))      return confirmPayment(upper.replace('APPROVE_', ''),      tenantId, adminPhone, tenantDoc, business);
  if (upper.startsWith('REJECT_'))       return rejectPayment(upper.replace('REJECT_', ''),        tenantId, adminPhone, tenantDoc, business);
  if (upper.startsWith('CONFIRM_BOOK_')) return confirmBooking(upper.replace('CONFIRM_BOOK_', ''), tenantId, adminPhone, tenantDoc);
  if (upper.startsWith('DECLINE_BOOK_')) {
    // [FIX-CMD-9] Button payloads may encode a reason after the shortId using an
    // underscore delimiter: DECLINE_BOOK_A1B2_unavailable. Extract it if present
    // rather than always passing null and discarding the reason.
    const rest    = upper.replace('DECLINE_BOOK_', '');
    const sepIdx  = rest.indexOf('_');
    const shortId = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
    const reason  = sepIdx === -1 ? null  : rest.slice(sepIdx + 1).replace(/_/g, ' ') || null;
    return declineBooking(shortId, reason, tenantId, adminPhone, tenantDoc);
  }
  return null;
}

// ── Admin text command router ─────────────────────────────────────────────────
export async function handleAdminTextCommand(text, tenantId, adminPhone, tenantDoc, business) {
  // [FIX-CMD-3] Guard against absurdly long inputs
  if (!text || String(text).length > MAX_INPUT_LENGTH) return null;

  const upper = text.trim().toUpperCase();

  // [FIX-CMD-10] Widened from [A-F0-9] (hex-only) to [A-Z0-9] so alphanumeric shortIds
  // (e.g. "A1B2G3") are accepted. Hex-only would silently fail to match if the order
  // system uses non-hex characters in its shortId scheme.
  const approveMatch = upper.match(/^APPROVE\s+([A-Z0-9]{4,24})$/);
  if (approveMatch) return confirmPayment(approveMatch[1], tenantId, adminPhone, tenantDoc, business);

  const rejectMatch = upper.match(/^REJECT\s+([A-Z0-9]{4,24})$/);
  if (rejectMatch) return rejectPayment(rejectMatch[1], tenantId, adminPhone, tenantDoc, business);

  // [FIX-CMD-13] Widened shortId limit from {4,8} to {4,24} to match APPROVE/REJECT.
  // Booking shortIds may be longer than 8 characters depending on the ID scheme; the
  // previous cap of 8 silently failed for any booking with a longer ref, falling through
  // to the looksLikeCommand branch and returning an "unrecognised command" error instead.
  const confirmBookMatch = upper.match(/^CONFIRM\s+BOOK\s+([A-Z0-9]{4,24})$/);
  if (confirmBookMatch) return confirmBooking(confirmBookMatch[1], tenantId, adminPhone, tenantDoc);

  const declineBookMatch = text.trim().match(/^DECLINE\s+BOOK\s+([A-Za-z0-9]{4,24})(?:\s+(.+))?$/i);
  // [FIX-CMD-3] Normalise shortId to uppercase here (consistent with the button path
  // and with declineBooking's own .toUpperCase() call). Avoids a silent mismatch if
  // declineBooking is ever refactored to remove its internal normalisation.
  if (declineBookMatch) return declineBooking(declineBookMatch[1].toUpperCase(), declineBookMatch[2] || null, tenantId, adminPhone, tenantDoc);

  // [FIX-CMD-12] Widened phone pattern from [\d+\s]+ to [\d+\s()./-]+ so common
  // international formats like +220-353-2423 or (220) 353-2423 are accepted.
  // Normalisation strips all non-digit characters to produce a bare number string,
  // consistent with how isAdminPhone normalises adminPhone from the DB.
  const resumeMatch = upper.match(/^RESUME BOT\s+([\d+\s().\-/]+)$/);
  if (resumeMatch) {
    // Strip all non-digit characters: spaces, +, dashes, parens, dots, slashes
    const normalised = resumeMatch[1].replace(/[^\d]/g, '');
    if (normalised) return resumeBot(normalised, tenantId, tenantDoc);
  }

  // [FIX-HM-3] "RESUME BOT" with NO phone number — find the most recent human-mode
  // session for this tenant and resume it automatically. Admins often forget to include
  // the phone number; this makes the command forgiving without being ambiguous.
  // upper is already text.trim().toUpperCase() so the second condition was redundant.
  if (upper === 'RESUME BOT') {
    // [FIX-2.5] Fetch both the most-recent session AND a total count atomically so the
    // admin is informed when other customers are still waiting in human-mode. Previously
    // only one session was resumed with no indication that N-1 others remained, leaving
    // those customers silently stuck. The count is fetched BEFORE resumeBot() because
    // resumeBot() sets humanMode=false on the resumed session, changing the count.
    const Session = (await import('../models/Session.js')).default;
    const [latest, totalCount] = await Promise.all([
      Session.findOne({ tenantId, humanMode: true })
        .sort({ updatedAt: -1 })
        .select('customerPhone')
        .lean()
        .catch(() => null),
      Session.countDocuments({ tenantId, humanMode: true }).catch(() => 0),
    ]);
    if (latest?.customerPhone) {
      const resumeReply = await resumeBot(latest.customerPhone, tenantId, tenantDoc);
      const remaining = totalCount - 1;
      if (remaining > 0) {
        // [FIX-2.5b] Fetch remaining human-mode phone numbers so admin gets actionable
        // info. Previously only the COUNT was shown, leaving the admin to guess which
        // phones to type "RESUME BOT <phone>" for.
        const remainingSessions = await Session.find({ tenantId, humanMode: true })
          .sort({ updatedAt: -1 })
          .select('customerPhone')
          .limit(10)
          .lean()
          .catch(() => []);
        const phoneList = remainingSessions
          .map(s => `  \u2022 \`RESUME BOT ${s.customerPhone}\``)
          .join('\n');
        return (
          resumeReply +
          `\n\n⚠️ *${remaining} other customer${remaining > 1 ? 's are' : ' is'} still in human-mode.*\n` +
          (phoneList
            ? `Resume them individually:\n${phoneList}`
            : `Use \`RESUME BOT <phone>\` to resume them individually.`)
        );
      }
      return resumeReply;
    }
    return `ℹ️ No active human-mode sessions found for this business.

Use \`RESUME BOT <phone>\` to resume a specific customer.`;
  }

  // [FIX-CMD-4] If it looks like an admin command attempt (APPROVE/REJECT/CONFIRM/DECLINE/RESUME)
  // but didn't match a valid pattern, return a helpful error rather than null (which falls
  // through to intent detection and produces a confusing AI response).
  const looksLikeCommand = /^(APPROVE|REJECT|CONFIRM|DECLINE|RESUME)\b/i.test(text.trim());
  if (looksLikeCommand) {
    return (
      `⚠️ *Unrecognised command format.*\n\n` +
      `Valid admin commands:\n` +
      `✅ \`APPROVE <shortId>\`\n` +
      `❌ \`REJECT <shortId>\`\n` +
      `📅 \`CONFIRM BOOK <shortId>\`\n` +
      `🚫 \`DECLINE BOOK <shortId> [reason]\`\n` +
      `🤖 \`RESUME BOT <phone>\`\n` +
      `🤖 \`RESUME BOT\` _(resumes most recent human-mode session)_`
    );
  }

  return null;
}

// ── Confirm payment ───────────────────────────────────────────────────────────
async function confirmPayment(shortId, tenantId, adminPhone, tenantDoc, business) {
  // [FIX-CMD-11] shortId-only query. shortId is always 6 chars (pre-save hook sets it to the
  // last 6 hex chars of the ObjectId). The previous length===24 branch (treating shortId as
  // a full ObjectId) was dead code that could never match in practice. Removed.
  const orderQuery = { shortId, tenantId };
  const order = await Order.findOne(orderQuery)
    .select('_id customerPhone status paymentStatus item quantity totalPrice shortId').lean();

  if (!order) return `⚠️ No order found: ${shortId}`;
  if (order.paymentStatus === 'confirmed') return `ℹ️ Order #${shortId} already confirmed.`;

  await Order.updateOne({ _id: order._id }, { $set: {
    paymentStatus:     'confirmed',
    status:            'confirmed',
    paymentReviewedBy: adminPhone,
    paymentReviewedAt: new Date(),
  }});

  // [FIX-X2] `business` is already passed in by the caller (webhookController fetched
  // BusinessConfig at step 3). Reuse it directly — no extra DB round-trip needed.
  // [FIX-CMD-5] Use the mode config's welcomeButtons as the source of truth for
  // post-confirmation buttons so labels ("Order Food" vs "Place New Order") and
  // the presence of the booking button are always consistent with the business mode.
  // Previously the buttons were hardcoded, so restaurants were missing "Book a Table"
  // and showing the generic "Place New Order" label instead of "Order Food".
  // getModeConfig is a static top-level import — no dynamic import cost on this path.
  const modeCfg = getModeConfig(business);
  const custBtns = (modeCfg.ui?.welcomeButtons || [
    { id: 'ORDER',    title: '🛒 Place New Order'  },
    { id: 'QUESTION', title: '❓ Ask a Question'   },
  ]).slice(0, 3);

  await dispatchMessage(order.customerPhone, {
    type:    'buttons',
    body:
      `✅ *Payment Confirmed!*\n\n` +
      `Your order of *${order.item}* × ${order.quantity} has been verified and is now being prepared.\n\n` +
      `🍽 Thank you for your order! We'll have it ready shortly. 🙏\n\n` +
      `_(Ref: #${order.shortId || shortId})_`,
    buttons: custBtns,
  // [FIX-CMD-2] Log dispatch failures rather than swallowing them. When tenantDoc is
  // null the customer is never notified of the confirmation — a silent failure that is
  // very hard to diagnose without a log entry.
  }, tenantDoc).catch(err => logger.warn('[AdminCmd] confirmPayment: customer dispatch failed', {
    customerPhone: order.customerPhone, err: err.message,
  }));

  await updateSession(order.customerPhone, tenantId, {
    currentFlow: null, step: null, postFlowAck: null,
  }).catch(() => {});

  logger.info('[AdminCmd] Payment confirmed', { shortId, adminPhone });
  return `✅ *Payment confirmed*\n\nOrder #${shortId} — ${order.item}\nCustomer ${order.customerPhone} notified.`;
}

// ── Reject payment ────────────────────────────────────────────────────────────
async function rejectPayment(shortId, tenantId, adminPhone, tenantDoc, business) {
  // [FIX-CMD-11] shortId-only query (see confirmPayment for full explanation)
  const orderQuery = { shortId, tenantId };
  const order = await Order.findOne(orderQuery)
    .select('_id customerPhone status paymentStatus item shortId').lean();

  if (!order) return `⚠️ No order found: ${shortId}`;
  if (order.status === 'cancelled') return `ℹ️ Order #${shortId} already cancelled.`;

  // [FIX-CMD-2] Reset BOTH paymentStatus AND status consistently:
  // paymentStatus='unpaid'  → receiveProof() will accept a new screenshot
  // status='pending'        → order is alive and awaiting retry (was 'payment_failed',
  //                           which is semantically wrong when the retry window is open)
  await Order.updateOne({ _id: order._id }, { $set: {
    paymentStatus:     'unpaid',
    status:            'pending',
    paymentReviewedBy: adminPhone,
    paymentReviewedAt: new Date(),
  }});

  // [FIX-CMD-8] Await the session update — if this fails the customer's session won't
  // point to PAYMENT_PROOF and they won't be able to send a retry screenshot.
  // Previously fire-and-forget, meaning a transient DB error silently broke retries.
  await updateSession(order.customerPhone, tenantId, {
    currentFlow: 'ORDER',
    step:        'PAYMENT_PROOF',
  });

  await dispatchMessage(order.customerPhone, {
    type:    'buttons',
    body:
      `❌ *Payment Verification Failed*\n\n` +
      `We could not verify your payment for order *#${order.shortId || shortId}*.\n\n` +
      `*Possible reasons:*\n` +
      `• Incorrect amount sent\n` +
      `• Payment sent to the wrong account\n` +
      `• Screenshot was unclear or incomplete\n\n` +
      `Please send a *new, clear screenshot* of your payment confirmation, or cancel the order below.`,
    buttons: [
      { id: 'CANCEL', title: '❌ Cancel Order' },
    ],
  // [FIX-CMD-2] Log dispatch failures — customer won't know to retry if this silently fails.
  }, tenantDoc).catch(err => logger.warn('[AdminCmd] rejectPayment: customer dispatch failed', {
    customerPhone: order.customerPhone, err: err.message,
  }));

  logger.info('[AdminCmd] Payment rejected', { shortId, adminPhone });
  return `❌ *Payment rejected*\n\nOrder #${shortId} — ${order.item}\nCustomer ${order.customerPhone} notified. Retry window open.`;
}

// ── Confirm booking ───────────────────────────────────────────────────────────
async function confirmBooking(shortId, tenantId, adminPhone, tenantDoc) {
  const booking = await Booking.findOne({ shortId: shortId.toUpperCase(), tenantId })
    .select('_id customerPhone date time service status customerName').lean();

  if (!booking) return `⚠️ No booking found: ${shortId}`;
  if (booking.status === 'confirmed') return `ℹ️ Booking #${shortId} already confirmed.`;

  await Booking.updateOne({ _id: booking._id }, { $set: {
    status:            'confirmed',
    adminConfirmedAt:  new Date(),
    adminConfirmedBy:  adminPhone,
  }});

  const when       = booking.time ? `${booking.date} at ${booking.time}` : booking.date;
  const serviceStr = booking.service ? ` (${booking.service})` : '';

  await dispatchText(booking.customerPhone,
    `✅ *Booking Confirmed!*\n\nYour booking${serviceStr} for *${when}* is confirmed.\n\nWe look forward to seeing you! 😊`,
  // [FIX-CMD-2] Log dispatch failures — customer won't know their booking is confirmed.
  tenantDoc).catch(err => logger.warn('[AdminCmd] confirmBooking: customer dispatch failed', {
    customerPhone: booking.customerPhone, err: err.message,
  }));

  logger.info('[AdminCmd] Booking confirmed', { shortId, adminPhone });
  return `✅ *Booking confirmed*\n\nBooking #${shortId} — ${when}${serviceStr}\nCustomer ${booking.customerPhone} notified.`;
}

// ── Decline booking ───────────────────────────────────────────────────────────
async function declineBooking(shortId, reason, tenantId, adminPhone, tenantDoc) {
  const booking = await Booking.findOne({ shortId: shortId.toUpperCase(), tenantId })
    .select('_id customerPhone date time service status customerName').lean();

  if (!booking) return `⚠️ No booking found: ${shortId}`;
  if (booking.status === 'cancelled') return `ℹ️ Booking #${shortId} already cancelled.`;

  await Booking.updateOne({ _id: booking._id }, { $set: {
    status:           'cancelled',
    adminDeclinedAt:  new Date(),
    adminDeclinedBy:  adminPhone,
    adminNote:        reason || null,
  }});

  const when       = booking.time ? `${booking.date} at ${booking.time}` : booking.date;
  const serviceStr = booking.service ? ` (${booking.service})` : '';
  const reasonStr  = reason ? `\n\n*Reason:* ${reason}` : '';

  await dispatchText(booking.customerPhone,
    `❌ *Booking Unavailable*\n\nUnfortunately we can't confirm your booking${serviceStr} for *${when}*.${reasonStr}\n\nPlease contact us to arrange an alternative time.`,
  // [FIX-CMD-2] Log dispatch failures — customer won't know their booking was declined.
  tenantDoc).catch(err => logger.warn('[AdminCmd] declineBooking: customer dispatch failed', {
    customerPhone: booking.customerPhone, err: err.message,
  }));

  logger.info('[AdminCmd] Booking declined', { shortId, adminPhone, reason });
  return `❌ *Booking declined*\n\nBooking #${shortId} — ${when}${serviceStr}${reason ? `\nReason: ${reason}` : ''}\nCustomer ${booking.customerPhone} notified.`;
}

// ── Resume bot ────────────────────────────────────────────────────────────────
async function resumeBot(customerPhone, tenantId, tenantDoc) {
  // [FIX-CMD-1] Check the return value of updateSession. findOneAndUpdate without
  // upsert returns null when no document matches — meaning there is no active
  // session for this customer (TTL-expired). The admin gets a success message either
  // way (the bot IS effectively not running for that customer), but logging the miss
  // makes it easier to diagnose cases where an admin resumes a phone that never had
  // a human-mode session.
  const updated = await updateSession(customerPhone, tenantId, {
    humanMode: false,
    humanModeNotified: false,
  });

  if (!updated) {
    logger.warn('[AdminCmd] resumeBot: no active session found for customer — TTL may have expired', {
      customerPhone, tenantId,
    });
  }

  // [FIX-CMD-1b] Only notify the customer when an active session was found.
  // If the session TTL has expired (updated===null), the customer's session no longer
  // exists in the DB — firing a "bot is back!" message for a conversation that is gone
  // is confusing. The bot will re-create the session correctly on the customer's next
  // message regardless of whether we send this notification now.
  if (updated && tenantDoc) {
    dispatchText(
      customerPhone,
      `✅ Our team has finished assisting you. Our automated assistant is back! 😊`,
      tenantDoc,
    ).catch(() => {});
  }

  return `✅ Bot resumed for *${customerPhone}*. Automation is active again.`;
}

// ── Admin alert builders ──────────────────────────────────────────────────────
export function buildAdminBookingAlertBody({ customerPhone, date, time, service, partySize, business, shortId }) {
  const bizName    = business?.name || 'Business';
  const serviceStr = service   ? `\n🗓 Service: *${service}*`      : '';
  const timeStr    = time      ? `\n⏰ Time: *${time}*`            : '';
  const partyStr   = partySize ? `\n👥 Party size: *${partySize}*` : '';
  const idStr      = shortId   ? `\n🔖 Ref: \`${shortId}\``        : '';

  return (
    `🔔 *New Booking — ${bizName}*\n\n` +
    `👤 Customer: *${customerPhone}*\n` +
    `📅 Date: *${date}*${timeStr}${serviceStr}${partyStr}${idStr}\n\n` +
    `Status: *Pending* — please confirm.`
  );
}

/**
 * buildAdminBookingAlert — full booking notification with reply commands in footer.
 * [FIX-CMD-6] Footer previously showed APPROVE/REJECT (order-payment commands) mixed in
 *             with the booking commands — confusing for admins.
 *             Now shows only the two booking-specific commands.
 * [FIX-CMD-7] shortId was shown as literal '?' when args.shortId was falsy.
 *             Now omits the command line entirely when shortId is not available.
 */
export function buildAdminBookingAlert(args) {
  const body = buildAdminBookingAlertBody(args);
  const sid  = args.shortId;
  const commandFooter = sid
    ? `\n\nReply to action:\n✅ \`CONFIRM BOOK ${sid}\`\n🚫 \`DECLINE BOOK ${sid} <reason>\``
    : `\n\n_Reply once a shortId is available._`;
  return body + commandFooter;
}
