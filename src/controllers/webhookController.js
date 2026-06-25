/**
 * controllers/webhookController.js — WhatSalesAgent (Merged)
 *
 * THE SINGLE MESSAGE ENTRY POINT.
 *
 * Processing order (strict):
 *   1.  De-duplicate (wamid guard)
 *   2.  Empty message guard
 *   3.  Load business config
 *   4.  Load / create session
 *   5.  Business hours enforcement          [FIX-BUG3 — was never checked]
 *   6.  Admin command guard                 [FIX-HM-7 — moved before humanMode]
 *   7.  Human mode guard
 *   8.  Loop prevention                     [FIX-BUG4 — was never enforced]
 *   8.5 Non-payment image guard             [FIX-WH-4 — images outside checkout]
 *   9.  Payment proof (image)
 *   10. DONE payment (requireProof=false gate)
 *   10.5 PAYMENT_PROOF strict text guard
 *   11. [Admin button reply moved to step 6]
 *   11.5 AWAIT_ADMIN_CONFIRM guard
 *   11.7 PENDING ORDER LOCK — blocks new flows while order awaits admin action
 *   12. LEAD_CAPTURE active flow routing
 *   13. ENQUIRY active flow routing
 *   14. Post-flow acknowledgement
 *   15. Active flow → flowEngine.advance()
 *   16. Intent detection → module router
 *
 * [FIX-BUG3]  Hours enforcement: bot now respects business.hours.enabled — replies
 *             with a closed message outside configured hours.
 * [FIX-BUG4]  Loop prevention: loopCount is incremented per session. After 3
 *             identical consecutive messages the bot breaks the loop with the
 *             configured loopFallback message and welcomes menu buttons.
 * [FIX-BUG9]  FLOW_PASSTHROUGH_IDS — all button IDs generated inside active flows
 *             (TIME_*, QTY_*, SVC_*, SKIN_*, SIZE_*, CAKE_*, CONCERN_*, LEAD_SKIP)
 *             bypass intent detection and go straight to flowEngine.advance().
 * [FIX-WH-3]  humanMode TTL restore now uses a single atomic createSession upsert
 *             instead of a separate updateSession call — eliminates race window.
 * [FIX-WH-4]  Images sent outside the ORDER/PAYMENT_PROOF context are now caught
 *             at step 8.5 and given a polite reply instead of falling through to
 *             intent detection with an empty messageText string.
 * [FIX-WH-5]  Step 6 'RESUME BOT' guard uses === / startsWith(' ') instead of plain
 *             startsWith('RESUME BOT') — prevents 'RESUME BOTNET ...' from triggering
 *             an unnecessary isAdminPhone DB lookup.
 * [FIX-WH-6]  createSession data no longer passes redundant customerPhone: from.
 *             sessionService ignores data.customerPhone entirely (uses first param),
 *             so the field was dead weight and a potential source of confusion.
 * [FIX-LOOP-1] Loop break now uses a single merged updateSession call — the previous
 *             two sequential writes had a race window where a concurrent request could
 *             see loopCount=MAX with the flow still active and send a double response.
 * [FIX-LOOP-2] MAX_LOOP corrected from 3 to 2 — the first identical message sets
 *             lastLoopMessage (loopCount stays 0), so MAX_LOOP=3 would break on the
 *             4th send, not the 3rd as documented. MAX_LOOP=2 breaks on the 3rd send.
 * [FIX-WH-1]  Removed redundant getSession call after createSession — createSession
 *             already returns the freshly written document via { new: true }.
 * [FIX-WH-2]  Fire-and-forget updateSession (lastSeen/messageCount/phoneNumberId) now
 *             logs failures instead of silently swallowing them.
 * [FIX-WH-3]  hours.days normalised to a plain object once, replacing the fragile
 *             dual Map/object accessor pattern.
 * [FIX-WH-4]  FLOW_PASSTHROUGH_IDS SVC_ coverage extended to SVC_0..SVC_99 and backed
 *             by isFlowPassthroughId() regex so businesses with >10 services work.
 * [FIX-WH-5]  'ORDER' typed during PAYMENT_PROOF step now cancels the pending order
 *             and routes to a fresh start, consistent with NEW_ORDER behaviour.
 * [FIX-2.1]   step 15 advance(): `|| imageUrl` fallback removed — imageUrl is fully
 *             consumed by steps 8.5 and 9; passing it as a text fallback was a silent
 *             footgun that would send a WhatsApp media ID into the flow engine if either
 *             guard were ever relaxed. Now `message: messageText` only.
 * [FIX-2.2]   Non-admin tapping a stale admin button (e.g. forwarded message) now
 *             receives a neutral fallback reply instead of a silent drop.
 * [FIX-2.3]   Expired-humanMode findOne now filters `expiresAt: { $lte: new Date() }`
 *             so it only matches expired sessions, not any live humanMode document.
 * [FIX-2.4]   messageCount fire-and-forget update now uses atomic $inc via the new
 *             `inc` argument to updateSession() — safe under concurrent webhooks.
 * [FIX-WH-7]  ProcessedMessage.create non-duplicate errors now log and return instead
 *             of falling through silently. Previously any DB error other than code 11000
 *             (duplicate key) was swallowed and message processing continued — breaking
 *             the dedup guarantee and risking double-processing on webhook retries.
 * [FIX-LOOP-3] Loop detection now guards !session.currentFlow. Previously the check
 *             fired inside active flows, breaking mid-flow legitimate repetition (e.g.
 *             re-entering a quantity or address). Loop detection only applies at the
 *             top-level intent layer where true infinite loops can occur.
 * [FIX-BUG1]  ORDER_CONFIRMED handler: MY_ORDER_RE (§4G) and ETA_RE (§4F) were checked
 *             AFTER the isQuestion branch, which returns early. Messages like "how long?"
 *             and "what did I order?" matched QUESTION_RE and were swallowed by the generic
 *             AI question handler — never reaching the dedicated ETA/order-summary paths.
 *             Fixed: MY_ORDER_RE and ETA_RE now evaluated BEFORE isQuestion.
 * [FIX-BUG3]  ORDER_CONFIRMED: vipSuffix was declared but never used in ackBody. Removed.
 * [FIX-BUG4]  ORDER_CONFIRMED: itemStr was declared but never used in this block (it is
 *             used in ORDER_REJECTED — that usage is kept). Removed from ORDER_CONFIRMED.
 * [FIX-BUG5]  BOOKING_CONFIRMED ack/compliment: was sending welcomeBtns (sales menu).
 *             Per spec §6C, no upsell after booking confirmation. Now sends plain text
 *             with a contextual [CANCEL_BOOKING] button only.
 * [FIX-BUG6]  BOOKING_CONFIRMED question fallback: was sending welcomeBtns. Now sends
 *             contextual [QUESTION, CANCEL_BOOKING] buttons only.
 * [FIX-BUG7]  BOOKING_DECLINED ack + fallback: was sending generic welcomeBtns. After a
 *             declined booking the contextual next action is to re-book or speak to the
 *             team, not the generic sales menu. Changed to [BOOK, SUPPORT].
 * [FIX-BUG8]  ORDER_CONFIRMED isQuestion response: CANCEL button id was 'CANCEL' which
 *             routes to moduleRouter → cancelFlow() — cancels IMMEDIATELY without the §4H
 *             cancel-confirmation prompt. Changed to 'CANCEL_ORDER' which is caught by the
 *             CANCEL_RE / upper==='CANCEL_ORDER' check at the top of ORDER_CONFIRMED,
 *             correctly triggering the "Are you sure?" confirmation flow.
 *             Same fix applied to the isUnrelated redirect buttons.
 * [FIX-BUG9]  SWITCH_NO: was passing data: session.data which still contains cancelShortId
 *             from the cancel-confirm prompt. Re-persisting it caused the stale shortId to
 *             survive into future cancel attempts. Only postFlowAck/postFlowData restored.
 * [FIX-BUG10] POL ACK micro-reply classifier: rawTrimPOL.length <= 3 was too aggressive —
 *             "bad" (3 chars) is a genuine complaint that should see the lock message, not
 *             a soft micro-reply. Replaced with a tighter isMicroInputPOL check: single
 *             emoji OR ≤2-char non-letter-pair inputs only.
 * [FIX-BUG13] ORDER_READY isAck: COLLECTED_ button ID construction used
 *             `COLLECTED_${shortId||''}`.replace(/COLLECTED_$/, 'SUPPORT')` — when shortId
 *             was empty this silently produced the id 'SUPPORT', routing to human-escalation
 *             instead of order-collected confirmation. Fixed: build COLLECTED_<shortId> only
 *             when shortId is truthy; use 'SUPPORT' button (correct intent) when absent.
 * [FIX-EXTRA] ORDER_CONFIRMED ack: VIP and non-VIP branches produced identical strings —
 *             dead conditional collapsed to a single assignment.
 * [FIX-ENV-2]  DISABLE_WORKING_HOURS env var is now read by isWithinBusinessHours().
 *             It was exported from env.js but never consumed here, making the override
 *             a complete no-op in all prior versions.
 * [FIX-WH-CLOSED-2] closedMsgSent re-open path now sends a proactive "we're open"
 *             message on the first customer message after reopening (for long-lived
 *             sessions on payment/humanMode TTLs) instead of silently dropping it.
 */

import { getSession, createSession, updateSession } from '../core/sessions/sessionService.js';
import { detectIntent, extractCustomerName }         from '../core/intents/intentEngine.js';
import { updateName as persistCustomerName }         from '../core/memory/customerMemory.js';
import { advance }                                   from '../core/conversations/flowEngine.js';
import { route }                                     from '../core/conversations/moduleRouter.js';
import { dispatchMessage }                           from '../core/whatsapp/dispatcher.js';
import { getModeConfig }                             from '../config/modes.js';
import { decryptToken }                              from './tenantController.js';
// [FIX-IMPORT-1] handlePostFlowMessage was called at step 14 but never imported —
// every postFlowAck message fell through to the default-case "unknown ackCtx" path in
// postFlowHandler.js, sending a generic menu instead of the correct contextual reply.
import { handlePostFlowMessage }                     from '../services/postFlowHandler.js';
// [FIX-AOR-1] resolveActiveOrder is the single authoritative gate for "customer has an
// active order" context. It was built and documented but never wired into the controller.
// Without this import, every message from a customer with a confirmed/preparing order
// hit intent detection (GREET → welcome screen, ACKNOWLEDGE → micro-reply with no order
// context) instead of the correct context-aware order-state card. This also caused the
// "Ok/Hello after payment confirmation gets no order-aware response" bug seen in production.
import { resolveActiveOrder }                        from '../services/activeOrderResolver.js';
import Tenant           from '../models/Tenant.js';
import BusinessConfig   from '../models/BusinessConfig.js';
import ProcessedMessage from '../models/ProcessedMessage.js';
// [FIX-IMPORT-2] Order used at step 5 (hasActiveOrder guard) without a top-level import.
// All other Order usages in this file are inside dynamic import() blocks, but the step-5
// call is at the top-level of the function where dynamic import would add unnecessary
// latency on every message. Adding the static import here makes the reference valid and
// avoids a ReferenceError crash on any message received outside business hours.
import Order            from '../models/Order.js';
import logger           from '../config/logger.js';
import crypto           from 'crypto';

// ── [META-CREDS] Per-tenant webhook HMAC signature verification ───────────────
// Verifies X-Hub-Signature-256 using the tenant's own Meta App Secret.
// Falls back to the global META_APP_SECRET env var when a tenant has no
// meta.appSecret — so existing tenants remain functional without migration.
//
// Returns true  → signature valid (or no secret configured in dev mode)
// Returns false → signature invalid or missing (reject the message)
//
// IMPORTANT: req.rawBody (Buffer) must be set by app.js before this runs.
// The existing express.raw() setup in app.js already handles this.
function _verifyTenantWebhookSignature(req, tenant) {
  // [META-CREDS] Resolve secret: per-tenant first, then global env fallback.
  // decryptToken handles the enc: prefix transparently (imported above).
  const encryptedSecret = tenant?.meta?.appSecret ?? null;
  const rawSecret = (encryptedSecret ? decryptToken(encryptedSecret) : null)
    ?? process.env.META_APP_SECRET
    ?? null;

  // No secret anywhere — pass through with a warning rather than silently dropping
  // the message. During migration, tenants that have not yet had meta.appSecret
  // populated and the platform hasn't set META_APP_SECRET would be unreachable.
  // DEPLOY.md explicitly states zero downtime during migration; rejecting here
  // contradicts that. A missing secret is an ops/config issue — log it clearly
  // so the operator knows, but don't silently break the bot.
  // [META-CREDS-FIX] Changed from hard reject → warn+pass in both environments.
  if (!rawSecret) {
    logger.warn('[Webhook] No app secret configured — signature check skipped. ' +
      'Set META_APP_SECRET or populate meta.appSecret on the tenant to enable HMAC verification.', {
      tenantId: String(tenant?._id),
      env: process.env.NODE_ENV,
    });
    return true;
  }

  const sigHeader = req.headers['x-hub-signature-256'];
  if (!sigHeader) {
    // Meta always sends this header on real webhook events
    logger.warn('[Webhook] Missing X-Hub-Signature-256 header', { ip: req.ip });
    return false;
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.error('[Webhook] rawBody missing — check app.js raw body parser setup');
    return false;
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', rawSecret)
    .update(rawBody)
    .digest('hex');

  const sigBuf = Buffer.from(sigHeader);
  const expBuf = Buffer.from(expected);
  return sigBuf.length === expBuf.length &&
         crypto.timingSafeEqual(sigBuf, expBuf);
}

// ── [FIX-BUG9] Button IDs generated inside active flows — must bypass intent detection
// [FIX-WH-4] SVC_ IDs were previously capped at SVC_0..SVC_9 (10 services). Businesses
// with more than 10 services would have SVC_10, SVC_11, etc. fall through to intent
// detection, silently breaking the service-selection step. The Set is now generated up
// to SVC_99, and the passthrough check also accepts any SVC_N pattern via the helper
// isSvcId() so the cap can never be hit in practice without a code change.
function isFlowPassthroughId(id) {
  if (!id) return false;
  const upper = id.toUpperCase();
  return (
    FLOW_PASSTHROUGH_IDS.has(upper) ||
    // [FIX-SVC-STR] services/flows/index.js generates SVC_{NAME} (e.g. SVC_CONSULTING,
    // SVC_PHOTOGRAPHY) not SVC_{digit}. The old regex ^SVC_\d+$ (digits-only) never
    // matched string-named service IDs — every service-list tap fell through to intent
    // detection → FALLBACK. Fixed: accept any word-char suffix after SVC_.
    /^SVC_[A-Z0-9_]+$/.test(upper)  ||  // service rows — numeric (SVC_0) or named (SVC_CONSULT)
    /^COLOR_[A-Z_]+$/.test(upper)   ||  // dynamic colour buttons
    /^SIZE_[A-Z0-9_]+$/.test(upper) ||  // dynamic size/variant buttons
    /^CAT_[A-Z0-9_]+$/.test(upper)  ||  // electronics category picker (CAT_PHONES, CAT_LAPTOPS…)
    /^PICK_[AB]_/.test(upper)       ||  // electronics compare pick (PICK_A_<id>, PICK_B_<id>)
    /^COLLECTED_[A-Z0-9]+$/.test(upper) || // order-collected confirmation (COLLECTED_<shortId>)
    /^STYLIST_[A-Z0-9_]+$/.test(upper)  || // salon/barbershop stylist selection (STYLIST_ANY, STYLIST_<NAME>)
    // [FIX-VAR] retail/flows/index.js generates VAR_{VARIANT_NAME} (e.g. VAR_RED, VAR_SIZE_L)
    // for product variant pickers. Without this entry, tapping a variant button fell through
    // to intent detection → FALLBACK. Customer stuck at variant selection with no response.
    /^VAR_[A-Z0-9_]+$/.test(upper)  ||  // retail product variant selection (VAR_<name>)
    // [FIX-AOR-2] ORDER_STATUS_* buttons are generated by activeOrderResolver._multipleOrders()
    // for the "you have N active orders" list. Without passthrough they hit intent detection
    // which has no case for ORDER_STATUS_ → FALLBACK, showing a generic help menu instead
    // of the order details the customer tapped to see.
    /^ORDER_STATUS_[A-Z0-9]+$/.test(upper) || // multiple-order picker (ORDER_STATUS_<shortId>)
    // [FIX-RESUME-BTN-PT] RESUME_BOT_<phone> is an admin-facing button but must also be in
    // the passthrough set so that if the admin has an active flow when they tap it, the button
    // ID isn't forwarded to the flow handler as plain text. The admin button guard at step 6
    // catches it BEFORE the flow engine, so adding it here is purely defensive.
    /^RESUME_BOT_[0-9+\s()./-]+$/.test(upper) // admin resume-bot button (RESUME_BOT_<phone>)
  );
}

const FLOW_PASSTHROUGH_IDS = new Set([
  // ── Time slots (booking + delivery scheduled) ─────────────────────────────
  'TIME_9AM','TIME_10AM','TIME_11AM','TIME_12PM',
  'TIME_1PM','TIME_2PM','TIME_3PM','TIME_4PM','TIME_5PM','TIME_6PM',
  // ── Quantity quick-picks ──────────────────────────────────────────────────
  'QTY_1','QTY_2','QTY_3','QTY_4','QTY_5',
  // ── Service selection — SVC_0..SVC_99; isFlowPassthroughId() regex covers ≥100 ──
  ...Array.from({ length: 100 }, (_, i) => `SVC_${i}`),
  // ── Skin type / beauty concern ────────────────────────────────────────────
  'SKIN_DRY','SKIN_OILY','SKIN_COMBO','SKIN_CUSTOM',
  'CONCERN_ACNE','CONCERN_DARK','CONCERN_MOIST','CONCERN_AGE','CONCERN_SENSE',
  // ── Cake builder ──────────────────────────────────────────────────────────
  'FLAVOR_VANILLA','FLAVOR_CHOCOLATE','FLAVOR_REDVELVET','FLAVOR_CARROT','FLAVOR_LEMON',
  'SIZE_SMALL','SIZE_MEDIUM','SIZE_LARGE','SIZE_XL',
  // ── Garment sizes ─────────────────────────────────────────────────────────
  'SIZE_XS','SIZE_S','SIZE_M','SIZE_L','SIZE_XXL','SIZE_FREE',
  // ── Colours ───────────────────────────────────────────────────────────────
  'COLOR_SKIP',
  ...['BLACK','WHITE','RED','BLUE','GREEN','YELLOW','PINK','GREY','BROWN','NAVY',
      'ORANGE','PURPLE','GOLD','SILVER','BEIGE'].map(c => `COLOR_${c}`),
  // ── Date quick-picks & nav ────────────────────────────────────────────────
  'DATE_TODAY','DATE_TOMORROW','DATE_NEXT_SAT','DATE_NEXT_SUN',
  'DATE_BACK','TIME_BACK',
  // ── Booking: party size ───────────────────────────────────────────────────
  'PARTY_2','PARTY_4','PARTY_6',
  // ── Upsell ───────────────────────────────────────────────────────────────
  'UPSELL_YES','UPSELL_NO',
  // ── Delivery slots ────────────────────────────────────────────────────────
  'SLOT_ASAP','SLOT_30','SLOT_1HR','SLOT_SCHEDULE',
  'SCHED_9AM','SCHED_10AM','SCHED_11AM','SCHED_12PM',
  'SCHED_2PM','SCHED_4PM','SCHED_6PM','SCHED_CUSTOM',
  // ── Delivery address ─────────────────────────────────────────────────────
  'USE_SAVED_ADDRESS','NEW_ADDRESS',
  // ── Retail fulfilment ─────────────────────────────────────────────────────
  'PICKUP','DELIVERY',
  // ── Services module: budget + timeline ───────────────────────────────────
  'BUDGET_DISCUSS','BUDGET_SMALL','BUDGET_MED','BUDGET_LARGE',
  'TL_ASAP','TL_WEEK','TL_MONTH','TL_FLEX',
  // ── General / enquiry topics ──────────────────────────────────────────────
  'TOPIC_PRODUCT','TOPIC_PRICE','TOPIC_SUPPORT','TOPIC_PARTNER','TOPIC_OTHER',
  'ENQUIRY_CONFIRM','ENQUIRY_SEND',
  // ── Top-level navigation (handled in webhookController before flowEngine, ─
  //    but listed here so isFlowPassthroughId() returns true and intent      ─
  //    detection is cleanly skipped rather than trying ORDER / BOOK etc.)    ─
  'TRACK_ORDER','QUOTE_FOLLOW','ABOUT',
  // ── Lead capture ─────────────────────────────────────────────────────────
  'LEAD_SKIP',
  // ── Top-level QUESTION button — must bypass intent detection so mode-specific
  //    QUESTION flows (SERVICES, GENERAL) are reached via ACTION_REGISTRY rather
  //    than the webhookController inline ENQUIRY shortcut at step 16. ─────────
  'QUESTION',
  // ── Top-level ENQUIRY button — same reason: the webhookController inline handler
  //    at step 16 intercepts action=ENQUIRY before route() can delegate to the
  //    mode-specific ENQUIRY flow (e.g. SERVICES quote capture). Adding ENQUIRY
  //    here forces button taps to bypass intent detection and reach ACTION_REGISTRY
  //    which calls startFlow('ENQUIRY') → handleEnquiryFlow with message=null.
  'ENQUIRY',
  // ── [FIX-CANCEL-ALL] CANCEL_ALL button shown in MULTIPLE_ACTIVE_ORDERS context.
  // Must bypass intent detection so it reaches the CANCEL_ALL case in moduleRouter.
  'CANCEL_ALL',
  // ── Electronics module — flow-internal button IDs ─────────────────────────
  // CONFIRM_ITEM: "Order This" button on the spec detail card (ITEM_DETAIL step).
  //   Without this, tapping "Order This" goes through intent detection which detects
  //   action=ORDER and starts a NEW order flow, resetting the customer's chosen item.
  // CONFIRM_SUGGESTION: "Yes" button on the fuzzy-match suggestion card (SUGGEST_CONFIRM step).
  //   Without this, tapping "Yes" goes through intent detection which routes to FALLBACK.
  // CAT_* and PICK_[AB]_* are handled by the isFlowPassthroughId() regex above.
  'CONFIRM_ITEM',
  'CONFIRM_SUGGESTION',
  // ── [FIX-P1] Missing flow-internal IDs — caused silent dropped taps across all modules ──
  // CONFIRM: "✅ Confirm Order" button present in EVERY module's CONFIRM step.
  //   Without this entry, tapping Confirm was intercepted by intent detection which
  //   detected action=ORDER and RESTARTED the entire flow from scratch — the most
  //   customer-visible bug: customer fills out an order, taps confirm, order resets.
  'CONFIRM',
  // COLLECT: "🏪 Collect In-Store" button in bakery FULFILMENT step.
  //   Without this, tapping Collect triggered intent detection which had no ORDER
  //   match for "COLLECT" and fell through to FALLBACK — customer stuck at fulfilment.
  'COLLECT',
  // SKIN_NORMAL / SKIP_SKIN: cosmetics skin-type selector (SELECT_SKIN step).
  //   SKIN_DRY/OILY/COMBO were already registered but NORMAL and SKIP were missing —
  //   two of the four options on that card were silently broken.
  'SKIN_NORMAL',
  'SKIP_SKIN',
  // NOTES_NONE: "✅ No special notes" button in bakery NOTES step.
  //   Without this, tapping No Notes reset the flow (intent detection: ORDER action).
  'NOTES_NONE',
  // GIFT_NONE: "✅ No special requests" button in cosmetics GIFT_NOTE step.
  //   Same class of bug as NOTES_NONE — the skip-request tap was intercepted.
  'GIFT_NONE',
  // SLOT_MORNING/AFTERNOON/EVENING/TOMORROW: bakery PICKUP_TIME delivery window selector.
  //   SLOT_ASAP/30/1HR/SCHEDULE (delivery module) were registered but the four
  //   bakery-specific time-window IDs were not — the entire bakery slot picker was broken.
  'SLOT_MORNING',
  'SLOT_AFTERNOON',
  'SLOT_EVENING',
  'SLOT_TOMORROW',
  // WALKIN: salon "🚶 Join Walk-In Queue" button on the welcome card.
  //   Classified as a top-level action in the ACTION_REGISTRY but NOT in the
  //   passthrough set, so intent detection intercepted it before the router
  //   could dispatch to handleWalkInFlow. Registering here ensures clean bypass.
  'WALKIN',
  // CANCEL_BOOKING: booking cancellation button shown on booking status messages.
  //   Without this, tapping Cancel Booking goes through intent detection which may
  //   route to FALLBACK instead of the cancellation handler.
  'CANCEL_BOOKING',
  // ── [FIX-P2] Electronics flow-internal action buttons ─────────────────────
  // SPEC_REQUEST: "❓ Ask a Question" button on the ITEM_DETAIL card (active ORDER flow).
  //   Without this, tapping "Ask a Question" feeds the literal string "SPEC_REQUEST" to
  //   the flow handler's text branch, which passes it verbatim to the AI — producing
  //   a nonsensical response. Registering here ensures the raw ID reaches the flow
  //   handler's ITEM_DETAIL case which detects and dispatches it correctly.
  // WARRANTY: "🛡 Warranty Info" button shown after spec Q&A. Without passthrough,
  //   tapping it triggers intent detection → FALLBACK because 'WARRANTY' is not in
  //   intentEngine's keyword patterns.
  // NOTE: COMPARE is a top-level welcome-screen button (no active flow) and is therefore
  //   handled via BUTTON_ID_MAP in patterns.js, not here. Adding it to FLOW_PASSTHROUGH_IDS
  //   would only affect in-flow taps (correct placement stays in patterns.js).
  'SPEC_REQUEST',
  'WARRANTY',
  // [FIX-AOR-3] RESEND_PROOF is shown by activeOrderResolver when paymentStatus='rejected'.
  // Without this entry, tapping "📸 Upload New Proof" goes to intent detection → FALLBACK,
  // silently ignoring the customer's attempt to retry payment. Registering here ensures
  // the button tap bypasses intent detection and reaches the handler at step 14.7 (active
  // order resolver) or falls through cleanly to the payment proof flow at step 9/10.5.
  'RESEND_PROOF',
]);

// ── [FIX-BUG3] Hours enforcement ─────────────────────────────────────────────
function isWithinBusinessHours(hours) {
  // [FIX-ENV-2] DISABLE_WORKING_HOURS=true lets operators bypass hours checks
  // without touching BusinessConfig — useful for testing or temporary overrides.
  // Was exported from env.js but never read here, making the env var a no-op.
  if (process.env.DISABLE_WORKING_HOURS === 'true') return true;
  if (!hours?.enabled) return true; // hours checking disabled — always open
  try {
    const now = new Date();
    const tz  = hours.timezone || 'UTC';
    // Day-specific override
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayKey   = dayNames[now.getDay()];

    // [FIX-WH-3] Normalise hours.days to a plain object regardless of whether the
    // schema stored it as a Mongoose Map (has .get()) or a plain object (bracket
    // access). The previous dual-accessor (hours.days?.get?.(key) || hours.days?.[key])
    // was fragile — a future schema change could silently fall through to the wrong
    // branch. Normalise once here so the rest of the function uses simple bracket access.
    const daysObj = (hours.days instanceof Map)
      ? Object.fromEntries(hours.days)
      : (hours.days && typeof hours.days.toObject === 'function')
        ? hours.days.toObject()  // Mongoose Map .toObject()
        : (hours.days || {});
    const dayConfig = daysObj[dayKey];

    if (dayConfig?.closed) return false;

    const openHr  = dayConfig?.open  ?? hours.open  ?? 8;
    const closeHr = dayConfig?.close ?? hours.close ?? 22;

    // [FIX-15] Get current time as decimal hours (e.g. 22.5 = 22:30) in the
    // business timezone so minutes are respected. Previously only the integer
    // hour was checked, meaning a business closing at 22:30 effectively closed
    // at 22:00, and opening at 8:30 let messages through from 8:00.
    let currentDecimalHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    if (tz !== 'UTC') {
      try {
        const formatter = new Intl.DateTimeFormat('en', {
          timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
        });
        const parts = formatter.formatToParts(now);
        const hourPart   = parts.find(p => p.type === 'hour');
        const minutePart = parts.find(p => p.type === 'minute');
        if (hourPart) {
          const h = parseInt(hourPart.value, 10);
          const m = minutePart ? parseInt(minutePart.value, 10) : 0;
          currentDecimalHour = h + m / 60;
        }
      } catch { /* fall back to UTC decimal */ }
    }
    return currentDecimalHour >= openHr && currentDecimalHour < closeHr;
  } catch {
    return true; // on error, default open
  }
}

// ── [FIX-BUG4] Loop prevention ────────────────────────────────────────────────
async function checkAndHandleLoop(session, messageText, tenantId, business) {
  // [FIX-LOOP-2] MAX_LOOP is the maximum number of times the SAME message can be sent
  // consecutively before the bot breaks the loop. The first occurrence sets lastLoopMessage
  // (loopCount stays 0). Each subsequent identical message increments loopCount.
  // So loopCount=0 on first, 1 on second, 2 on third → break on third repeat (= 4th total send).
  // Set MAX_LOOP=2 to break on the 3rd total send (2nd repeat), which matches the comment
  // "after 3 identical consecutive messages" more intuitively.
  const MAX_LOOP = 2;
  const last     = session.lastLoopMessage;
  const step     = session.step;

  if (last === messageText && session.lastLoopStep === step) {
    const newCount = (session.loopCount || 0) + 1;
    if (newCount >= MAX_LOOP) {
      // [FIX-LOOP-1] Break loop — merge into a single updateSession call so a concurrent
      // request can't see an intermediate state (loopCount=MAX but flow still active)
      // that would trigger a second loop-break response. Previously two sequential writes.
      // [FIX-LOOP-4] Also clear postFlowAck here. If postFlowAck was set and the customer
      // got into a loop before the ack handler consumed it, the ack context is now stale
      // (the customer is clearly stuck, not responding to order context). Clearing it
      // ensures the main menu is shown cleanly without the ack handler intercepting the
      // very next message and sending an out-of-context reply.
      await updateSession(session.customerPhone, tenantId, {
        currentFlow: null, step: null, data: {},
        postFlowAck: null, postFlowData: null,
        loopCount: 0, lastLoopMessage: null, lastLoopStep: null,
        lastAorInterceptAt: null,
      });
      const cfg = getModeConfig(business);
      const loopMsg = business?.customMessages?.loopFallback
        || "I noticed we keep going in circles! Let me take you back to the main menu. 😊";
      return {
        type:    'buttons',
        body:    loopMsg,
        buttons: cfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
      };
    }
    // Not yet at limit — persist the incremented count
    await updateSession(session.customerPhone, tenantId, {
      loopCount: newCount, lastLoopMessage: messageText, lastLoopStep: step,
    });
  } else {
    // Different message — reset loop counter
    await updateSession(session.customerPhone, tenantId, {
      loopCount: 0, lastLoopMessage: messageText, lastLoopStep: step,
    });
  }
  return null; // no loop detected
}

// ── Message extraction ────────────────────────────────────────────────────────
function extractMessage(msgObj) {
  if (!msgObj) return { text: '', imageUrl: null, isInteractive: false, isListReply: false };
  const type = msgObj.type;

  if (type === 'text')
    return { text: (msgObj.text?.body || '').trim(), imageUrl: null, isInteractive: false, isListReply: false };

  if (type === 'interactive') {
    const btn  = msgObj.interactive?.button_reply;
    const list = msgObj.interactive?.list_reply;
    if (btn)  return { text: (btn.id  || btn.title  || '').trim(), isInteractive: true,  isListReply: false, imageUrl: null };
    if (list) return { text: (list.id || list.title || '').trim(), isInteractive: true,  isListReply: true,  imageUrl: null };
    return { text: '', isInteractive: true, isListReply: false, imageUrl: null };
  }
  if (type === 'image')
    return { text: '', imageUrl: msgObj.image?.id || null, isInteractive: false, isListReply: false };
  if (type === 'button')
    return { text: (msgObj.button?.payload || '').trim(), isInteractive: true, isListReply: false, imageUrl: null };

  return { text: '', imageUrl: null, isInteractive: false, isListReply: false };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function handleIncomingMessage({ tenantId, tenantDoc, from, msgObj, phoneNumberId }) {
  const { text: messageText, imageUrl, isInteractive, isListReply } = extractMessage(msgObj);
  const wamid = msgObj?.id;

  logger.debug('[Webhook] handleIncomingMessage', {
    tenantId,
    from,
    type: msgObj?.type,
    wamid,
    textPreview: messageText ? messageText.slice(0, 60) : null,
    hasImage: !!imageUrl,
  });

  // ── 1. De-duplicate ───────────────────────────────────────────────────────
  if (wamid) {
    try {
      await ProcessedMessage.create({ wamid, tenantId });
    } catch (err) {
      if (err.code === 11000) {
        logger.debug('[Webhook] Duplicate wamid — already processed, skipping', { wamid, from, tenantId });
        return;
      }
      // [FIX-WH-7] Any non-duplicate DB error (connection lost, schema violation, etc.)
      // is re-thrown so the message is NOT processed. Previously the catch block only
      // handled 11000 and silently fell through for all other errors — message processing
      // continued without a dedup record, so a webhook retry would process the message
      // twice with no record to deduplicate against.
      logger.error('[Webhook] ProcessedMessage write failed — dropping message to preserve dedup guarantee', {
        wamid, tenantId, from, err: err.message,
      });
      return;
    }
  }

  // ── 2. Empty guard ────────────────────────────────────────────────────────
  if (!messageText && !imageUrl) {
    logger.debug('[Webhook] Message has no text and no image — skipping', {
      from, tenantId, msgType: msgObj?.type,
    });
    return;
  }

  // ── 3. Load business ──────────────────────────────────────────────────────
  const business = await BusinessConfig.findOne({ tenantId }).lean().catch((err) => {
    logger.error('[Webhook] BusinessConfig query failed', { tenantId, from, err: err.message });
    return null;
  });
  if (!business) {
    logger.warn('[Webhook] ✗ No BusinessConfig found for tenant — message dropped', {
      tenantId,
      from,
      tip: 'Run the seed script or create a BusinessConfig for this tenant',
    });
    return;
  }

  // ── 4. Session ────────────────────────────────────────────────────────────
  let session = await getSession(from, tenantId);
  if (!session) {
    // [FIX-HM-4] Before creating a blank new session, check whether an EXPIRED session
    // had humanMode=true. If so, restore it — the admin never typed RESUME BOT so
    // the bot must stay silent. A TTL expiry must never silently re-enable the bot.
    const expiredHumanSession = await (async () => {
      try {
        const Session = (await import('../models/Session.js')).default;
        // Build the composite key directly — avoids an import that could fail and
        // produce 'undefined_tenantId' if sessionKey destructuring returned undefined.
        const key = `${from}_${tenantId}`;
        // [FIX-2.3] Filter on expiresAt: { $lte: new Date() } so this query only
        // matches genuinely expired sessions. Without the bound it would also match
        // any live session with humanMode=true if getSession's filter ever relaxes,
        // risking a duplicate upsert on top of an active document.
        return await Session.findOne({
          phone:     key,
          tenantId:  String(tenantId),
          humanMode: true,
          expiresAt: { $lte: new Date() },  // only expired sessions
        }).sort({ updatedAt: -1 }).lean();
      } catch { return null; }
    })();

    const preservedHumanMode = expiredHumanSession?.humanMode === true;
    session = await createSession(from, tenantId, {
      phoneNumberId,
      // [FIX-WH-3] Pass humanMode directly so createSession writes it via $set in a single
      // atomic upsert. The old approach passed a dead key (_restoreHumanMode) that createSession
      // never read, then called a separate updateSession() — a two-step operation with a race
      // window where a concurrent message could see humanMode=false between the two writes.
      ...(preservedHumanMode ? { humanMode: true } : {}),
    });

    if (preservedHumanMode) {
      logger.info('[Webhook] Restored humanMode=true from expired session', { from, tenantId });
    }

    // [FIX-WH-1] createSession uses findOneAndUpdate with { new: true } and already
    // returns the freshly written document. The previous follow-up getSession call was
    // redundant (an extra DB round-trip on every new session) and the || session fallback
    // meant it only helped in the theoretically impossible case where the document
    // vanished between write and read. Removed.
  }
  // [FIX-WH-2] Log failures rather than swallowing them silently. phoneNumberId is
  // used for routing — a silent failure here could cause messages to be dispatched
  // on the wrong WhatsApp number for businesses with multiple phone number IDs.
  // [FIX-2.4] Use $inc for messageCount so concurrent webhooks (WhatsApp occasionally
  // delivers duplicate wamids with different IDs) can't both read the same snapshot
  // count and write count+1, losing an increment. The fourth argument to updateSession
  // is the atomic $inc map added in sessionService [FIX-SES-7].
  updateSession(from, tenantId, {
    lastSeen:      new Date(),
    phoneNumberId: phoneNumberId || session.phoneNumberId,
  }, { messageCount: 1 }).catch(err => logger.warn('[Webhook] Non-critical session update failed', { err: err.message, from }));

  // ── 5. [FIX-BUG3] Business hours enforcement ──────────────────────────────
  // Apply to ALL message types — button taps during closed hours must also be blocked.
  if (!isWithinBusinessHours(business.hours)) {
    // [PFH-3 / BIZ-HOURS] Exempt customers with active confirmed orders from the closed gate.
    // A customer who just paid and is waiting for their order must not receive "we're closed"
    // — it's confusing, alarming, and wrong. We let their message through to postFlowAck.
    const hasActiveOrder = await Order.exists({
      customerPhone: from, tenantId,
      status:        { $in: ['confirmed', 'pending', 'ready'] },
      paymentStatus: { $nin: ['cancelled', 'rejected'] },
    }).catch(() => false);

    if (!hasActiveOrder) {
      const closedMsg = business?.customMessages?.closed
        || business?.settings?.closedMessage
        || `⏰ We're currently closed. Please contact us during business hours.`;
      // Only reply once per closed period — guard against spam
      if (!session.closedMsgSent) {
        await updateSession(from, tenantId, { closedMsgSent: true });
        await dispatchMessage(from, { type: 'text', body: closedMsg }, tenantDoc);
      } else {
        logger.debug('[Webhook] Outside business hours — closed message already sent, suppressing reply', {
          from, tenantId,
        });
      }
      return;
    }
    // Active-order customer — skip closed gate and fall through to postFlowAck handler
    logger.debug('[Webhook] Business closed but customer has active order — exempted from closed gate', { from });
  }
  // Clear closedMsgSent once we're open again — awaited so a DB failure is visible in logs.
  // [FIX-WH-CLOSED] Also touch `lastSeen` here to extend the session TTL. Without it, a
  // session that is near its expiry boundary could match the findOneAndUpdate and then be
  // TTL-expired by MongoDB milliseconds later, losing the flag reset. The fire-and-forget
  // lastSeen update at step 4 runs concurrently and may not win the race on a near-expiry
  // document; a dedicated write here ensures the TTL is always extended before the flag clear.
  // [FIX-WH-CLOSED-2] For long-lived sessions (payment TTL = 4h, humanMode TTL = 24h)
  // closedMsgSent can remain true across a closed period and into the next open window.
  // When it is true at this point (business IS open), send a proactive "we're open again"
  // message before clearing the flag so the customer isn't silently dropped on their first
  // morning message after the flag was set the night before.
  if (session.closedMsgSent) {
    const reopenMsg = business?.customMessages?.reopened
      || `✅ Good news — we're open again! How can we help you? 😊`;
    await updateSession(from, tenantId, { closedMsgSent: false, lastSeen: new Date() });
    await dispatchMessage(from, { type: 'text', body: reopenMsg }, tenantDoc);
    // [FIX-CLOSED-3] Do NOT return here. Previously we returned after sending the
    // reopen notice, silently dropping the customer's actual message (e.g. "I want to
    // order"). They would need to repeat themselves to get a response. Instead, fall
    // through so the message is also routed normally — the customer gets both the
    // reopen notice AND a response to what they actually typed in the same turn.
  }

  // ── 6. Admin commands (checked BEFORE humanMode guard) ──────────────────
  // [FIX-HM-7] Admin commands must be processed before the humanMode guard.
  // Previously step 8 (admin commands) was after step 6 (humanMode block).
  // When the admin uses the same phone number to test the bot as a customer,
  // their session can have humanMode=true — which silently blocked "RESUME BOT"
  // at step 6, so the bot never saw the admin's command and humanMode was stuck.
  // Fix: check ALL admin commands (text AND button) FIRST. Non-admin messages
  // still hit the humanMode guard below and are silently dropped as before.
  if (messageText) {
    const upper = messageText.trim().toUpperCase();

    // Admin TEXT commands: APPROVE / REJECT / CONFIRM BOOK / DECLINE BOOK / RESUME BOT
    // [FIX-WH-5] Use === / startsWith(' ') instead of bare startsWith('RESUME BOT') so
    // 'RESUME BOTNET ...' doesn't trigger an unnecessary isAdminPhone DB round-trip.
    // [FIX-MARK-READY-CMD] Added 'MARK READY ' to the admin text command prefixes.
    // Previously 'MARK READY <shortId>` was not listed here, so it bypassed the admin
    // guard entirely and fell through to humanMode (silently dropped if admin is in
    // humanMode) or intent detection (routed to FALLBACK). The command WAS handled in
    // handleAdminTextCommand() but was never reached.
    if (
      upper.startsWith('APPROVE ')      ||
      upper.startsWith('REJECT ')       ||
      upper.startsWith('CONFIRM BOOK ') ||
      upper.startsWith('DECLINE BOOK ') ||
      upper.startsWith('MARK READY ')   ||
      upper === 'RESUME BOT' || upper.startsWith('RESUME BOT ')
    ) {
      const { handleAdminTextCommand, isAdminPhone } = await import('../services/adminCommandService.js');
      // [FIX-X2] Pass pre-fetched business and tenantDoc so isAdminPhone skips both DB queries.
      const isAdmin = await isAdminPhone(from, tenantId, business, tenantDoc).catch(() => false);
      if (isAdmin) {
        const adminReply = await handleAdminTextCommand(messageText, tenantId, from, tenantDoc, business).catch(() => null);
        if (adminReply) {
          // [FIX-ADMIN-DISPATCH] adminReply may be a string (most commands) OR a full
          // dispatch payload object (e.g. confirmPayment returns {type:'buttons',...} with
          // READY_ button). Previously always wrapped as { type:'text', body } — that would
          // send the object stringified as "[object Object]" to the admin.
          const adminPayload = typeof adminReply === 'string'
            ? { type: 'text', body: adminReply }
            : adminReply;
          await dispatchMessage(from, adminPayload, tenantDoc);
        }
        return; // admin text commands never fall through — not even to humanMode guard
      }
    }

    // Admin BUTTON replies: APPROVE_xxx / REJECT_xxx / CONFIRM_BOOK_xxx / DECLINE_BOOK_xxx / READY_xxx / RESUME_BOT_xxx
    // [FIX-READY-BTN-GATE] Added READY_ to the admin button prefix check.
    // Previously READY_<shortId> was handled by handleAdminButtonReply() but was not
    // listed in this guard. It fell through to the non-admin branch which dispatched
    // "Sorry, that action isn't available" back to the admin who tapped their own button.
    // [FIX-RESUME-BTN-GATE] Added RESUME_BOT_ — the button sent by the SUPPORT escalation
    // alert (moduleRouter). Without this, tapping "▶️ Resume Bot" produced "Sorry, that
    // action isn't available" rather than calling resumeBot() in adminCommandService.
    if (isInteractive && (
      upper.startsWith('APPROVE_') || upper.startsWith('REJECT_') ||
      upper.startsWith('CONFIRM_BOOK_') || upper.startsWith('DECLINE_BOOK_') ||
      upper.startsWith('READY_') || upper.startsWith('RESUME_BOT_')
    )) {
      const { handleAdminButtonReply, isAdminPhone } = await import('../services/adminCommandService.js');
      // [FIX-X2] Pass pre-fetched business and tenantDoc so isAdminPhone skips both DB queries.
      const isAdmin = await isAdminPhone(from, tenantId, business, tenantDoc).catch(() => false);
      if (isAdmin) {
        const reply = await handleAdminButtonReply(messageText, tenantId, from, tenantDoc, business).catch(() => null);
        if (reply) {
          // [FIX-ADMIN-DISPATCH] reply may be string OR payload object
          const replyPayload = typeof reply === 'string' ? { type: 'text', body: reply } : reply;
          await dispatchMessage(from, replyPayload, tenantDoc);
        }
        return; // admin button replies never fall through
      }
      // [FIX-2.2] Non-admin tapping a stale admin button (e.g. a forwarded approval
      // message) previously returned silently, leaving the customer with no feedback.
      // Send a neutral fallback so the customer knows the tap was received but that
      // the action isn't available to them, preventing a confusing no-response UX.
      logger.warn('[Webhook] Non-admin tapped admin button — sending fallback', { from, buttonId: messageText });
      await dispatchMessage(from, {
        type: 'text',
        body: "Sorry, that action isn't available. How can I help you? 😊",
      }, tenantDoc);
      return;
    }
  }

  // ── 7. Human mode ─────────────────────────────────────────────────────────
  // Non-admin messages are silently dropped here when humanMode=true.
  // The admin can still reach step 6 above regardless of their own session state.
  if (session.humanMode) {
    logger.info('[Webhook] Human mode active — bot is silent for this customer. Admin must type RESUME BOT to re-enable.', {
      from,
      tenantId,
      messagePreview: messageText?.slice(0, 60) || '(no text)',
    });
    return;
  }

  // ── 8. [FIX-BUG4] Loop prevention (text AND button taps) ─────────────────
  // Previously this only ran for !isInteractive — button loops were unchecked.
  // [FIX-LOOP-3] Guard skips active flows: a customer legitimately typing the
  // same answer twice mid-flow (e.g. re-entering a quantity, re-confirming an
  // address) was being loop-broken after 3 identical inputs even though the flow
  // engine was correctly handling each one. Loop detection only applies at the
  // top-level menu / intent layer where true looping can occur.
  if (messageText && !session.currentFlow) {
    const loopReply = await checkAndHandleLoop(session, messageText, tenantId, business);
    if (loopReply) {
      await dispatchMessage(from, loopReply, tenantDoc);
      return;
    }
  }

  // ── 8.5. Non-text image guard ─────────────────────────────────────────────
  // Images sent outside the ORDER/PAYMENT_PROOF context have messageText='' and
  // would otherwise fall through to intent detection with an empty string, producing
  // erratic matches. Reply with a gentle prompt and stop processing.
  if (imageUrl && !(session.currentFlow === 'ORDER' && session.step === 'PAYMENT_PROOF')) {
    await dispatchMessage(from, {
      type: 'text',
      body: '📎 Thanks for the image! I can only accept screenshots as payment proof during checkout. Is there something else I can help you with?',
    }, tenantDoc);
    return;
  }

  // ── 9. Payment proof image ────────────────────────────────────────────────
  if (imageUrl && session.currentFlow === 'ORDER' && session.step === 'PAYMENT_PROOF') {
    const { receiveProof } = await import('../services/paymentService.js');
    try {
      const reply = await receiveProof(from, tenantId, imageUrl, tenantDoc);
      await dispatchMessage(from, { type: 'text', body: reply }, tenantDoc);
      // [FIX-PAY-4] Do NOT set postFlowAck here. postFlowAck='ORDER' causes the bot
      // to reply "we're preparing your order" if the customer types "thanks" — but at
      // this point the admin hasn't approved yet (paymentStatus='proof_received').
      // postFlowAck is set by adminCommandService.confirmPayment() after the admin
      // explicitly approves. Clear the active flow but leave postFlowAck null.
      await updateSession(from, tenantId, { currentFlow: null, step: null });
    } catch (err) {
      logger.error('[Webhook] receiveProof failed', { err: err.message });
      await dispatchMessage(from, {
        type:    'buttons',
        body:    '⚠️ Could not process your screenshot. Please try again — send a clear image of your payment confirmation.',
        buttons: [{ id: 'SUPPORT', title: '💬 Contact Support' }],
      }, tenantDoc);
    }
    return;
  }

  // ── 10. DONE payment — gated on requireProof===false ──────────────────────
  if (
    messageText.trim().toUpperCase() === 'DONE' &&
    session.currentFlow === 'ORDER' &&
    session.step === 'PAYMENT_PROOF' &&
    business?.payment?.requireProof === false
  ) {
    const { handleDonePayment } = await import('../services/paymentService.js');
    // [FIX-PAY-1] Pass tenantDoc so handleDonePayment can dispatch buttons directly.
    // When it returns null the message is already sent; only dispatch if a string is returned.
    const reply = await handleDonePayment(from, tenantId, tenantDoc).catch(() => "✅ Thank you! We'll confirm your order shortly.");
    if (reply) await dispatchMessage(from, { type: 'text', body: reply }, tenantDoc);
    await updateSession(from, tenantId, { currentFlow: null, step: null, postFlowAck: null });
    return;
  }

  // ── 10.5. PAYMENT_PROOF — strict text guard ───────────────────────────────
  // Any text while awaiting a payment screenshot is intercepted here.
  // NOTHING bleeds through to intent detection / order restart from this stage.
  if (
    session.currentFlow === 'ORDER' &&
    session.step        === 'PAYMENT_PROOF' &&
    !imageUrl
  ) {
    const upper = messageText.trim().toUpperCase();

    // [FIX-PAY-5] DONE typed/tapped at PAYMENT_PROOF step when requireProof=true:
    // The "Sent Screenshot" button was removed (paymentService FIX-PAY-5) but the
    // customer could still type "DONE". Give a targeted response explaining that a
    // screenshot image is required, not a text confirmation.
    if (upper === 'DONE' && business?.payment?.requireProof !== false) {
      await dispatchMessage(from, {
        type:    'buttons',
        body:    '📸 *Please send a screenshot image* of your payment confirmation.\n\n' +
                 'Open your Wave (or payment) app, take a screenshot of the successful transfer, and send the image here.',
        buttons: [
          { id: 'SUPPORT', title: '❓ Need Help'    },
          { id: 'CANCEL',  title: '❌ Cancel Order' },
        ],
      }, tenantDoc);
      return;
    }

    // Allow explicit cancellation or order restart
    if (upper === 'CANCEL' || upper === 'CANCEL_ORDER' || upper === 'NEW_ORDER' || upper === 'ORDER') {
      // [FIX-IMPORT-2] Order now a top-level import — removed redundant dynamic import
      await Order.findOneAndUpdate(
        { customerPhone: from, tenantId, paymentStatus: { $in: ['unpaid', 'proof_received'] } },
        { $set: { status: 'cancelled', paymentStatus: 'cancelled' } },
        { sort: { createdAt: -1 } }
      ).catch(() => {});
      await updateSession(from, tenantId, { currentFlow: null, step: null, data: {} });
      const cfg = getModeConfig(business);
      await dispatchMessage(from, {
        type:    'buttons',
        body:    '❌ Your order has been cancelled.\n\nWhat would you like to do next?',
        buttons: cfg.ui?.welcomeButtons || [{ id: 'ORDER', title: '🛒 Place New Order' }],
      }, tenantDoc);
      return;
    }

    // [FIX-SUPPORT-PROOF] Allow SUPPORT escape from PAYMENT_PROOF step.
    // Previously step 10.5 intercepted ALL text including SUPPORT, showing "awaiting
    // screenshot" in response to the customer tapping the "❓ Need Help" button — which
    // is shown on the payment instructions card. The customer was stuck: they couldn't
    // escalate to a human without cancelling. Now SUPPORT falls through to intent
    // detection which routes to the SUPPORT case in moduleRouter → human handoff.
    if (upper === 'SUPPORT') {
      // Don't return — fall through to intent detection at step 16
      // (no session currentFlow clear needed; the SUPPORT case in moduleRouter does it)
    } else {
      // All other text (greetings, questions, anything) → strict reminder
      await dispatchMessage(from, {
        type:    'buttons',
        body:
          '⏳ *Awaiting your payment screenshot.*\n\n' +
          'Please send a clear image of your payment confirmation (screenshot) to complete your order.\n\n' +
          '_To cancel this order, tap the button below._',
        buttons: [{ id: 'CANCEL', title: '❌ Cancel Order' }],
      }, tenantDoc);
      return;
    }
  }

  // ── 11. [Admin button replies moved to step 6 — before humanMode guard] ────

  // ── 11.5. AWAIT_ADMIN_CONFIRM guard ──────────────────────────────────────
  // After a cash/delivery order is placed the session stays in currentFlow=ORDER,
  // step=AWAIT_ADMIN_CONFIRM. Nothing should happen until the admin confirms or
  // rejects via their APPROVE_/REJECT_ button. All customer input at this stage
  // — including tapping stale buttons like "Place New Order" — is intercepted here.
  if (session.currentFlow === 'ORDER' && session.step === 'AWAIT_ADMIN_CONFIRM') {
    const upper = messageText.trim().toUpperCase();
    // Allow explicit cancel only
    if (upper === 'CANCEL' || upper === 'CANCEL_ORDER') {
      // [FIX-IMPORT-2] Order now a top-level import — removed redundant dynamic import
      await Order.findOneAndUpdate(
        { customerPhone: from, tenantId, status: 'pending' },
        { $set: { status: 'cancelled' } },
        { sort: { createdAt: -1 } }
      ).catch(() => {});
      await updateSession(from, tenantId, { currentFlow: null, step: null, data: {} });
      const cfg = getModeConfig(business);
      await dispatchMessage(from, {
        type:    'buttons',
        body:    '❌ Your order has been cancelled.\n\nWhat would you like to do?',
        buttons: cfg.ui?.welcomeButtons || [{ id: 'ORDER', title: '🛒 Place New Order' }],
      }, tenantDoc);
      return;
    }
    // Everything else — classify ack/filler first, then politely hold the customer
    const AAC_ACK_RE = /^(ok|okay|k|thanks?|thank\s*you|thx|got\s*it|noted|alright|cool|nice|great|sure|👍|🙏|😊|ahhh?|ohh?|hmm+|wow|yay|np|sure\s*i\s*do|i\s*will|will\s*do|definitely|absolutely|of\s*course|certainly|for\s*sure|yeah|yes|indeed|right|totally|agreed)$/i;
    if (AAC_ACK_RE.test(messageText.trim()) || messageText.trim().length <= 2) {
      await dispatchMessage(from, {
        type: 'text',
        body: `😊 Your order is being reviewed by our team. We'll notify you shortly!`,
      }, tenantDoc);
      return;
    }
    await dispatchMessage(from, {
      type: 'text',
      body: '⏳ Your order is currently being reviewed by our team.\n\nYou\'ll receive a confirmation message shortly. Please hold on! 🙏',
    }, tenantDoc);
    return;
  }

  // ── 11.7. PENDING ORDER LOCK ─────────────────────────────────────────────
  // Fires ONLY when there is no active session flow (currentFlow===null).
  // When a customer submits a payment screenshot (step 9) the controller clears
  // currentFlow/step but sets no postFlowAck, so the very next message ("hi",
  // button tap, anything) fell straight through to step 16 intent detection,
  // hit GREET, called startFlow() which reset the session, and showed the welcome
  // menu — letting the customer place a brand new order while the first one was
  // still pending admin approval.
  //
  // This guard queries for any Order in a pre-approval state and locks the
  // conversation until the admin acts.  Covered states:
  //   • proof_received  — screenshot submitted, admin hasn't acted yet
  //   • unpaid          — payment instructions shown, no screenshot yet
  //   • self_confirmed  — requireProof=false path, admin prep pending
  //
  // Escape hatches:
  //   • CANCEL / CANCEL_ORDER  → cancels the pending order and releases lock
  //   • SUPPORT                → falls through to SUPPORT intent (human handoff)
  //   • Everything else        → strict "you have a pending order" reminder
  if (!session.currentFlow) {
    const upperPOL  = messageText.trim().toUpperCase();
    // [FIX-POL-1] Expanded escape list — navigation intents (ORDER, BOOK, SHOW_MENU,
    // CANCEL_ALL, MENU, HOME) must bypass the pending order lock so customers can
    // start a new flow or bulk-cancel. Previously "Cancel all", "Order Food" button tap,
    // and "Show Menu" were all blocked by the lock even though they're valid top-level
    // actions. The lock is meant to block RANDOM messages (greetings, status queries),
    // not deliberate navigation. The _cancelAllPattern handles "cancel all" / "cancel all of them"
    // typed as free text, plus "cancel everything" and similar natural phrasings.
    const _polCancelAllRe = /^cancel\s+(all(\s+of\s+(them|the\s+orders?))?|everything|it\s+all|all\s+my\s+orders?)$/i;
    const isEscPOL  = upperPOL === 'CANCEL' || upperPOL === 'CANCEL_ORDER'
      || upperPOL === 'CANCEL_ALL' || _polCancelAllRe.test(messageText.trim())
      || upperPOL === 'ORDER' || upperPOL === 'BOOK'
      || upperPOL === 'SHOW_MENU' || upperPOL === 'MENU' || upperPOL === 'HOME'
      || upperPOL === '0' || upperPOL === 'START_ORDER' || upperPOL === 'START_BOOKING';
    const isSuppPOL = upperPOL === 'SUPPORT';

    // [FIX-IMPORT-2] Order now a top-level import — removed redundant dynamic import
    const pendingOrder = await Order.findOne({
      customerPhone: from,
      tenantId,
      paymentStatus: { $in: ['proof_received', 'unpaid', 'self_confirmed'] },
      status:        { $nin: ['cancelled', 'confirmed', 'completed'] },
    }).select('_id item quantity shortId paymentStatus').sort({ createdAt: -1 }).lean().catch(() => null);

    if (pendingOrder) {
      // ── Cancel escape ────────────────────────────────────────────────────
      if (isEscPOL) {
        await Order.findOneAndUpdate(
          { _id: pendingOrder._id },
          { $set: { status: 'cancelled', paymentStatus: 'cancelled' } }
        ).catch(() => {});
        await updateSession(from, tenantId, { currentFlow: null, step: null, data: {} });
        const cfgPOL = getModeConfig(business);
        await dispatchMessage(from, {
          type:    'buttons',
          body:    `❌ Your order *#${pendingOrder.shortId}* has been cancelled.\n\nWhat would you like to do next?`,
          buttons: cfgPOL.ui?.welcomeButtons || [{ id: 'ORDER', title: '🛒 Place New Order' }],
        }, tenantDoc);
        return;
      }

      // ── Support escape — fall through to intent detection ────────────────
      if (!isSuppPOL) {
        // ── [SPEC-4A/4B/4C/4D] ACKNOWLEDGEMENT classifier ───────────────────
        // Short filler inputs while an order is pending must never show the full
        // lock message — they get a calm, human micro-reply and the state stays locked.
        // This fixes the production bug where "Ahhh" triggered a full welcome greeting
        // because the lock hadn't fired yet and intent detection ran GREET instead.
        // Now the lock fires first and classifies filler/acks before anything else.
        const POL_ACK_RE = /^(ok|okay|k|kk|thanks?|thank\s*you|thank\s*u|thx|ty|tq|great|perfect|got\s*it|noted|alright|cool|nice|sounds\s*good|good|👍|🙏|😊|yep|yh|yah|understood|cheers|appreciate\s*it|brilliant|wonderful|awesome|lovely|received|sure|fine|no\s*problem|np|ahhh?|ohh?|hmm+|wow|oh|yay|phew|aight|sure\s*i\s*do|i\s*will|will\s*do|definitely|absolutely|of\s*course|certainly|for\s*sure|sure\s*thing|yeah|yes|yes\s*please|indeed|exactly|right|totally|agreed|fair\s*enough)$/i;
        const rawTrimPOL = messageText.trim();
        // [FIX-BUG10] rawTrimPOL.length <= 3 was too aggressive — a 3-char input like
        // "bad" is a genuine complaint that deserves the lock message, not a micro-reply.
        // Replace the bare length check with a tighter pattern that only catches:
        //   • Single emoji (e.g. 👍, 🙏, 😊)
        //   • 1–2 char non-word inputs that POL_ACK_RE didn't cover (e.g. bare "k", "?")
        // 3-char alphabetic inputs now fall through to the normal lock-message path so
        // "bad", "why", "lol" etc. are classified properly rather than silently muted.
        const isMicroInputPOL = POL_ACK_RE.test(rawTrimPOL) ||
          /^\p{Emoji_Presentation}$/u.test(rawTrimPOL) ||
          (rawTrimPOL.length <= 2 && !/[a-z]{2}/i.test(rawTrimPOL));
        if (isMicroInputPOL) {
          const statusLabel = {
            proof_received: 'Your payment screenshot has been received and is being reviewed.',
            unpaid:         'Please send your payment screenshot to complete the order.',
            self_confirmed: 'Your order is being prepared by our team.',
          }[pendingOrder.paymentStatus] || 'Your order is being processed.';
          await dispatchMessage(from, {
            type: 'text',
            body: `😊 ${statusLabel} We'll notify you shortly!`,
          }, tenantDoc);
          return;
        }

        // ── [SPEC-4E] Frustration signal — apologise + reassure ─────────────
        const FRUSTRATION_RE = /\b(i\s*(just|already)\s*said|stop\s*(repeating|asking)|you\s*(forgot|already|keep)|again\??|said\s*that|i\s*know|seriously|really\??|wtf|what\s*the)\b/i;
        if (FRUSTRATION_RE.test(rawTrimPOL)) {
          await dispatchMessage(from, {
            type: 'text',
            body: `Sorry about that! 😊\n\nYour order *#${pendingOrder.shortId}* is still being processed — nothing more needed from your side. We'll notify you when it's ready.`,
          }, tenantDoc);
          return;
        }

        // ── [SPEC-4F] Status enquiry ─────────────────────────────────────────
        const STATUS_RE = /\b(when|how\s*long|any\s*update|update|status|ready|how\s*soon|still|waiting|where\s*(is|are))\b/i;
        if (STATUS_RE.test(rawTrimPOL)) {
          const statusMsgStatus = {
            proof_received: `⏳ Your payment screenshot has been received and our team is reviewing it.\n\nWe'll confirm shortly 🙏`,
            unpaid:         `⏳ We're waiting for your payment screenshot. Please send it here to proceed.`,
            self_confirmed: `⏳ Your order is being prepared by our team.\n\nEstimated time: 20–30 minutes from when your order was accepted.`,
          }[pendingOrder.paymentStatus] || `⏳ Your order is being processed by our team.`;
          await dispatchMessage(from, { type: 'text', body: statusMsgStatus }, tenantDoc);
          return;
        }

        // ── All other messages: full lock reminder ───────────────────────────
        const statusMsgPOL = {
          proof_received: `⏳ *Awaiting verification* — your payment screenshot has been received and our team is reviewing it.`,
          unpaid:         `⏳ *Awaiting payment* — please send your payment screenshot to complete the order.`,
          self_confirmed: `⏳ *Order received* — our team is preparing your order.`,
        }[pendingOrder.paymentStatus] || `⏳ Your order is being processed by our team.`;

        await dispatchMessage(from, {
          type: 'buttons',
          body:
            `🔒 *You have a pending order*\n\n` +
            `🛒 *${pendingOrder.item}* × ${pendingOrder.quantity}\n` +
            `🔖 Ref: \`#${pendingOrder.shortId}\`\n\n` +
            `${statusMsgPOL}\n\n` +
            `_Please wait for confirmation before placing a new order._`,
          buttons: [
            { id: 'CANCEL',  title: '❌ Cancel Order'     },
            { id: 'SUPPORT', title: '💬 Contact Support'  },
          ],
        }, tenantDoc);
        return;
      }
    }
  }

  // ── 12. LEAD_CAPTURE active flow ──────────────────────────────────────────
  if (session.currentFlow === 'LEAD_CAPTURE') {
    const { handleLeadCapture } = await import('../services/leadCaptureService.js');
    const reply = await handleLeadCapture(session, messageText, business, tenantDoc);
    if (reply) await dispatchMessage(from, reply, tenantDoc);
    return;
  }

  // ── 13. ENQUIRY active flow ───────────────────────────────────────────────
  if (session.currentFlow === 'ENQUIRY') {
    if (session.step === 'AWAITING_QUESTION') {
      await updateSession(from, tenantId, { step: 'ANSWERED' });
      const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
      const aiText = await getAIReply({ customerMessage: messageText, business, session, intent: 'QUESTION' });
      // [FIX-ENQ-1] Clear the flow AFTER dispatching the reply, not before.
      // The previous order (clear → dispatch) meant that if dispatchMessage threw,
      // the session was already cleared: the customer got no response, and their next
      // message would not re-enter the ENQUIRY step — it would just hit intent
      // detection again. Now we clear after a confirmed (awaited) dispatch so the
      // session only advances on success.
      await dispatchMessage(from, {
        type:    'buttons',
        body:    aiText || 'Let me check that for you. 😊',
        buttons: [
          { id: 'QUESTION',  title: '❓ Ask again'  },
          { id: 'SHOW_MENU', title: '🔄 Start Over' },
        ],
      }, tenantDoc);
      await updateSession(from, tenantId, { currentFlow: null, step: null });
      return;
    }
    // Stale ANSWERED state — just clear and fall through
    await updateSession(from, tenantId, { currentFlow: null, step: null });
  }

  // ── 14. Post-flow acknowledgement — context-aware + customer-aware ───────────
  // Handles any message sent AFTER a completed/confirmed/rejected flow.
  // Distinguishes: simple acks, compliments, complaints, follow-up questions.
  // [FIX-ACK-1] Now enriched with persistent customer context (order count, top item,
  // returning status) from customerMemory so responses feel genuinely personalised
  // rather than generic. New vs returning customers get different tones throughout.
  // ── 14. postFlowAck state machine ─────────────────────────────────────────
  // [PFH-1] Extracted to services/postFlowHandler.js for testability and maintainability.
  // Previously ~600 lines of inline logic; now a single delegating call.
  if (session.postFlowAck && messageText) {
    const { getCustomerContext } = await import('../core/memory/customerMemory.js');
    const custCtxPFA = await getCustomerContext(from, tenantId).catch(() => ({
      name: null, topItem: null, lastItem: null, lastOrderAt: null, orderCount: 0, isReturning: false,
    }));

    const handled = await handlePostFlowMessage({
      ackCtx:      session.postFlowAck,
      flowData:    session.postFlowData || {},
      session,
      messageText,
      isInteractive,
      business,
      tenantDoc,
      from,
      tenantId,
      custCtx: custCtxPFA,
    });

    if (handled) return;
    // handled=false means an unknown ackCtx that was already cleared — fall through to intent detection
  }

  // ── 14.4. Active Order Resolver gate ─────────────────────────────────────
  // [FIX-AOR-1] Runs after postFlowAck (step 14) so that ORDER_CONFIRMED/ORDER_READY
  // ackCtx messages still get their contextual replies. After the ackCtx is consumed
  // on the first follow-up message, subsequent messages from customers with an active
  // confirmed/preparing/ready order were falling through to intent detection and getting
  // a generic greeting or ACKNOWLEDGE micro-reply with no order context. The resolver
  // provides the correct order-state card for all subsequent messages.
  //
  // Escape hatches — skip the resolver and fall through to normal routing:
  //   • Any message that still had a postFlowAck (already handled at step 14)
  //   • CANCEL / CANCEL_ORDER / SUPPORT — the customer is acting, not just messaging
  //   • Short-circuit: skip when the session still has an active flow (handled at step 15)
  //
  // [FIX-AOR-5] Throttle: the resolver must not fire on every single message — a customer
  // typing "Ahh", "Ahh", "Ahh" would get the preparing card 3 times before loop detection
  // fires. This is the root cause of the triple "Being prepared" bug seen in production.
  // Throttle mirrors the ACKNOWLEDGE case in moduleRouter: only show the preparing card
  // once per 5-minute window. Subsequent messages within the window fall through to normal
  // routing (intent detection → ACKNOWLEDGE → throttled soft menu or loop detection).
  if (!session.currentFlow && !session.postFlowAck && messageText) {
    const _aorUpper = messageText.trim().toUpperCase();
    // [FIX-AOR-4] Expanded escape list — CANCEL_ALL and navigation intents bypass the
    // resolver so customers can deliberately start a new flow or bulk-cancel.
    const _cancelAllPattern = /^cancel\s+(all(\s+of\s+(them|the\s+orders?))?|everything|it\s+all|all\s+my\s+orders?)$/i;
    // [FIX-AOR-SUPPORT] Natural-language support/help phrases must also escape the AOR
    // so customers can reach a human even when an active order is being tracked.
    // Previously only the literal button ID 'SUPPORT' was checked — "i want to talk to human",
    // "i need help", etc. all bypassed the escape and got the preparing card instead.
    const _aorSupportRe = /\b(help|support|admin|human|agent|person|team|manager|someone|speak\s*to|talk\s*to|contact|escalat)\b/i;
    const _aorIsEscape = _aorUpper === 'CANCEL' || _aorUpper === 'CANCEL_ORDER'
      || _aorUpper === 'SUPPORT' || _aorSupportRe.test(messageText.trim())
      || _aorUpper === 'SHOW_MENU' || _aorUpper === 'MENU'
      || _aorUpper === 'HOME' || _aorUpper === '0'
      || _aorUpper === 'CANCEL_ALL' || _cancelAllPattern.test(messageText.trim())
      || _aorUpper === 'CANCEL_BOOKING'
      // Navigation intents — customer is deliberately starting a new flow
      || _aorUpper === 'ORDER' || _aorUpper === 'START_ORDER'
      || _aorUpper === 'BOOK' || _aorUpper === 'START_BOOKING'
      || _aorUpper === 'QUESTION' || _aorUpper === 'ASK_A_QUESTION'
      || _aorUpper === 'ENQUIRY';
    if (!_aorIsEscape) {
      try {
        // [FIX-AOR-5] Throttle: only intercept once per 5-minute window per customer.
        // Without this, every filler message ("Ahh", "ok", "hmm") triggered a fresh
        // preparing-card dispatch — resulting in 2-3 identical messages before loop
        // detection fired. The throttle key `lastAorInterceptAt` is stored on the session.
        const AOR_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes
        const lastAorAt = session.lastAorInterceptAt ? new Date(session.lastAorInterceptAt) : null;
        const aorThrottled = lastAorAt && (Date.now() - lastAorAt.getTime()) < AOR_THROTTLE_MS;

        if (!aorThrottled) {
          const { shouldIntercept, uiResponse } = await resolveActiveOrder(
            from, tenantId, business, session,
          );
          if (shouldIntercept && uiResponse) {
            // Record the timestamp so the next message within 5 min is not intercepted again
            await updateSession(from, tenantId, { lastAorInterceptAt: new Date().toISOString() }).catch(() => {});
            await dispatchMessage(from, uiResponse, tenantDoc);
            return;
          }
        }
        // aorThrottled or no intercept needed — fall through to normal routing
      } catch (_aorErr) {
        logger.debug('[Webhook] resolveActiveOrder failed (non-fatal) — falling through', {
          err: _aorErr.message, from,
        });
      }
    }
  }

  // ── 14.41. RESEND_PROOF button tap — customer wants to retry a rejected payment ─
  // [FIX-AOR-3] Shown by activeOrderResolver when paymentStatus='rejected'.
  // Tapping it should restore the session to ORDER / PAYMENT_PROOF so the customer
  // can upload a new screenshot. Without this handler the button tap falls through
  // to intent detection → FALLBACK, leaving the customer stuck.
  if (isInteractive && messageText.trim().toUpperCase() === 'RESEND_PROOF') {
    const rejectedOrder = await Order.findOne({
      customerPhone: from, tenantId,
      paymentStatus: 'rejected',
      status: { $nin: ['cancelled', 'completed'] },
    }).select('_id item quantity totalPrice shortId paymentReference').sort({ createdAt: -1 }).lean().catch(() => null);

    if (rejectedOrder) {
      await Order.findOneAndUpdate(
        { _id: rejectedOrder._id },
        { $set: { paymentStatus: 'unpaid', proofReceivedAt: null, paymentProof: null } }
      ).catch(() => {});
      await updateSession(from, tenantId, { currentFlow: 'ORDER', step: 'PAYMENT_PROOF' });
      const currency = business?.payment?.currency || 'D';
      await dispatchMessage(from, {
        type:    'buttons',
        body:
          `📸 *Please send a new payment screenshot*

` +
          `Order *#${rejectedOrder.shortId}* — *${rejectedOrder.item}* × ${rejectedOrder.quantity}
` +
          `💰 Amount: *${currency}${rejectedOrder.totalPrice || '—'}*

` +
          `Send a clear screenshot of your successful payment transfer in this chat.`,
        buttons: [
          { id: 'SUPPORT', title: '❓ Need Help'    },
          { id: 'CANCEL',  title: '❌ Cancel Order' },
        ],
      }, tenantDoc);
      return;
    }
  }

  // ── 14.42. ORDER_STATUS_* button tap — customer picking from multiple-order list ─
  // [FIX-AOR-2] Generated by activeOrderResolver._multipleOrders(). Without this
  // intercept the tap falls through to intent detection → FALLBACK.
  if (isInteractive && messageText && /^ORDER_STATUS_[A-Z0-9]+$/i.test(messageText.trim().toUpperCase())) {
    const pickedShortId = messageText.trim().toUpperCase().replace('ORDER_STATUS_', '');
    if (pickedShortId) {
      const pickedOrder = await Order.findOne({
        shortId: pickedShortId, tenantId,
        status: { $nin: ['cancelled', 'completed'] },
      }).select('item quantity shortId status paymentStatus totalPrice').lean().catch(() => null);

      if (pickedOrder) {
        const currency = business?.payment?.currency || 'D';
        const statusMap = {
          pending: '⏳ Waiting for confirmation', confirmed: '🍳 Being prepared',
          preparing: '🍳 Being prepared', ready: '✅ Ready for collection!',
        };
        const payMap = {
          unpaid: '💳 Awaiting payment screenshot', proof_received: '📸 Screenshot received — verifying',
          confirmed: '✅ Payment verified', rejected: '❌ Payment rejected — tap to retry',
        };
        await dispatchMessage(from, {
          type: 'buttons',
          body:
            `📦 *Order #${pickedOrder.shortId}*

` +
            `🛒 *${pickedOrder.item}* × ${pickedOrder.quantity}
` +
            (pickedOrder.totalPrice ? `💰 Total: *${currency}${pickedOrder.totalPrice}*
` : '') +
            `📊 Status: ${statusMap[pickedOrder.status] || pickedOrder.status}
` +
            `💳 Payment: ${payMap[pickedOrder.paymentStatus] || pickedOrder.paymentStatus}`,
          buttons: [
            { id: 'SUPPORT',   title: '💬 Contact Support' },
            { id: 'SHOW_MENU', title: '🔄 Main Menu'       },
          ],
        }, tenantDoc);
        return;
      }
    }
  }

  // ── 14.5. COLLECTED_* button tap — customer confirms order pickup ──────────
  // [SPEC-5B] The "✅ Collected — Thanks!" button sends COLLECTED_<shortId> which
  // isFlowPassthroughId() passes through (bypasses intent detection). Since there is
  // no active flow at this point, intercept it here before step 15 tries advance().
  if (isInteractive && messageText && /^COLLECTED_[A-Z0-9]+$/i.test(messageText.trim().toUpperCase())) {
    const shortIdCollect = messageText.trim().toUpperCase().replace('COLLECTED_', '');
    if (shortIdCollect) {
      // [FIX-IMPORT-2] Order now a top-level import — removed redundant dynamic import
      await Order.findOneAndUpdate(
        { shortId: shortIdCollect, tenantId, status: { $in: ['ready', 'confirmed'] } },
        { $set: { status: 'completed', completedAt: new Date() } }
      ).catch(() => {});
    }
    const bizName = business?.name || 'us';
    await dispatchMessage(from, {
      type: 'text',
      body: `🎉 Enjoy your meal! 😊\n\nHope to see you again soon.\n— *${bizName}*`,
    }, tenantDoc);
    // [FIX-ACK-COLLECT] Set postFlowAck so immediate follow-ups ("thank you", "was great")
    // are handled warmly instead of going to AI → SUPPORT escalation.
    await updateSession(from, tenantId, {
      postFlowAck:  'ORDER_COLLECTED',
      postFlowData: { shortId: shortIdCollect },
    }).catch(() => {});
    return;
  }

  // ── 14.6. Quick STATUS command — works from any state, no flow required ─────
  // [QSC-1] Customers in The Gambia often message simple words like "status", "update",
  // "my order" at any point in a conversation. This intercept handles those before
  // intent detection so they always get an instant, accurate order summary regardless
  // of session state — no button navigation required.
  const STATUS_CMD_RE = /^(status|order status|my order|where is my order|check order|track my order|track|check my order)$/i;
  if (messageText && STATUS_CMD_RE.test(messageText.trim()) && !session.currentFlow) {
    try {
      const recentOrder = await Order.findOne({
        customerPhone: from,
        tenantId,
        status: { $nin: ['cancelled'] },
      }).select('item quantity shortId status paymentStatus createdAt').sort({ createdAt: -1 }).lean();

      if (recentOrder) {
        const statusMap = {
          pending:   '⏳ Waiting for our team to confirm',
          confirmed: '🍳 Being prepared',
          ready:     '✅ Ready for collection!',
          completed: '✅ Completed — thank you!',
        };
        const payMap = {
          unpaid:         '💳 Awaiting payment',
          proof_received: '📸 Payment screenshot received — verifying',
          verified:       '✅ Payment verified',
          paid:           '✅ Paid',
          confirmed:      '✅ Payment confirmed',
          rejected:       '❌ Payment rejected — please resubmit',
        };
        await dispatchMessage(from, {
          type: 'text',
          body:
            `📦 *Order Update*\n\n` +
            `• Item: *${recentOrder.item}* × ${recentOrder.quantity}\n` +
            `• Ref: *#${recentOrder.shortId}*\n` +
            `• Status: ${statusMap[recentOrder.status] || recentOrder.status}\n` +
            `• Payment: ${payMap[recentOrder.paymentStatus] || recentOrder.paymentStatus}`,
        }, tenantDoc);
        return;
      }
      // No recent order — fall through to intent detection
    } catch (err) {
      logger.debug('[Webhook] STATUS command lookup failed (non-fatal)', { err: err.message });
      // Non-fatal — fall through to intent detection
    }
  }

  // ── 15. Active flow ───────────────────────────────────────────────────────
  if (session.currentFlow) {
    if (isListReply && session.currentFlow === 'ORDER' && !session.menuViewed) {
      await updateSession(from, tenantId, { menuViewed: true });
      session = { ...session, menuViewed: true };
    }

    // [FIX-REPEAT-v2] In-flow repeated message handling — context-aware.
    // Only fires when the EXACT same text is sent 3 times in a row at the SAME step.
    // First two occurrences fall through silently to the flow handler (which has its
    // own gibberish/casual detection). Third occurrence shows a step-aware helpful hint.
    // Different messages always pass through — this is NOT a general gibberish filter.
    if (messageText && !isInteractive) {
      const last      = session.lastLoopMessage;
      const loopCount = session.loopCount || 0;
      const sameMsg   = last === messageText && session.lastLoopStep === session.step;

      if (sameMsg) {
        const newCount = loopCount + 1;

        if (newCount >= 2) {
          // Third identical send — reset and show context-aware help
          await updateSession(from, tenantId, { loopCount: 0, lastLoopMessage: null, lastLoopStep: null });

          const flowStep  = session.step || 'SELECT_ITEM';
          const itemName  = session.data?.item?.name;
          const bizName   = business?.name || 'us';
          const bizMode   = (business?.businessMode || 'RESTAURANT').toUpperCase();
          const isElec    = bizMode === 'ELECTRONICS';

          // Mode-aware hint copy — electronics gets product-centric language
          const STEP_HINTS = {
            // ── Shared steps ─────────────────────────────────────────────────
            SELECT_ITEM: isElec
              ? {
                  body:    `To shop at *${bizName}*, type a *product name* or tap below to browse by category:`,
                  buttons: [{ id: 'ORDER', title: '🛒 Browse Products' }, { id: 'CANCEL', title: '❌ Cancel' }],
                }
              : {
                  body:    `To order from *${bizName}*, just type the *name of an item*.\n\nOr tap below to browse:`,
                  buttons: [{ id: 'SHOW_MENU', title: '📋 View Full Menu' }, { id: 'CANCEL', title: '❌ Cancel' }],
                },
            QUANTITY: {
              body:    `How many *${itemName || 'units'}* would you like?\n\nJust type a number — for example: *1*, *2*, *three*.`,
              buttons: [{ id: 'CANCEL', title: '❌ Cancel Order' }],
            },
            CONFIRM: {
              body:    `Please tap a button to confirm or cancel your order:`,
              buttons: [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
            },
            AWAIT_ADMIN_CONFIRM: {
              body:    `Your order is with our team — we'll confirm it shortly. 🙏\n\nTo cancel, tap below:`,
              buttons: [{ id: 'CANCEL', title: '❌ Cancel Order' }],
            },
            // ── Electronics-only steps ────────────────────────────────────────
            BROWSE_CATEGORY: {
              body:    `Browse *${bizName}* products by category, or type a product name:`,
              buttons: [{ id: 'ORDER', title: '🛒 Browse Products' }, { id: 'CANCEL', title: '❌ Cancel' }],
            },
            ITEM_DETAIL: {
              body:    itemName
                ? `You're viewing *${itemName}*. Tap to order or ask a question:`
                : `Tap to order the product or ask a tech question:`,
              buttons: [
                { id: 'CONFIRM_ITEM',  title: '🛒 Order This'     },
                { id: 'SPEC_REQUEST',  title: '❓ Ask a Question'  },
                { id: 'SHOW_MENU',     title: '🔄 Browse More'     },
              ],
            },
            FULFILMENT: {
              body:    `Please choose how you'd like to receive your order:`,
              buttons: [{ id: 'PICKUP', title: '🏪 Pick Up In-Store' }, { id: 'DELIVERY', title: '🚚 Delivery' }],
            },
          };

          const hint = STEP_HINTS[flowStep] || {
            body:    `Not sure what to do? Browse the menu or cancel your current order:`,
            buttons: [{ id: 'SHOW_MENU', title: '🔄 Main Menu' }, { id: 'CANCEL', title: '❌ Cancel' }],
          };

          await dispatchMessage(from, { type: 'buttons', ...hint }, tenantDoc);
          return;
        }

        // First or second repeat — just track, let the flow handler respond naturally
        await updateSession(from, tenantId, { loopCount: newCount });
      } else {
        // Different message — reset counter and let flow handle it normally
        await updateSession(from, tenantId, {
          loopCount: 0, lastLoopMessage: messageText, lastLoopStep: session.step,
        });
      }
    }

    // [FIX-STALE-BTN] Reject button taps that belong to a previous step.
    // WhatsApp never disables old buttons, so a customer can tap "✅ Confirm Order"
    // from a step-3 message while the session is already at step AWAIT_ADMIN_CONFIRM,
    // or tap "QTY_1" while at the CONFIRM step. Map each step to its valid button IDs;
    // anything outside that set gets a "that option has passed" reply.
    const STEP_VALID_BUTTONS = {
      // ── Generic steps (used by restaurant / bakery / retail etc.) ──────────
      SELECT_ITEM:          new Set(['SHOW_MENU', 'CANCEL', 'CONFIRM']),
      SUGGESTION_CONFIRM:   new Set(['CONFIRM', 'SHOW_MENU', 'CANCEL']),
      QUANTITY:             new Set([]), // expects free text — no valid buttons
      UPSELL:               new Set(['UPSELL_YES', 'UPSELL_NO']),
      CONFIRM:              new Set(['CONFIRM', 'CANCEL']),
      PAYMENT_PROOF:        new Set(['DONE', 'SUPPORT', 'CANCEL', 'CANCEL_ORDER']),
      AWAIT_ADMIN_CONFIRM:  new Set(['CANCEL', 'CANCEL_ORDER']),
      // ── Electronics-specific steps ─────────────────────────────────────────
      // Steps with no entry are NOT validated — any button passes through to the
      // flow handler. This is intentional for steps that accept dynamic button IDs
      // (CAT_*, list-reply row IDs) which cannot be enumerated statically.
      // BROWSE_CATEGORY: not validated — accepts CAT_* which are dynamic
      // SELECT_ITEM: not validated — accepts numeric list-reply row IDs
      SUGGEST_CONFIRM:     new Set(['CONFIRM_SUGGESTION', 'SHOW_MENU', 'CANCEL']),
      ITEM_DETAIL:         new Set(['CONFIRM_ITEM', 'SPEC_REQUEST', 'SHOW_MENU', 'CANCEL']),
      FULFILMENT:          new Set(['PICKUP', 'DELIVERY', 'CANCEL']),
      // SHOW_COMPARISON: not validated — PICK_A_* / PICK_B_* are dynamic
      // ── [FIX-P1] Module-specific steps missing from validation map ──────────
      // Without these entries, a stale-button tap at these steps silently passed
      // through to the flow handler with no validation. Adding them gives customers
      // the clear "option no longer available" reply for out-of-step taps.
      BAKERY_FULFILMENT:   new Set(['COLLECT', 'DELIVERY', 'CANCEL']),
      PICKUP_TIME:         new Set(['SLOT_MORNING', 'SLOT_AFTERNOON', 'SLOT_EVENING', 'SLOT_TOMORROW', 'CANCEL']),
      NOTES:               new Set([]), // free-text OR NOTES_NONE — passthrough handles button
      SELECT_SKIN:         new Set(['SKIN_DRY', 'SKIN_OILY', 'SKIN_COMBO', 'SKIN_NORMAL', 'SKIN_CUSTOM', 'SKIP_SKIN', 'CANCEL']),
      GIFT_NOTE:           new Set([]), // free-text OR GIFT_NONE — passthrough handles button
      RETAIL_FULFILMENT:   new Set(['PICKUP', 'DELIVERY', 'CANCEL']),
    };
    const upperMsg = messageText.trim().toUpperCase();
    const currentStep = session.step;
    if (isInteractive && currentStep && STEP_VALID_BUTTONS[currentStep] !== undefined) {
      const validSet = STEP_VALID_BUTTONS[currentStep];
      // Only enforce when the set is non-empty (empty means free-text step, no valid buttons)
      if (validSet.size > 0 && !validSet.has(upperMsg) && !isFlowPassthroughId(upperMsg)) {
        await dispatchMessage(from, {
          type: 'text',
          body: "⚠️ That option is no longer available at this stage of your order.\n\nPlease follow the current prompt, or type *CANCEL* if you'd like to start over.",
        }, tenantDoc);
        return;
      }
    }

    // [FIX-BUG9] Flow-internal button IDs — bypass intent detection entirely
    if (isInteractive && isFlowPassthroughId(upperMsg)) {
      const freshSession = await getSession(from, tenantId) || session;
      const reply = await advance({ session: freshSession, message: messageText, business, tenant: tenantDoc, isInteractive });
      if (reply) {
        // reply can be an array (e.g. [image, buttons]) — dispatch each in order
        const payloads = Array.isArray(reply) ? reply : [reply];
        for (const payload of payloads) {
          await dispatchMessage(from, payload, tenantDoc);
        }
        const lastPayload = payloads[payloads.length - 1];
        const body = typeof lastPayload === 'string' ? lastPayload : lastPayload?.body;
        if (body) updateSession(from, tenantId, { lastBotMessage: body }).catch(() => {});
      }
      return;
    }

    // Global escape intents
    // [FIX-2] CANCEL_ORDER was absent here. Without it, a CANCEL_ORDER button tap
    // inside an active flow fell through to advance(), which passes the raw button ID
    // string as messageText — flow handlers don't recognise it and the customer gets
    // stuck. Now matches the same cancelFlow path as CANCEL and CANCEL_BOOKING.
    if (upperMsg === 'CANCEL' || upperMsg === 'CANCEL_BOOKING' || upperMsg === 'CANCEL_ORDER') {
      const { cancelFlow } = await import('../core/conversations/flowEngine.js');
      const reply = await cancelFlow(session, business);
      await dispatchMessage(from, reply, tenantDoc);
      return;
    }
    if (upperMsg === '0' || upperMsg === 'SHOW_MENU' || upperMsg === 'MENU' || upperMsg === 'HOME') {
      await updateSession(from, tenantId, { currentFlow: null, step: null, postFlowAck: null });
      const cfg = getModeConfig(business);
      // [FIX] Mid-session "Start Over" tap → short prompt, NOT full welcome greeting
      await dispatchMessage(from, {
        type:    'buttons',
        body:    '👇 What would you like to do?',
        buttons: cfg.ui?.welcomeButtons || [],
      }, tenantDoc);
      return;
    }

    const freshSession = await getSession(from, tenantId) || session;
    // [FIX-2.1] Pass only messageText to advance(). Both image guards at steps 8.5 and 9
    // ensure imageUrl cannot be truthy here with messageText empty — but including it as
    // a fallback is a silent footgun: if either guard is ever relaxed or a new message
    // type is added, advance() would receive a WhatsApp media ID as customer text,
    // producing nonsense flow transitions with no error. Remove the dead fallback entirely.
    const reply = await advance({
      session: freshSession,
      message: messageText,
      business, tenant: tenantDoc, isInteractive,
    });
    if (reply) {
      // reply can be an array (e.g. [imagePayload, buttonsPayload]) — dispatch each in order
      const payloads = Array.isArray(reply) ? reply : [reply];
      for (const payload of payloads) {
        await dispatchMessage(from, payload, tenantDoc);
      }
      const lastPayload = payloads[payloads.length - 1];
      const body = typeof lastPayload === 'string' ? lastPayload : lastPayload?.body;
      if (body) updateSession(from, tenantId, { lastBotMessage: body }).catch(() => {});
    }
    return;
  }

  // ── 16. Intent → module router ────────────────────────────────────────────
  const extractedName = extractCustomerName(messageText);
  if (extractedName && !session.customerName) {
    // [FIX-NAME-1] Persist the name to BOTH the session (fast path for this conversation)
    // AND UserProfile (permanent memory that survives session TTL expiry).
    // Previously only the session was updated — after the 30-min TTL expired the bot
    // forgot the customer's name entirely, despite the customerMemory module existing
    // specifically to provide this persistence. The comment in customerMemory.js claimed
    // "updateName() called by webhookController" but that call was never actually added.
    updateSession(from, tenantId, { customerName: extractedName }).catch(() => {});
    persistCustomerName(from, tenantId, extractedName).catch(() => {}); // fire-and-forget
    session = { ...session, customerName: extractedName };
  }

  const { action, intent, confidence, suggestion } = await detectIntent({
    message: messageText, isInteractive, session, business,
  });

  logger.info('[Webhook] Intent detected', {
    from,
    tenantId,
    action,
    intent,
    confidence,
    messagePreview: messageText?.slice(0, 60),
  });

  // [FIX-ENQ-ROUTE] The inline ENQUIRY handler previously intercepted action='ENQUIRY'
  // before route() was called, making the SERVICES and GENERAL mode's dedicated ENQUIRY
  // flows (registered in ACTION_REGISTRY via moduleRegistry) completely unreachable from
  // any top-level ENQUIRY button tap or typed trigger. The QUESTION button had the same
  // problem because BUTTON_ID_MAP mapped 'QUESTION' → 'ENQUIRY' (fixed in patterns.js).
  //
  // Fix: delegate ALL actions — including ENQUIRY and QUESTION — to route(), which checks
  // the ACTION_REGISTRY first (where mode-specific handlers are registered) then falls
  // back to the moduleRouter switch cases. moduleRouter now handles ENQUIRY/QUESTION with
  // a generic fallback prompt for modes that have no dedicated flow registered.

  const reply = await route({
    action, intent, session,
    message: messageText, business,
    tenant: tenantDoc, isInteractive, suggestion,
  });

  if (reply) {
    // reply can be an array (e.g. [imagePayload, buttonsPayload]) — dispatch each in order
    const payloads = Array.isArray(reply) ? reply : [reply];
    for (const payload of payloads) {
      await dispatchMessage(from, payload, tenantDoc);
    }
    const lastPayload = payloads[payloads.length - 1];
    const body = typeof lastPayload === 'string' ? lastPayload : lastPayload?.body;
    if (body) updateSession(from, tenantId, { lastBotMessage: body }).catch(() => {});
  }
}

// ── Meta webhook verification ──────────────────────────────────────────────────
// [FIX-WH-VERIFY] Meta sends the verifyToken set in the app's webhook config.
// Previously only the global META_WEBHOOK_VERIFY_TOKEN env var was checked —
// this meant every tenant had to use the same verify token, making per-tenant
// webhook configuration impossible and leaking the fact that all tenants share
// one backend. Fix: check the global token first (backward compat), then fall
// back to checking against any ACTIVE tenant's stored verifyToken so per-tenant
// webhook subscriptions work correctly.
export async function verifyWebhook(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe' || !token) {
    return res.status(403).send('Forbidden');
  }

  // Check global env token first (covers single-tenant / dev setups)
  if (process.env.META_WEBHOOK_VERIFY_TOKEN && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  // Check per-tenant verifyTokens (stored encrypted — decrypt before comparing)
  try {
    const { decryptToken } = await import('./tenantController.js');
    const tenants = await Tenant.find(
      { status: { $in: ['ACTIVE', 'PENDING'] }, 'whatsapp.verifyToken': { $exists: true, $ne: null } },
      { 'whatsapp.verifyToken': 1 }
    ).lean();
    for (const t of tenants) {
      const plain = decryptToken(t.whatsapp?.verifyToken || '');
      if (plain && plain === token) {
        return res.status(200).send(challenge);
      }
    }
  } catch (err) {
    logger.warn('[Webhook] verifyWebhook per-tenant check failed', { err: err.message });
  }

  res.status(403).send('Forbidden');
}

// ── Meta webhook event receiver ────────────────────────────────────────────────
// [META-CREDS] Per-tenant HMAC signature verification added here.
// Verification is done per-entry (after tenant resolution) rather than globally,
// because each tenant may have a different Meta App Secret. The global
// META_APP_SECRET env var is used as a platform fallback for tenants that have
// not yet had meta.appSecret populated — ensuring zero downtime during migration.
//
// [LOG-1] All previously silent drops now emit a logger line so the terminal
// always shows WHY the webhook was ignored rather than appearing dead.
export async function receiveWebhook(req, res) {
  res.sendStatus(200);
  try {
    const body = req.body;

    // [LOG-1a] Non-WhatsApp object — log at debug so polling health-checks don't
    // spam the terminal, but the operator can see it when diagnosing silence.
    if (body.object !== 'whatsapp_business_account') {
      logger.debug('[Webhook] Ignored — object is not whatsapp_business_account', {
        object: body.object ?? '(missing)',
      });
      return;
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        // [LOG-1b] Non-messages field (e.g. account_update, phone_number_update) — debug only
        if (change.field !== 'messages') {
          logger.debug('[Webhook] Skipping non-messages change', { field: change.field });
          continue;
        }
        const value         = change.value;
        const phoneNumberId = value.metadata?.phone_number_id;

        // [LOG-1c] Status updates (delivered/read receipts) — expected and frequent,
        // log at debug so they're visible when tracing but don't clutter info output.
        if (value.statuses?.length && !value.messages?.length) {
          logger.debug('[Webhook] Status update received (no messages)', {
            phoneNumberId,
            statusCount: value.statuses.length,
          });
          continue;
        }

        for (const msg of value.messages || []) {
          try {
            const from   = msg.from;
            const msgType = msg.type || 'unknown';

            logger.info('[Webhook] ► Incoming message', {
              from,
              type: msgType,
              phoneNumberId,
              wamid: msg.id,
            });

            const tenant = await Tenant.findOne({ 'whatsapp.phoneNumberId': phoneNumberId, status: 'ACTIVE' }).lean();

            // [LOG-1d] No ACTIVE tenant for this phoneNumberId — the most common
            // cause of total silence. Warn so the operator knows immediately.
            if (!tenant) {
              logger.warn('[Webhook] ✗ No ACTIVE tenant found for phoneNumberId — message dropped', {
                phoneNumberId,
                from,
                tip: 'Check that the tenant exists, has status=ACTIVE, and whatsapp.phoneNumberId matches',
              });
              continue;
            }

            // [FIX-ECHO] Skip messages where the sender is the bot's own WhatsApp number.
            // Meta sometimes echoes outbound messages back as webhook events (type='message'
            // not 'status'). Processing them would cause the bot to reply to itself, producing
            // duplicate messages and infinite-loop-like behaviour. The bot's phone number is
            // stored on the tenant as whatsapp.phoneNumber (E.164 without '+').
            const botPhone = tenant.whatsapp?.phoneNumber?.replace(/\D/g, '') || null;
            const fromDigits = from?.replace(/\D/g, '') || '';
            if (botPhone && fromDigits && fromDigits.endsWith(botPhone.replace(/^\+/, ''))) {
              logger.debug('[Webhook] Skipping echo — message is from bot own number', { from, botPhone, wamid: msg.id });
              continue;
            }

            // [META-CREDS] Per-tenant webhook HMAC verification.
            // Resolve the app secret: tenant-specific takes priority over global env fallback.
            // This runs after tenant resolution so we know which secret to use.
            if (!_verifyTenantWebhookSignature(req, tenant)) {
              logger.warn('[Webhook] ✗ Signature mismatch for tenant — message dropped', {
                tenantId: String(tenant._id), phoneNumberId, ip: req.ip,
              });
              continue; // Skip this message — possible spoofed request
            }

            await handleIncomingMessage({
              tenantId: String(tenant._id), tenantDoc: tenant,
              from, msgObj: msg, phoneNumberId,
            });
          } catch (err) {
            logger.error('[Webhook] ✗ Message processing threw an error', {
              err: err.message,
              stack: err.stack?.slice(0, 300),
              from: msg?.from,
              phoneNumberId,
            });
          }
        }
      }
    }
  } catch (err) {
    logger.error('[Webhook] receiveWebhook outer error', { err: err.message, stack: err.stack?.slice(0, 300) });
  }
}
