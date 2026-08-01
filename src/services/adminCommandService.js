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
 * [FIX-CMD-14]  confirmPayment / rejectPayment / confirmBooking / declineBooking now use a
 *               single atomic findOneAndUpdate (guard condition baked into the filter)
 *               instead of a separate findOne-then-updateOne pair. This closes:
 *                 - a TOCTOU race where a double-tapped admin button (slow network,
 *                   impatience) could fire two concurrent calls that both pass the old
 *                   in-memory guard check before either write landed, sending the
 *                   customer duplicate notifications and double-running session/analytics
 *                   updates.
 *                 - a state-machine gap where confirmPayment only checked paymentStatus
 *                   (not status), so an already-cancelled/rejected order could be
 *                   resurrected by APPROVE; and rejectPayment only checked status (not
 *                   paymentStatus), so an already-confirmed order could be reverted by
 *                   REJECT. Both guards now check both fields.
 *               rejectPayment's cash-order branch no longer writes status='pending' and
 *               then immediately overwrites it to 'cancelled' — the AWAIT_ADMIN_CONFIRM
 *               session check now runs before any write, so the correct final state is
 *               written exactly once.
 * [FIX-CMD-15]  confirmPayment / rejectPayment / confirmBooking / declineBooking are now
 *               wrapped in try/catch. Previously an unguarded Order/Booking/updateSession
 *               call that threw (e.g. a transient DB error) propagated up through
 *               webhookController's `.catch(() => null)`, so the admin's button tap
 *               produced ZERO response — no success message, no error, nothing. Now every
 *               failure path returns an explicit "something went wrong" message so the
 *               admin always knows the outcome, consistent with [FIX-CMD-4]'s original
 *               "never silently drop an admin message" intent.
 * [FIX-CMD-16]  Removed buildAdminBookingAlert() — dead code. It was exported but never
 *               called; the real caller (bookingFlow.js) uses buildAdminBookingAlertBody()
 *               directly and builds its own interactive-buttons array, which is correct
 *               since admin booking alerts are sent as WhatsApp button messages, not plain
 *               text with typed commands in the footer.
 */

import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { updateSession } from '../core/sessions/sessionService.js';
import { dispatchText, dispatchMessage } from '../core/whatsapp/dispatcher.js';
import { getModeConfig } from '../config/modes.js';
import logger            from '../config/logger.js';
import { formatMoney }   from '../utils/formatCurrency.js';
import { buildOptionsReply } from '../core/shared/uiOptionsHelper.js';

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
  if (upper.startsWith('READY_'))        return markOrderReady(upper.replace('READY_', ''),        tenantId, adminPhone, tenantDoc, business);
  // [FIX-X3] RESUME_BOT_<phone> button — dispatched by the support escalation alert
  // as an interactive button instead of a plain-text `RESUME BOT <phone>` command.
  // Strip all non-digit chars from the phone suffix to match resumeBot()'s normalisation.
  if (upper.startsWith('RESUME_BOT_')) {
    const rawPhone = String(buttonId).slice('RESUME_BOT_'.length);
    const normalised = rawPhone.replace(/[^\d]/g, '');
    if (normalised) return resumeBot(normalised, tenantId, tenantDoc);
  }
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

  // [SPEC-5A] MARK READY <shortId> — notify customer their order is ready for collection
  const markReadyMatch = upper.match(/^MARK\s+READY\s+([A-Z0-9]{4,24})$/);
  if (markReadyMatch) return markOrderReady(markReadyMatch[1], tenantId, adminPhone, tenantDoc, business);

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
        // [FIX-RESUME-NOPHONE-BTN] Previously this returned a plain-text list of
        // backtick `RESUME BOT <phone>` commands the admin had to read and re-type —
        // the exact copy-paste UX the single-customer RESUME_BOT_<phone> button (set
        // in moduleRouter's SUPPORT escalation) was built to avoid. Now matches that
        // same one-tap pattern: ≤3 remaining customers get inline buttons, more than
        // that get a tappable list (WhatsApp's interactive caps), each row resolving
        // straight to resumeBot() via the existing RESUME_BOT_ admin-button guard in
        // webhookController — no typing required either way.
        const introText =
          resumeReply +
          `\n\n⚠️ *${remaining} other customer${remaining > 1 ? 's are' : ' is'} still in human-mode.*\n` +
          `Tap a customer below to resume them:`;
        if (remainingSessions.length <= 3) {
          return {
            type:    'buttons',
            body:    introText,
            buttons: remainingSessions.map(s => ({
              id:    `RESUME_BOT_${s.customerPhone.replace(/[^0-9+]/g, '')}`,
              title: `▶️ ${s.customerPhone}`.slice(0, 20),
            })),
          };
        }
        return {
          type:   'list',
          body:   introText,
          button: 'Resume a customer',
          sections: [{
            title: 'Human-mode customers',
            rows:  remainingSessions.map(s => ({
              id:          `RESUME_BOT_${s.customerPhone.replace(/[^0-9+]/g, '')}`,
              title:       s.customerPhone.slice(0, 24),
              description: 'Tap to resume the bot for this customer',
            })),
          }],
        };
      }
      return resumeReply;
    }
    return `ℹ️ No active human-mode sessions found for this business.

Use \`RESUME BOT <phone>\` to resume a specific customer.`;
  }

  // [FIX-CMD-4] If it looks like an admin command attempt (APPROVE/REJECT/CONFIRM/DECLINE/RESUME/MARK)
  // but didn't match a valid pattern, return a helpful error rather than null (which falls
  // through to intent detection and produces a confusing AI response).
  const looksLikeCommand = /^(APPROVE|REJECT|CONFIRM|DECLINE|RESUME|MARK)\b/i.test(text.trim());
  if (looksLikeCommand) {
    return (
      `⚠️ *Unrecognised command format.*\n\n` +
      `Valid admin commands:\n` +
      `✅ \`APPROVE <shortId>\`\n` +
      `❌ \`REJECT <shortId>\`\n` +
      `📅 \`CONFIRM BOOK <shortId>\`\n` +
      `🚫 \`DECLINE BOOK <shortId> [reason]\`\n` +
      `🍽️ \`MARK READY <shortId>\` _(notify customer to collect)_\n` +
      `🤖 \`RESUME BOT <phone>\`\n` +
      `🤖 \`RESUME BOT\` _(resumes most recent human-mode session)_`
    );
  }

  return null;
}

// ── Confirm payment ───────────────────────────────────────────────────────────
async function confirmPayment(shortId, tenantId, adminPhone, tenantDoc, business) {
  try {
    // [FIX-CMD-11] shortId-only query. shortId is always 6 chars (pre-save hook sets it to the
    // last 6 hex chars of the ObjectId). The previous length===24 branch (treating shortId as
    // a full ObjectId) was dead code that could never match in practice. Removed.
    //
    // [FIX-CMD-14] Read-then-write replaced with a single atomic findOneAndUpdate whose
    // filter bakes in the state guard (paymentStatus/status not already terminal). This
    // closes two bugs at once:
    //   - TOCTOU race: two near-simultaneous APPROVE taps (double-tap, slow network retry)
    //     could previously both pass the separate `findOne` guard check before either
    //     `updateOne` landed, sending the customer two "Payment Confirmed!" messages and
    //     running the session/analytics update twice. The DB-level filter now means only
    //     one concurrent call can match and write; the loser sees order=null after the
    //     fact and returns the "already confirmed" message instead.
    //   - State-machine gap: previously only `paymentStatus === 'confirmed'` blocked a
    //     re-confirm. An order already `status: 'cancelled'` or `'rejected'` (e.g. the
    //     admin rejected it, or the customer cancelled) could still be APPROVEd, silently
    //     resurrecting a dead order and telling the customer their cancelled order is
    //     "now being prepared". The filter now also excludes cancelled/rejected orders.
    const order = await Order.findOneAndUpdate(
      {
        shortId, tenantId,
        paymentStatus: { $ne: 'confirmed' },
        status:        { $nin: ['cancelled', 'rejected'] },
      },
      { $set: {
        paymentStatus:     'confirmed',
        status:            'confirmed',
        paymentReviewedBy: adminPhone,
        paymentReviewedAt: new Date(),
        // [FIX-32] Clear abandonedCartAt on confirmation so the scheduler abandoned-cart
        // job doesn't send a nudge for an order that has already been confirmed and paid.
        abandonedCartAt:   null,
      }},
      { new: false } // need the pre-update doc for item/quantity/customerPhone
    ).select('_id customerPhone status paymentStatus item quantity totalPrice shortId').lean();

    if (!order) {
      // Either no such order, or it failed the state guard. Disambiguate for the admin.
      const existing = await Order.findOne({ shortId, tenantId })
        .select('status paymentStatus').lean().catch(() => null);
      if (!existing) return `⚠️ No order found: ${shortId}`;
      if (existing.paymentStatus === 'confirmed') return `ℹ️ Order #${shortId} already confirmed.`;
      return `⚠️ Order #${shortId} can't be confirmed — current status is *${existing.status}*.`;
    }

    // [FIX-AWAIT] Check if this is a cash order (AWAIT_ADMIN_CONFIRM) so we can
    // send the right confirmation message — "order confirmed" instead of "payment verified".
    const { getSession: _getSession } = await import('../core/sessions/sessionService.js');
    const custSession2 = await _getSession(order.customerPhone, tenantId).catch(() => null);
    const isCashConfirm = custSession2?.step === 'AWAIT_ADMIN_CONFIRM';

    // [FIX-CONFIRM-BTN] Plain text only on the initial confirmation — no welcome buttons.
    // Showing "Order Food / Book a Table" immediately after "your order is being prepared"
    // is premature and confusing. The customer hasn't received their current order yet.
    // postFlowAck='ORDER_CONFIRMED' (set below) ensures any follow-up message they send
    // (thanks, question, complaint) gets contextual buttons at that point instead.
    //
    // [SPEC-3A] Message format aligned to communication design spec:
    //   - Title: Payment Confirmed / Order Confirmed
    //   - Payment verified line
    //   - Order item + reference on separate lines
    //   - Kitchen preparing + estimated time
    //   - Will message when ready
    //   - Thank-you sign-off
    //   - NO buttons (state → PREPARING, customer should wait)
    const bizName = business?.name || 'us';
    // [FIX-ETA] Use business.settings.estimatedDeliveryMinutes if configured (mirrors postFlowHandler
    // [PFH-3]). Previously hardcoded "20–30 minutes" — wrong for bakeries, salons, retail etc.
    const etaMins = business?.settings?.estimatedDeliveryMinutes;
    // [CLEANUP] etaLine removed — superseded by etaLineToShow below (FIX-SALON-18), was dead code.
    // [FIX-SALON-18] Mode-aware order confirmation message. Previously hardcoded
    // "🍳 Our kitchen is now preparing your order" for ALL business modes — wrong
    // for salon/barbershop/retail where there is no kitchen. Now uses a generic
    // "we're preparing your order" for non-food modes. Also drop the hardcoded
    // ETA fallback "20-30 minutes" for modes where it's meaningless — instead show
    // the configured estimatedDeliveryMinutes or omit the ETA line entirely.
    const _mode       = (business?.businessMode || 'RESTAURANT').toUpperCase();
    const _isFoodMode = ['RESTAURANT', 'BAKERY', 'DELIVERY'].includes(_mode);
    const preparingLine = _isFoodMode
      ? `🍳 Our kitchen is now preparing your order.\n`
      : `🛍️  We're preparing your order.\n`;
    const etaLineToShow = etaMins
      ? `⏱️  Estimated time: ${etaMins} minutes.\n\n`
      : (_isFoodMode ? `⏱️  Estimated time: 20–30 minutes.\n\n` : `\n`);

    const confirmBody = isCashConfirm
      ? `✅ *Order Confirmed!*\n\n` +
        `Your order has been accepted.\n\n` +
        `📦  Order: *${order.item}* × ${order.quantity}\n` +
        `🔖  Reference: #${order.shortId || shortId}\n\n` +
        preparingLine +
        etaLineToShow +
        `We'll message you the moment it's ready.\n\n` +
        `Thank you for choosing *${bizName}* 😊`
      : `✅ *Payment Confirmed!*\n\n` +
        `Your payment has been verified.\n\n` +
        `📦  Order: *${order.item}* × ${order.quantity}\n` +
        `🔖  Reference: #${order.shortId || shortId}\n\n` +
        preparingLine +
        etaLineToShow +
        `We'll message you the moment it's ready.\n\n` +
        `Thank you for choosing *${bizName}* 😊`;
    await dispatchMessage(order.customerPhone, {
      type: 'text',
      body: confirmBody,
    // [FIX-CMD-2] Log dispatch failures rather than swallowing them.
    }, tenantDoc).catch(err => logger.warn('[AdminCmd] confirmPayment: customer dispatch failed', {
      customerPhone: order.customerPhone, err: err.message,
    }));

    // [FIX-POST] Set postFlowAck=ORDER_CONFIRMED so subsequent customer messages
    // (thanks, complaint, question) are handled with the right order context.
    // [FIX-AOR-5] Also clear lastAorInterceptAt so the resolver can fire correctly
    // on the FIRST message after postFlowAck is consumed.
    await updateSession(order.customerPhone, tenantId, {
      currentFlow: null, step: null,
      postFlowAck:  'ORDER_CONFIRMED',
      postFlowData: { item: order.item, quantity: order.quantity, shortId: order.shortId || shortId },
      lastAorInterceptAt: null,
    }).catch(() => {});

    // [PFH-5 / MEM-FIX-1] Record confirmed order in customer memory — only fires on
    // actual admin confirmation, not on saveOrder(), so memory reflects real completed
    // orders rather than all abandoned attempts.
    import('../core/memory/customerMemory.js')
      .then(m => m.recordConfirmedOrder(order.customerPhone, String(tenantId), order.item))
      .catch(() => {});

    // [AUDIT-FIX-4] recordRevenue() was previously called by every module at the moment
    // saveOrder() succeeded — i.e. before any payment was verified. An order that was
    // later rejected by the admin or self-cancelled by the customer had already been
    // counted as revenue, permanently inflating the dashboard's "last30Days.revenue"
    // figure with money that was never actually received. This mirrors the exact
    // double-counting class already fixed for stats.totalOrders (see MEM-FIX-1 above) —
    // recordOrderItem() there was split into "placed" vs "confirmed" counting so
    // totalOrders only reflects real completed orders, but the analogous fix was never
    // applied to revenue. Moving the single recordRevenue() call here — the one place
    // that runs only once, only on an admin-approved payment (proof-verified or cash
    // self-confirm both funnel through this function) — makes revenue reflect money
    // actually confirmed, consistent with how totalOrders is already counted.
    if (order.totalPrice) {
      import('../core/analytics/analyticsService.js')
        .then(m => m.recordRevenue({
          item:          order.item,
          quantity:      order.quantity,
          revenue:       order.totalPrice,
          tenantId,
          customerPhone: order.customerPhone,
          phoneNumberId: business?.phoneNumberId || null,
        }))
        .catch(() => {});
    }

    logger.info('[AdminCmd] Payment confirmed', { shortId, adminPhone });
    // [FIX-READY-BTN] Return a button message to the admin instead of plain text.
    // Previously the admin got "✅ Payment confirmed" as plain text with no next action.
    // They had to remember to type "MARK READY <shortId>" later — a step many admins
    // missed or forgot. Now they get a READY_ button immediately so marking the order
    // ready for collection is a single tap, consistent with the APPROVE_/REJECT_ UX.
    await dispatchMessage(adminPhone, {
      type:    'buttons',
      body:    `✅ *Payment confirmed*\n\nOrder #${shortId} — ${order.item}\nCustomer ${order.customerPhone} has been notified.\n\nTap below when the order is ready for collection:`,
      buttons: [
        { id: `READY_${order.shortId || shortId}`, title: '🍽️ Mark Order Ready' },
      ],
    }, tenantDoc).catch(err => logger.warn('[AdminCmd] confirmPayment: admin READY button dispatch failed', {
      adminPhone, err: err.message,
    }));
    return null; // already dispatched via dispatchMessage — webhookController checks for null
  } catch (err) {
    // [FIX-CMD-15] Previously any thrown error here (DB hiccup etc.) propagated up to
    // webhookController's `.catch(() => null)`, producing ZERO response to the admin —
    // they tap APPROVE and nothing happens, with no way to tell if it worked. Catching
    // here and returning an explicit error message guarantees the admin always gets a
    // reply, consistent with [FIX-CMD-4]'s "never silently drop an admin message" goal.
    logger.error('[AdminCmd] confirmPayment failed', { shortId, adminPhone, err: err.message });
    return `⚠️ Something went wrong confirming order #${shortId}. Please try again.`;
  }
}

// ── Reject payment ────────────────────────────────────────────────────────────
async function rejectPayment(shortId, tenantId, adminPhone, tenantDoc, business, rejectReason = null) {
  try {
    // [FIX-CMD-11] shortId-only query (see confirmPayment for full explanation)
    //
    // [FIX-CMD-14] State-machine guard: previously only `status === 'cancelled'` blocked
    // a re-reject, meaning an admin could REJECT an order that was already `paymentStatus:
    // 'confirmed'` (and presumably already being prepared), flipping a confirmed order
    // back to pending/unpaid with no protection. Now also excludes confirmed orders.
    const order = await Order.findOne({
      shortId, tenantId,
      status:        { $ne: 'cancelled' },
      paymentStatus: { $ne: 'confirmed' },
    }).select('_id customerPhone status paymentStatus item shortId').lean();

    if (!order) {
      const existing = await Order.findOne({ shortId, tenantId })
        .select('status paymentStatus').lean().catch(() => null);
      if (!existing) return `⚠️ No order found: ${shortId}`;
      if (existing.status === 'cancelled') return `ℹ️ Order #${shortId} already cancelled.`;
      return `⚠️ Order #${shortId} can't be rejected — payment is already confirmed.`;
    }

    // [FIX-AWAIT] Distinguish cash orders (AWAIT_ADMIN_CONFIRM) from payment-proof orders.
    // Cash orders have no screenshot to retry — rejection means the order is cancelled
    // and the session should be fully cleared. Payment-proof orders get a retry window.
    //
    // [FIX-CMD-14] This check now runs BEFORE any write (previously the function wrote
    // status='pending'/paymentStatus='unpaid' unconditionally first, then immediately
    // overwrote those same fields to 'cancelled' in the cash branch — a wasted write
    // that also left the order briefly in the wrong state). We now write the correct
    // final state exactly once, via an atomic findOneAndUpdate keyed off the same
    // guard filter as the read above to close the double-tap TOCTOU race.
    const { getSession } = await import('../core/sessions/sessionService.js');
    const custSession = await getSession(order.customerPhone, tenantId).catch(() => null);
    const isCashOrder = custSession?.step === 'AWAIT_ADMIN_CONFIRM';

    const guardFilter = {
      _id: order._id,
      status:        { $ne: 'cancelled' },
      paymentStatus: { $ne: 'confirmed' },
    };

    if (isCashOrder) {
      // Cash/delivery rejection — mark cancelled, clear session, let customer restart
      const updated = await Order.findOneAndUpdate(guardFilter, { $set: {
        status:            'cancelled',
        paymentStatus:     'cancelled',
        paymentReviewedBy: adminPhone,
        paymentReviewedAt: new Date(),
      }}, { new: true }).lean();

      if (!updated) return `ℹ️ Order #${shortId} was already handled.`;

      await updateSession(order.customerPhone, tenantId, {
        currentFlow: null, step: null, data: {},
        postFlowAck:  'ORDER_REJECTED',
        postFlowData: { item: order.item, shortId: order.shortId || shortId, rejectReason },
      });
      const modeCfg = getModeConfig(business);
      // [FIX-EXPOSED-BUTTONS-2] This was still building its own raw
      // { type: 'buttons', buttons: modeCfg.ui?.welcomeButtons } reply — the
      // exact bug class core/shared/uiOptionsHelper.js's [FIX-EXPOSED-BUTTONS-1]
      // fixed everywhere else (buildWelcomeSequence's "Choose an option ▼"
      // dropdown getting bypassed by the raw "Order Food / Book a Table / ⋯ More"
      // 3-button layout on secondary prompts). This admin-initiated cash-order
      // cancellation notice was missed by that earlier audit — the customer-
      // initiated cancel path (postFlowHandler.js handleOrderConfirmed's
      // SWITCH_YES branch) already calls buildOptionsReply() for the same
      // "order cancelled, what next?" moment; this one didn't, so it still
      // leaked the full main-navigation button set into a cancellation notice.
      // Routed through buildOptionsReply() now so a tenant with cfg.ui.welcomeList
      // configured (e.g. restaurant) shows the "Choose an option" dropdown here
      // too, instead of the raw main-nav buttons.
      await dispatchMessage(order.customerPhone, buildOptionsReply(
        modeCfg,
        `❌ *Order Cancelled*\n\n` +
          `Unfortunately your order *#${order.shortId || shortId}* has been cancelled by our team.\n\n` +
          `If you have any questions, please contact us directly. We're sorry for the inconvenience.`,
        [
          { id: 'ORDER',    title: '🛒 Place New Order' },
          { id: 'QUESTION', title: '❓ Ask a Question'  },
        ],
      ), tenantDoc).catch(err => logger.warn('[AdminCmd] rejectPayment(cash): customer dispatch failed', {
        customerPhone: order.customerPhone, err: err.message,
      }));
      logger.info('[AdminCmd] Cash order rejected/cancelled', { shortId, adminPhone });
      return `❌ *Order cancelled*\n\nOrder #${shortId} — ${order.item}\nCustomer ${order.customerPhone} notified.`;
    }

    // [FIX-CMD-2] Reset BOTH paymentStatus AND status consistently:
    // paymentStatus='unpaid'  → receiveProof() will accept a new screenshot
    // status='pending'        → order is alive and awaiting retry (was 'payment_failed',
    //                           which is semantically wrong when the retry window is open)
    const updated = await Order.findOneAndUpdate(guardFilter, { $set: {
      paymentStatus:     'unpaid',
      status:            'pending',
      paymentReviewedBy: adminPhone,
      paymentReviewedAt: new Date(),
      // [FIX-REJECT-NOTE] Store the rejection reason on the Order so activeOrderResolver
      // can surface it to the customer. Previously only postFlowData carried the reason —
      // if the session expired between rejection and the customer's next message, the
      // reason was permanently lost and the customer saw no explanation.
      rejectedNote:      rejectReason || null,
    }}, { new: true }).lean();

    if (!updated) return `ℹ️ Order #${shortId} was already handled.`;

    // [FIX-CMD-8] Await the session update — if this fails the customer's session won't
    // point to PAYMENT_PROOF and they won't be able to send a retry screenshot.
    // Previously fire-and-forget, meaning a transient DB error silently broke retries.
    await updateSession(order.customerPhone, tenantId, {
      currentFlow:  'ORDER',
      step:         'PAYMENT_PROOF',
      postFlowAck:  'ORDER_REJECTED',
      postFlowData: { item: order.item, shortId: order.shortId || shortId },
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
  } catch (err) {
    // [FIX-CMD-15] See confirmPayment — guarantees the admin always gets a reply
    // instead of silent failure when a DB call throws mid-function.
    logger.error('[AdminCmd] rejectPayment failed', { shortId, adminPhone, err: err.message });
    return `⚠️ Something went wrong rejecting order #${shortId}. Please try again.`;
  }
}

// ── Confirm booking ───────────────────────────────────────────────────────────
async function confirmBooking(shortId, tenantId, adminPhone, tenantDoc) {
  try {
    // [FIX-CMD-14] Atomic findOneAndUpdate closes the same double-tap TOCTOU race as
    // confirmPayment — two near-simultaneous CONFIRM BOOK taps could previously both
    // pass the separate `findOne` guard before either `updateOne` landed, sending the
    // customer two "Booking Confirmed!" messages.
    const booking = await Booking.findOneAndUpdate(
      { shortId: shortId.toUpperCase(), tenantId, status: { $ne: 'confirmed' } },
      { $set: {
        status:            'confirmed',
        adminConfirmedAt:  new Date(),
        adminConfirmedBy:  adminPhone,
      }},
      { new: false }
    ).select('_id customerPhone date time service status customerName partySize staff bookingType').lean();

    if (!booking) {
      const existing = await Booking.findOne({ shortId: shortId.toUpperCase(), tenantId })
        .select('status').lean().catch(() => null);
      if (!existing) return `⚠️ No booking found: ${shortId}`;
      return `ℹ️ Booking #${shortId} already confirmed.`;
    }

    const when       = booking.time ? `${booking.date} at ${booking.time}` : booking.date;
    const serviceStr = booking.service ? ` (${booking.service})` : '';

    // [SPEC-6C] Booking confirmed message — structured format with reference,
    // date/time clearly on own lines, warm sign-off.
    // [FIX-SALON-4] Include stylist name and handle walk-in type display.
    const nameForBody = booking.customerName ? ` for *${booking.customerName}*` : '';
    const isWalkInBooking = booking.bookingType === 'walkin';
    const bookingBody =
      `✅ *${isWalkInBooking ? 'Walk-In Queue Confirmed!' : 'Booking Confirmed!'}*${nameForBody}\n\n` +
      (!isWalkInBooking && booking.date ? `📅  Date: *${booking.date}*\n` : '') +
      (!isWalkInBooking && booking.time ? `⏰  Time: *${booking.time}*\n` : '') +
      (booking.partySize ? `👥  Party size: *${booking.partySize}*\n` : '') +
      (booking.service   ? `💇  Service: *${booking.service}*\n`       : '') +
      (booking.staff     ? `👤  Stylist/Barber: *${booking.staff}*\n`   : '') +
      `🔖  Reference: *${shortId}*\n\n` +
      `We look forward to seeing you 😊\n\n` +
      `If anything changes, just message us here.`;

    // [FIX-SALON-CONFIRM-BTNS] Send as interactive buttons so customer has clear CTAs.
    // Plain dispatchText left customers with no next step after confirmation.
    // Walk-ins get "Leave Queue" instead of "Cancel Booking" for correct framing.
    await dispatchMessage(booking.customerPhone, {
      type:    'buttons',
      body:    bookingBody,
      buttons: isWalkInBooking
        ? [
            { id: 'QUESTION',       title: '❓ Ask a Question' },
            { id: 'CANCEL_BOOKING', title: '❌ Leave Queue'     },
          ]
        : [
            { id: 'QUESTION',       title: '❓ Ask a Question' },
            { id: 'CANCEL_BOOKING', title: '❌ Cancel Booking'  },
          ],
    },
    // [FIX-CMD-2] Log dispatch failures — customer won't know their booking is confirmed.
    tenantDoc).catch(err => logger.warn('[AdminCmd] confirmBooking: customer dispatch failed', {
      customerPhone: booking.customerPhone, err: err.message,
    }));

    // [v14-UPSELL] Post-confirmation product upsell for salon/barbershop bookings.
    // After sending the confirmation, check if the business has retail products tagged
    // to the booked service category and send a follow-up recommendation.
    // Only fires for salon/barbershop modes (not restaurant, retail, etc.) and only
    // when the business has non-service menuItems available.
    try {
      const { default: _BizCfg } = await import('../models/BusinessConfig.js');
      const _bizFull = await _BizCfg.findOne({ tenantId }).select('businessMode menuItems settings').lean().catch(() => null);
      const _mode = (_bizFull?.businessMode || '').toUpperCase();
      const _isSalonUpsell = _mode === 'SALON' || _mode === 'BARBERSHOP';
      const _isWalkInUpsell = booking.bookingType === 'walkin';

      if (_isSalonUpsell && !_isWalkInUpsell && _bizFull?.menuItems?.length) {
        const _retailItems = (_bizFull.menuItems || []).filter(i =>
          i.available !== false &&
          i.category &&
          !['services', 'service'].includes(i.category.toLowerCase())
        );

        if (_retailItems.length > 0) {
          // Pick up to 3 products to recommend
          const _toShow = _retailItems.slice(0, 3);
          const _currency = _bizFull?.payment?.currency || 'D';
          const _serviceKeyword = (booking.service || '').toLowerCase();

          // Prefer products whose category/name matches the booked service
          const _matched = _toShow.filter(p =>
            p.category?.toLowerCase().includes(_serviceKeyword.split(' ')[0]) ||
            p.name?.toLowerCase().includes(_serviceKeyword.split(' ')[0])
          );
          const _upsellItems = _matched.length > 0 ? _matched.slice(0, 3) : _toShow;

          if (_upsellItems.length > 0) {
            const _productLines = _upsellItems.map(p => {
              const _price = p.price ? ` — ${p.currency || _currency}${formatMoney(p.price)}` : '';
              return `• *${p.name}*${_price}`;
            }).join('\n');

            const _isBarbershopUpsell = _mode === 'BARBERSHOP';
            const _upsellBody =
              `${_isBarbershopUpsell ? '✂️' : '💇'} *Aftercare tip:* Maintain your results at home!\n\n` +
              `We recommend:\n${_productLines}\n\n` +
              `Tap below to order, or reply *"shop"*.`;

            // Send as interactive buttons after confirmation (3s delay so confirmation lands first)
            setTimeout(async () => {
              await dispatchMessage(booking.customerPhone, {
                type:    'buttons',
                body:    _upsellBody,
                buttons: [
                  { id: 'ORDER',     title: '🛍 Shop Products' },
                  { id: 'SHOW_MENU', title: '🔄 Main Menu'     },
                ],
              }, tenantDoc).catch(() => {});
            }, 3000);
          }
        }
      }
    } catch { /* upsell is non-fatal */ }

    // [FIX-SALON-17] Set walk-in specific postFlowAck so postFlowHandler routes
    // admin-confirmed walk-in follow-ups to the queue-context handler, not the generic
    // appointment BOOKING_CONFIRMED handler (which references dates/times that don't
    // exist for walk-ins). WALKIN_CONFIRMED has a dedicated case in postFlowHandler.
    const _confirmedAck = booking.bookingType === 'walkin' ? 'WALKIN_CONFIRMED' : 'BOOKING_CONFIRMED';
    await updateSession(booking.customerPhone, tenantId, {
      postFlowAck:  _confirmedAck,
      postFlowData: { service: booking.service, date: booking.date, time: booking.time, staff: booking.staff || null, bookingType: booking.bookingType || null, shortId },
    }).catch(() => {});

    logger.info('[AdminCmd] Booking confirmed', { shortId, adminPhone });
    return `✅ *Booking confirmed*\n\nBooking #${shortId} — ${when}${serviceStr}\nCustomer ${booking.customerPhone} notified.`;
  } catch (err) {
    // [FIX-CMD-15] Guarantee the admin always gets a reply instead of silent failure.
    logger.error('[AdminCmd] confirmBooking failed', { shortId, adminPhone, err: err.message });
    return `⚠️ Something went wrong confirming booking #${shortId}. Please try again.`;
  }
}

// ── Decline booking ───────────────────────────────────────────────────────────
async function declineBooking(shortId, reason, tenantId, adminPhone, tenantDoc) {
  try {
    // [FIX-CMD-14] Atomic findOneAndUpdate — same TOCTOU rationale as confirmBooking.
    const booking = await Booking.findOneAndUpdate(
      { shortId: shortId.toUpperCase(), tenantId, status: { $ne: 'cancelled' } },
      { $set: {
        status:           'cancelled',
        adminDeclinedAt:  new Date(),
        adminDeclinedBy:  adminPhone,
        adminNote:        reason || null,
      }},
      { new: false }
    ).select('_id customerPhone date time service status customerName staff bookingType').lean();

    if (!booking) {
      const existing = await Booking.findOne({ shortId: shortId.toUpperCase(), tenantId })
        .select('status').lean().catch(() => null);
      if (!existing) return `⚠️ No booking found: ${shortId}`;
      return `ℹ️ Booking #${shortId} already cancelled.`;
    }

    const when        = booking.time && booking.bookingType !== 'walkin' ? `${booking.date} at ${booking.time}` : booking.date;
    const serviceStr  = booking.service ? ` (${booking.service})` : '';
    const reasonStr   = reason ? `\n\n*Reason:* ${reason}` : '';
    const isWalkInDec = booking.bookingType === 'walkin';

    // [FIX-SALON-10] Tailor decline message for walk-in vs appointment.
    // Walk-in: "we can't add you to the queue right now" — no "arrange alternative time"
    // which doesn't make sense for a walk-in context.
    const refStr     = shortId ? ` _(Ref: #${shortId})_` : ''; // [FIX-DECLINE-REF]
    const declineBody = isWalkInDec
      ? `❌ *Walk-In Unavailable*${refStr}\n\nSorry, we're unable to add you to the queue right now${serviceStr}.${reasonStr}\n\nPlease try again later or book an appointment.`
      : `❌ *Booking Unavailable*${refStr}\n\nUnfortunately we can't confirm your booking${serviceStr}${when ? ` for *${when}*` : ''}.${reasonStr}\n\nWe'd love to find another time that works — tap below to try again.`;

    await dispatchMessage(booking.customerPhone, {
      type:    'buttons',
      body:    declineBody,
      buttons: isWalkInDec
        ? [
            { id: 'BOOK',     title: '📅 Book Appointment' },
            { id: 'QUESTION', title: '❓ Ask a Question'   },
          ]
        : [
            { id: 'BOOK',     title: '📅 Try Different Date' },
            { id: 'QUESTION', title: '❓ Ask a Question'      },
          ],
    },
    // [FIX-CMD-2] Log dispatch failures — customer won't know their booking was declined.
    tenantDoc).catch(err => logger.warn('[AdminCmd] declineBooking: customer dispatch failed', {
      customerPhone: booking.customerPhone, err: err.message,
    }));

    await updateSession(booking.customerPhone, tenantId, {
      postFlowAck:  'BOOKING_DECLINED',
      // [FIX-SALON-10] Include staff and bookingType so postFlowHandler can tailor response
      postFlowData: { service: booking.service, date: booking.date, staff: booking.staff || null, bookingType: booking.bookingType || null },
    }).catch(() => {});

    logger.info('[AdminCmd] Booking declined', { shortId, adminPhone, reason });
    return `❌ *Booking declined*\n\nBooking #${shortId} — ${when}${serviceStr}${reason ? `\nReason: ${reason}` : ''}\nCustomer ${booking.customerPhone} notified.`;
  } catch (err) {
    // [FIX-CMD-15] Guarantee the admin always gets a reply instead of silent failure.
    logger.error('[AdminCmd] declineBooking failed', { shortId, adminPhone, err: err.message });
    return `⚠️ Something went wrong declining booking #${shortId}. Please try again.`;
  }
}

// ── Mark order ready ──────────────────────────────────────────────────────────
// [SPEC-5A] Admin types "MARK READY <shortId>" or taps READY_<shortId> button.
// Updates order status to 'ready', dispatches the spec §5A message to the customer.
async function markOrderReady(shortId, tenantId, adminPhone, tenantDoc, business) {
  try {
    // [FIX-MARK-READY-GUARD] Previously required status='confirmed' AND paymentStatus='confirmed'.
    // This blocked orders that were:
    //   - Confirmed via dashboard PATCH (paymentStatus stays 'unpaid' unless admin also changed it)
    //   - Cash orders accepted via AWAIT_ADMIN_CONFIRM (paymentStatus never set to 'confirmed')
    //   - Orders in 'preparing' status (already past confirmed but not yet ready)
    // Fix: accept any order that is in a non-terminal, non-already-ready state:
    //   - status: confirmed OR preparing (both mean "order accepted, not yet ready")
    //   - Not: completed, cancelled, rejected, ready, payment_failed
    const order = await Order.findOneAndUpdate(
      {
        shortId, tenantId,
        status: { $in: ['confirmed', 'preparing'] },
      },
      { $set: { status: 'ready', readyAt: new Date() } },
      { new: false }
    ).select('_id customerPhone item quantity shortId').lean();

    if (!order) {
      const existing = await Order.findOne({ shortId, tenantId }).select('status paymentStatus').lean().catch(() => null);
      if (!existing)                      return `⚠️ No order found: ${shortId}`;
      if (existing.status === 'ready')     return `ℹ️ Order #${shortId} is already marked ready.`;
      if (existing.status === 'completed') return `ℹ️ Order #${shortId} is already completed.`;
      return `⚠️ Order #${shortId} can't be marked ready — status is *${existing.status}*.`;
    }

    const bizName = business?.name || 'us';

    // [SPEC-5A] Order ready notification with Collected + Need Help buttons
    await dispatchMessage(order.customerPhone, {
      type:    'buttons',
      body:
        `🍽️ *Your Order is Ready!*\n\n` +
        `📦  *${order.item}* × ${order.quantity}\n` +
        `🔖  Reference: *#${order.shortId || shortId}*\n\n` +
        `Please collect your order at the counter 😊\n\n` +
        `Thank you for choosing *${bizName}*!`,
      buttons: [
        { id: `COLLECTED_${order.shortId || shortId}`, title: '✅ Collected — Thanks!' },
        { id: 'SUPPORT', title: '❓ Need Help' },
      ],
    }, tenantDoc).catch(err => logger.warn('[AdminCmd] markOrderReady: customer dispatch failed', {
      customerPhone: order.customerPhone, err: err.message,
    }));

    await updateSession(order.customerPhone, tenantId, {
      currentFlow:  null, step: null,
      postFlowAck:  'ORDER_READY',
      postFlowData: { item: order.item, quantity: order.quantity, shortId: order.shortId || shortId },
    }).catch(() => {});

    logger.info('[AdminCmd] Order marked ready', { shortId, adminPhone });
    return `✅ *Order ready notification sent*\n\nOrder #${shortId} — ${order.item}\nCustomer ${order.customerPhone} notified to collect.`;
  } catch (err) {
    logger.error('[AdminCmd] markOrderReady failed', { shortId, adminPhone, err: err.message });
    return `⚠️ Something went wrong marking order #${shortId} ready. Please try again.`;
  }
}

// ── Resume bot ────────────────────────────────────────────────────────────────
async function resumeBot(customerPhone, tenantId, tenantDoc) {
  // upsert returns null when no document matches — meaning there is no active
  // session for this customer (TTL-expired). The admin gets a success message either
  // way (the bot IS effectively not running for that customer), but logging the miss
  // makes it easier to diagnose cases where an admin resumes a phone that never had
  // a human-mode session.
  const updated = await updateSession(customerPhone, tenantId, {
    humanMode:         false,
    humanModeNotified: false,
    postFlowAck:       null,
    postFlowData:      null,
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
    dispatchMessage(
      customerPhone,
      {
        type:    'buttons',
        body:    `✅ Our team has finished assisting you. Our automated assistant is back! 😊\n\nTap below if you need anything.`,
        buttons: [
          { id: 'SHOW_MENU', title: '🔄 Main Menu'       },
          { id: 'QUESTION',  title: '❓ Ask a Question'  },
        ],
      },
      tenantDoc,
    ).catch(() => {});
  }

  return `✅ Bot resumed for *${customerPhone}*. Automation is active again.`;
}

// ── Admin alert builders ──────────────────────────────────────────────────────
// [FIX-CMD-16] buildAdminBookingAlert() (the version with a CONFIRM BOOK/DECLINE BOOK
// text-command footer baked into the body) was removed as dead code — it was exported
// but never called anywhere. The only real caller, bookingFlow.js, uses
// buildAdminBookingAlertBody() directly and constructs an interactive buttons array
// itself (CONFIRM_BOOK_<shortId> / DECLINE_BOOK_<shortId>), which is the correct path
// since admin alerts are sent as WhatsApp interactive button messages, not plain text
// with typed commands in the footer.
export function buildAdminBookingAlertBody({ customerPhone, date, time, service, partySize, business, shortId, staff, bookingType }) {
  const bizName       = business?.name || 'Business';
  const mode          = (business?.businessMode || '').toUpperCase();
  const isSalon       = mode === 'SALON' || mode === 'BARBERSHOP';
  const isWalkIn      = bookingType === 'walkin';
  const staffLabel    = mode === 'BARBERSHOP' ? 'Barber' : 'Stylist';

  const typeHeader    = isWalkIn ? '🚶 *Walk-In Queue* — ' : '📅 *New Booking* — ';
  const serviceStr    = service   ? `\n💇 Service: *${service}*`             : '';
  const staffStr      = staff     ? `\n👤 ${staffLabel}: *${staff}*`          : '';
  const timeStr       = time && !isWalkIn ? `\n⏰ Time: *${time}*`           : '';
  const partyStr      = partySize ? `\n👥 Party size: *${partySize}*`         : '';
  const idStr         = shortId   ? `\n🔖 Ref: \`${shortId}\``               : '';

  // [FIX-SALON-3] For walk-ins show the time they joined, not a booked time slot.
  // [FIX-SALON-16] Use business timezone for the join time display. Previously used
  // toLocaleTimeString() without a timezone, falling back to server TZ (UTC on Railway).
  const _walkInTz     = business?.hours?.timezone || 'UTC';
  const walkInTimeStr = isWalkIn
    ? `\n⏰ Joined: *${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: _walkInTz })}*`
    : '';

  const dateStr = (!isWalkIn && date) ? `\n📅 Date: *${date}*` : '';

  return (
    `🔔 ${typeHeader}${bizName}\n\n` +
    `📞 Customer: *${customerPhone}*` +
    dateStr +
    timeStr +
    walkInTimeStr +
    serviceStr +
    staffStr +
    partyStr +
    idStr +
    '\n\n⏳ Status: *Pending* — please confirm or decline.'
  );
}
