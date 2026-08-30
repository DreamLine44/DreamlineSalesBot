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
import { detectIntent, extractCustomerName, normalise, VIEW_MENU_DIRECT_RE } from '../core/intents/intentEngine.js';
import { INTENT_PATTERNS }                           from '../core/intents/patterns.js';
// [FSI] Direct ORDER/BOOKING phrase regexes — same single source of truth
// intentEngine.js's own pre-flow step 4.5 uses, reused here so the mid-flow
// switch intercept below can never silently drift from the pre-flow behavior.
import { ORDER_DIRECT_RE, BOOKING_DIRECT_RE, DIRECT_INTENT_EXCLUDE_RE, QUESTION_LEADIN_RE } from '../core/intents/intentEngine.js';
import { findBestMatch }                             from '../utils/matchEngine.js';
import { updateName as persistCustomerName }         from '../core/memory/customerMemory.js';
import { advance, startFlow }                        from '../core/conversations/flowEngine.js';
import { route }                                     from '../core/conversations/moduleRouter.js';
import { dispatchMessage }                           from '../core/whatsapp/dispatcher.js';
import { getModeConfig }                             from '../config/modes.js';
import { buildOptionsReply }                         from '../core/shared/uiOptionsHelper.js';
import { parseNaturalOrderMessage }                  from '../core/shared/cartEngine.js';
// [AUDIT-FIX-XZ-REMOVE-2] Static import — used synchronously in the hot-path
// _detectMidFlowQuestion() helper on every typed mid-flow message, so this
// mirrors the dynamic-import usage elsewhere in this file without paying an
// async round trip on that path.
import { isCatalogEnabled }                          from '../modules/catalog/waCatalogConfig.js';
import { decryptToken, fingerprintSecret }           from './tenantController.js';
// [FIX-IMPORT-1] handlePostFlowMessage was called at step 14 but never imported —
// every postFlowAck message fell through to the default-case "unknown ackCtx" path in
// postFlowHandler.js, sending a generic menu instead of the correct contextual reply.
import { handlePostFlowMessage }                     from '../services/shared/sharedFeature.js';
// [FIX-AOR-1] resolveActiveOrder is the single authoritative gate for "customer has an
// active order" context. It was built and documented but never wired into the controller.
// Without this import, every message from a customer with a confirmed/preparing order
// hit intent detection (GREET → welcome screen, ACKNOWLEDGE → micro-reply with no order
// context) instead of the correct context-aware order-state card. This also caused the
// "Ok/Hello after payment confirmation gets no order-aware response" bug seen in production.
import { resolveActiveOrder }                        from '../services/order/activeOrderResolver.js';
import { isStatusCommand }                           from '../services/activity/activityStatusService.js';
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
import { formatMoney }  from '../utils/formatCurrency.js';
import crypto           from 'crypto';

// [DEPLOY-VERIFY] Bumped whenever the signature-verification or catalog-gate logic in
// this file changes. Exposed on GET /health (see app.js) so a deploy can be confirmed
// with one curl instead of inferring it from log field shapes after the fact — the
// last two "is the fix actually live?" questions both had to be answered by diffing
// warn-log attribute names against source, which only works after a mismatch has
// already happened. Bump this string in the same commit as any change to
// _verifyTenantWebhookSignature() or the START_ORDER PATH A/B split below.
export const WEBHOOK_BUILD_MARKER = 'CATALOG-ORDER-WIRE-2026-07-22';

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
// [FIX-SIG-1] Pure HMAC comparison against a single candidate secret.
// Pulled out of _verifyTenantWebhookSignature so the caller can try more than
// one candidate secret without duplicating the digest/compare logic.
function _hmacMatches(rawBody, secret, sigHeader) {
  if (!secret || !sigHeader || !rawBody) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const sigBuf = Buffer.from(sigHeader);
  const expBuf = Buffer.from(expected);
  return sigBuf.length === expBuf.length &&
         crypto.timingSafeEqual(sigBuf, expBuf);
}

// Exported (in addition to being used internally) purely so regression tests can
// exercise it directly against the two-secret-field bug without spinning up a full
// HTTP request/DB stack. Not part of the public webhook route surface.
export function _verifyTenantWebhookSignature(req, tenant, wamid) {
  // [FIX-SIG-1] Resolve BOTH candidate secrets — per-tenant AND the global env
  // fallback — instead of picking exactly one and never trying the other.
  //
  // Previously the tenant secret (when present) won EXCLUSIVELY: if a tenant's
  // meta.appSecret happened to be stale, mistyped, or left over from an app the
  // tenant is no longer subscribed under (while Meta is actually delivering
  // webhooks signed with the platform-wide META_APP_SECRET, or vice versa),
  // every single message for that tenant would be silently dropped with no way
  // to recover short of an admin fixing the DB field — a real message would
  // never get a second chance against the other known-good secret.
  // decryptToken handles the enc: prefix transparently (imported above).
  // [FIX-SIG-2] There are TWO places an operator can legitimately store a
  // per-tenant Meta App Secret: `meta.appSecret` (added by the multi-tenant
  // credential upgrade) and `whatsapp.webhookSecret` (added earlier, by the
  // per-tenant HMAC feature, and still the field name exposed on the
  // tenant-creation/update API's ALLOWED list). Both are encrypted the same
  // way and both are documented as "the" webhook HMAC secret, but this
  // function used to read ONLY `meta.appSecret`. Any tenant onboarded (or
  // updated) via `whatsapp.webhookSecret` — the field createTenant/updateTenant
  // actually accept from the setup form — had a secret sitting in the DB that
  // verification never looked at, so EVERY real webhook delivery for that
  // tenant failed HMAC and was dropped, consistently, for every message from
  // that chat, even though nothing else about the tenant was misconfigured.
  // Resolve all three candidates and accept a match against any of them.
  const encryptedMetaSecret = tenant?.meta?.appSecret ?? null;
  const encryptedWaSecret   = tenant?.whatsapp?.webhookSecret ?? null;
  let metaSecret = encryptedMetaSecret ? decryptToken(encryptedMetaSecret) : null;
  let waSecret   = encryptedWaSecret   ? decryptToken(encryptedWaSecret)   : null;

  // [FIX-SIG-3] decryptToken(), on a decryption failure (e.g. the value was
  // encrypted under a DIFFERENT ENCRYPTION_KEY than the one currently
  // configured — the classic cause being a key rotated/changed on the host
  // after the secret was originally saved), intentionally falls back to
  // returning the *raw stored ciphertext* rather than throwing, so a broken
  // key can never lock an operator out of their own data. But that fallback
  // value still starts with "enc:" — if it flows into the HMAC comparison
  // unchanged, it becomes a "secret" that is guaranteed to never match
  // anything Meta could possibly sign with. The comparison then fails FOREVER
  // on every message, `hadTenantSecret` reads true the whole time (a string
  // is present), and nothing in the mismatch log distinguishes "wrong secret"
  // from "secret we can't even read." Detect that case explicitly, discard
  // the unusable value, and say so plainly — this is a config/ops problem
  // (ENCRYPTION_KEY mismatch), not a signing problem, and needs a different
  // fix (restore the correct ENCRYPTION_KEY, or re-enter the secret).
  let metaDecryptFailed = false;
  let waDecryptFailed   = false;
  if (metaSecret && metaSecret.startsWith('enc:')) { metaDecryptFailed = true; metaSecret = null; }
  if (waSecret   && waSecret.startsWith('enc:'))   { waDecryptFailed   = true; waSecret   = null; }
  if (metaDecryptFailed || waDecryptFailed) {
    logger.error('[Webhook] Stored webhook secret could not be decrypted — treating as absent ' +
      'rather than using it as a doomed HMAC key. This almost always means ENCRYPTION_KEY on ' +
      'this host does not match the key the secret was originally saved under. Re-set ' +
      'ENCRYPTION_KEY to the original value, or re-enter the tenant\'s Meta App Secret to ' +
      're-encrypt it under the current key.', {
      tenantId: String(tenant?._id),
      metaAppSecretDecryptFailed: metaDecryptFailed,
      webhookSecretDecryptFailed: waDecryptFailed,
    });
  }

  // [FIX-SIG-3] Trim whitespace defensively at read time too, not just at
  // write time in encryptToken(). This retroactively self-heals any secret
  // that was saved before that fix with a trailing newline/space baked into
  // the ciphertext (the single most common real-world cause of a webhook
  // secret that looks right but never verifies), with no need to re-enter it.
  if (metaSecret) metaSecret = metaSecret.trim();
  if (waSecret)   waSecret   = waSecret.trim();

  // Keep the old `tenantSecret` name pointing at the meta.appSecret value so the
  // rest of this function (and its comments) still read naturally; waSecret is
  // just another per-tenant candidate tried alongside it.
  const tenantSecret = metaSecret;
  const globalSecret = process.env.META_APP_SECRET || null;

  // No secret anywhere. In dev/test, pass through with a warning so a tenant
  // mid-onboarding (meta.appSecret not yet populated, no global fallback set)
  // isn't blocked — matches DEPLOY.md's zero-downtime-during-migration intent.
  //
  // [SECURITY-FIX-NOSECRET] In production this used to pass through the same
  // way, which meant a missing/unset META_APP_SECRET turned the webhook route
  // into an open, unauthenticated endpoint: anyone who could reach the URL
  // could POST forged "customer messages" (bypassing HMAC entirely) and have
  // them processed as real WhatsApp events — creating orders, hitting admin
  // notification paths, etc. A missing secret in production is an ops/config
  // problem, not a legitimate migration state, so it must now fail closed:
  // reject the request rather than silently accept it unverified.
  if (!tenantSecret && !waSecret && !globalSecret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[Webhook] No app secret configured — rejecting unverified request in production. ' +
        'Set META_APP_SECRET or populate meta.appSecret/whatsapp.webhookSecret on the tenant to enable HMAC verification.', {
        tenantId: String(tenant?._id),
      });
      return false;
    }
    logger.warn('[Webhook] No app secret configured — signature check skipped (non-production only). ' +
      'Set META_APP_SECRET or populate meta.appSecret on the tenant to enable HMAC verification.', {
      tenantId: String(tenant?._id),
      env: process.env.NODE_ENV,
    });
    return true;
  }

  const sigHeader = req.headers['x-hub-signature-256'];
  if (!sigHeader) {
    // Meta always sends this header on real webhook events
    logger.warn('[Webhook] Missing X-Hub-Signature-256 header', { ip: req.ip, tenantId: String(tenant?._id) });
    return false;
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.error('[Webhook] rawBody missing — check app.js raw body parser setup', { tenantId: String(tenant?._id) });
    return false;
  }

  // [FIX-SIG-1][FIX-SIG-2] Try every candidate secret: the tenant's meta.appSecret,
  // the tenant's whatsapp.webhookSecret, then the global env fallback. Any one
  // matching is sufficient — this is what lets a tenant keep working through a
  // secret migration/rotation window (or simply having used either of the two
  // legitimate per-tenant fields) instead of a single wrong/unread value
  // permanently wedging every message for that tenant.
  if (tenantSecret && _hmacMatches(rawBody, tenantSecret, sigHeader)) return true;
  if (waSecret && waSecret !== tenantSecret && _hmacMatches(rawBody, waSecret, sigHeader)) return true;
  if (globalSecret && globalSecret !== tenantSecret && globalSecret !== waSecret && _hmacMatches(rawBody, globalSecret, sigHeader)) return true;

  // Neither candidate matched — log enough detail to actually
  // diagnose this next time instead of a bare "mismatch" line. Never logs the
  // secret values themselves, only which sources were available/tried and
  // basic shape info about the request that can rule things in or out fast
  // (rawBody length vs Content-Length, which secret source(s) existed).
  // [FIX-SIG-FINGERPRINT] Fingerprints (not the secrets themselves) of every
  // candidate that was tried. Compare against the fingerprint logged when the
  // secret was saved (tenantController.js updateTenant) or compute a fresh one
  // via POST /admin/webhook-secret-fingerprint against the value currently
  // shown in the Meta App Dashboard — a mismatch here means the stored value
  // is simply wrong, not that something else is misconfigured.
  logger.warn('[Webhook] ✗ Signature mismatch for tenant — message dropped', {
    tenantId: String(tenant?._id),
    tenantSecretFingerprint: fingerprintSecret(tenantSecret),
    webhookSecretFingerprint: fingerprintSecret(waSecret),
    globalSecretFingerprint: fingerprintSecret(globalSecret),
    wamid: wamid || null,
    hadTenantSecret: !!tenantSecret,
    hadWebhookSecret: !!waSecret,
    hadGlobalSecret: !!globalSecret,
    rawBodyLength: rawBody.length,
    contentLengthHeader: req.headers['content-length'] || null,
    sigHeaderPrefix: sigHeader.slice(0, 12), // "sha256=" + first few hex chars only
  });
  return false;
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
    // [FIX-SHADE] cosmetics/flows/orderFlow.js _buildShadeUI() generates SHADE_<name>
    // button IDs (e.g. SHADE_DEEP_TAN, SHADE_IVORY) for the SELECT_SHADE step — both the
    // ≤3-shade button variant and the >3-shade list variant. This regex was missing even
    // though the analogous SIZE_/COLOR_/VAR_/STYLIST_ patterns were all already covered.
    // Without it, every shade-selection tap fell through to intent detection → FALLBACK,
    // leaving the customer stuck unable to pick a shade for any multi-shade product.
    /^SHADE_[A-Z0-9_]+$/.test(upper) ||  // cosmetics shade selection (SHADE_<name>)
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
    /^BOOKING_STATUS_[A-Z0-9]+$/.test(upper) || // multiple-booking picker (BOOKING_STATUS_<shortId>)
    /^DATE_D_\d{8}$/.test(upper) ||              // booking month/day picker (DATE_D_YYYYMMDD)
    /^DATE_M_\d{6}$/.test(upper) ||              // booking month picker (DATE_M_YYYYMM)
    /^DATE_DAY_MORE_\d{6}_\d+$/.test(upper) ||  // booking day list pagination
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
  'TIME_1PM','TIME_2PM','TIME_3PM','TIME_4PM','TIME_5PM','TIME_6PM','TIME_7PM',
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
  'DATE_HUB_WEEK_0','DATE_HUB_WEEK_1','DATE_HUB_MONTH','DATE_HUB_BACK','DATE_MONTH_BACK',
  ...Array.from({ length: 10 }, (_, i) => `DATE_PICK_${i}`),
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
  // [FIX-BAKERY-COLLECT] 'COLLECT' is bakery's fulfilment button ID (every other
  // module uses 'PICKUP' for the equivalent option). Without it here, tapping
  // "🏪 Collect In-Store" mid-flow failed the stale-button validation below and
  // showed "that option is no longer available" for the exact button just shown.
  'PICKUP','DELIVERY','COLLECT',
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
  // ── [MFQ] Mid-Flow Question intercept response buttons ───────────────────
  // When the customer is inside an active flow and sends a question intent,
  // the bot pauses and presents two options. These button IDs are the customer's
  // response and must reach the MFQ handler (step 15.1) without going through intent
  // detection, which would otherwise misclassify MFQ_SWITCH_YES as FALLBACK.
  'MFQ_SWITCH_YES',
  'MFQ_SWITCH_NO',
  // [MFQ] Resume-flow button shown after Q&A is complete — lets the customer jump
  // back into the paused flow. Must bypass intent detection so it reaches the
  // MFQ_RESUME_FLOW handler at step 15.1b, not GREET or FALLBACK.
  'MFQ_RESUME_FLOW',
  // ── [FSI] Mid-Flow Order/Booking-Switch intercept response buttons ───────
  // Mirrors the MFQ pattern above: when a customer inside an active BOOKING
  // (or ORDER) flow deliberately asks for the OTHER flow, the bot pauses and
  // presents these two options. Must bypass intent detection so they reach
  // the FSI handler block, not GREET or FALLBACK.
  'FSI_SWITCH_YES',
  'FSI_SWITCH_NO',
  // ── [MULTICART-v40] Restaurant cart navigation buttons ─────────────────
  // Must bypass intent detection so mid-flow taps reach orderFlow.js directly.
  // CONFIRM was already registered above; these cover ITEM_ADDED, cart review,
  // and the Edit Order sub-flow.
  'ADD_ANOTHER_ITEM',
  'REVIEW_CART',
  'ADD_MORE_ITEMS',
  'EDIT_CART',
  'EDIT_ADD',
  'EDIT_REMOVE',
  'EDIT_INCREASE',
  'EDIT_DECREASE',
  'EDIT_CLEAR',
  'EDIT_BACK',
]);

// ── [FIX-BUG3] Hours enforcement ─────────────────────────────────────────────
// Exported (additive only — no behavior change) so it can be covered by a
// direct regression test instead of only indirectly through the webhook flow.
export function isWithinBusinessHours(hours) {
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
    // [FIX-TZ-4] Was `now.getDay()`, which reads the *server process's* local
    // timezone, while the open/close hour check below is resolved in the
    // *business's* timezone via Intl.DateTimeFormat. Near midnight, whenever
    // the server's TZ differs from the business's TZ, those two could disagree
    // on what "today" is — e.g. server at Tue 00:30 UTC is still Mon 16:30 in
    // America/Los_Angeles, so a Monday-open business would incorrectly be
    // checked against Tuesday's hours (or vice versa). Resolve the weekday in
    // the business timezone too, so day and hour always agree.
    let dayKey;
    if (tz !== 'UTC') {
      try {
        const weekday = new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'long' }).format(now);
        dayKey = weekday.toLowerCase();
      } catch {
        dayKey = dayNames[now.getUTCDay()];
      }
    } else {
      dayKey = dayNames[now.getUTCDay()];
    }

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
    // [AUDIT-FIX-8] Overnight wraparound — businesses that close after midnight
    // (e.g. open=18, close=2 for an 18:00–02:00 bar/restaurant) were never
    // supported: closeHr < openHr made `currentDecimalHour >= openHr &&
    // currentDecimalHour < closeHr` impossible to satisfy at any hour of the
    // day, so the business appeared permanently closed. hours.open/close are
    // schema-bounded to 0–24 (BusinessConfig), so a closing time past midnight
    // can only be expressed as a smaller number than the opening time — this
    // case must be detected and handled with OR logic instead of AND.
    if (closeHr <= openHr) {
      return currentDecimalHour >= openHr || currentDecimalHour < closeHr;
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
      return buildOptionsReply(cfg, loopMsg);
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
  if (!msgObj) {
    return { text: '', imageUrl: null, isInteractive: false, isListReply: false, isFlowReply: false, flowReply: null };
  }
  const type = msgObj.type;

  if (type === 'text') {
    return { text: (msgObj.text?.body || '').trim(), imageUrl: null, isInteractive: false, isListReply: false, isFlowReply: false, flowReply: null };
  }

  if (type === 'interactive') {
    const nfm = msgObj.interactive?.nfm_reply;
    if (nfm) {
      let flowReply = {};
      try {
        const raw = nfm.response_json;
        flowReply = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      } catch {
        flowReply = {};
      }
      const bookingDate = flowReply.booking_date || flowReply.date || '';
      return {
        text:          String(bookingDate || '').trim(),
        isInteractive: true,
        isListReply:   false,
        isFlowReply:   true,
        flowReply,
        imageUrl:      null,
      };
    }
    const btn  = msgObj.interactive?.button_reply;
    const list = msgObj.interactive?.list_reply;
    if (btn) {
      return { text: (btn.id  || btn.title  || '').trim(), isInteractive: true, isListReply: false, isFlowReply: false, flowReply: null, imageUrl: null };
    }
    if (list) {
      return { text: (list.id || list.title || '').trim(), isInteractive: true, isListReply: true, isFlowReply: false, flowReply: null, imageUrl: null };
    }
    return { text: '', isInteractive: true, isListReply: false, isFlowReply: false, flowReply: null, imageUrl: null };
  }
  if (type === 'image') {
    return { text: '', imageUrl: msgObj.image?.id || null, isInteractive: false, isListReply: false, isFlowReply: false, flowReply: null };
  }
  if (type === 'button') {
    return { text: (msgObj.button?.payload || '').trim(), isInteractive: true, isListReply: false, isFlowReply: false, flowReply: null, imageUrl: null };
  }

  return { text: '', imageUrl: null, isInteractive: false, isListReply: false, isFlowReply: false, flowReply: null };
}

// ── [MFQ] Mid-Flow Question helpers ──────────────────────────────────────────
//
// _detectMidFlowQuestion(text, session)
//   Returns true when a typed message inside an active flow looks like a question
//   or question-intent, NOT a valid answer to the current step.
//
// DETECTION STRATEGY — layered, strict:
//   1. Keyword match: known question-intent phrases (fast, zero AI cost).
//   2. Step-exclusion: if the current step accepts any text as a valid answer
//      (e.g. ADDRESS, NOTES, PHONE) we NEVER intercept — those are free-text steps.
//   3. Pattern match: classic question forms (starts with wh-word, ends with "?").
//   4. Length sanity: < 4 chars or numeric-only → always CONTINUE (qty/date input).
//
// DELIBERATELY STRICT — false negatives (missing a question) are acceptable.
// False positives (blocking a valid flow answer) are NOT acceptable and cause loops.

// Steps that accept order-flow input (qty, item names, cart edits) — must
// NEVER be intercepted by MFQ, which would block valid answers.
const MFQ_ORDER_INPUT_STEPS = new Set([
  'QUANTITY', 'ITEM_ADDED', 'SUGGESTION_CONFIRM', 'UPSELL',
  'EDIT_CART_MENU', 'EDIT_CART_PICK',
]);

// Steps that accept ANY free text as a valid answer — must NEVER be intercepted.
const MFQ_FREE_TEXT_STEPS = new Set([
  'ADDRESS', 'DELIVERY_ADDRESS', 'PHONE', 'CUSTOMER_NAME', 'NOTES',
  'SPECIAL_REQUEST', 'GIFT_NOTE', 'CAKE_MESSAGE', 'CUSTOM_NOTES',
  'ENTER_NAME', 'ENTER_PHONE', 'ENTER_ADDRESS', 'ENTER_EMAIL',
  'AWAITING_QUESTION',  // already in Q&A mode
  'SPEC_ANSWER',        // electronics mid-spec-Q&A (legacy step name)
  'SPEC_QUESTION',      // electronics mid-spec-Q&A — actual step name set by handleSpecRequest;
                         // SPEC_ANSWER above never matched any real session, which meant typed
                         // questions asked while already inside electronics Question Mode were
                         // wrongly treated as a NEW mid-flow question and intercepted with a
                         // "pause and continue?" prompt instead of just being answered.
  'ENQUIRY_DETAILS',    // services enquiry details step
  'QUOTE_DETAILS',
  'PROJECT_DETAILS',
  // [FIX-MFQ-1] Service/stylist selection steps accept typed names —
  // "Hair Colour" or "Maria" look nothing like questions but _detectMidFlowQuestion
  // could match them if they start with "do you have" or similar.
  // Exclude both so the customer can type a name freely without getting intercepted.
  'SELECT_SERVICE',
  'SELECT_STYLIST',
  'SELECT_STAFF',
]);

// Steps that only accept date/time strings — intercept would be annoying
const MFQ_DATE_TIME_STEPS = new Set([
  'SELECT_DATE', 'ENTER_DATE', 'SELECT_TIME', 'ENTER_TIME',
  'BOOKING_DATE', 'BOOKING_TIME', 'PICKUP_TIME', 'CUSTOM_TIME',
  'DATE', 'DATE_MONTH', 'DATE_DAY', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM',
]);

// ── Quick STATUS command — single source of truth ─────────────────────────
// Used both by the no-flow fast path (step 14.6 below) and by the mid-flow
// STATUS escape (_detectMidFlowStatusRequest above). Hoisted to module scope
// so both call sites always agree on exactly which phrases count as a status
// request — see [AUDIT-FIX-TRACE-1] / [AUDIT-FIX-TRACE-6] for the history.
// (isStatusCommand lives in services/activityStatusService.js)

// Explicit question-intent keywords/phrases (lowercase, normalised)
// IMPORTANT: these must be SPECIFIC enough that they never match valid flow answers.
// "how much" is safe — it's a price question, never a valid item name or quantity.
// "what is" is safe — not a food item or booking date.
// Do NOT include single-word entries that could be misread from context.
const MFQ_QUESTION_KEYWORDS = new Set([
  // Explicit question declarations — unambiguous
  'question', 'questions', 'i have a question', 'i want to ask', 'i want to ask a question',
  'can i ask', 'can i ask something', 'let me ask', 'i need to know',
  'i need to ask', 'quick question', 'one question', 'just a question',
  'need some info', 'need information', 'just wondering',
  'before i continue', 'before i book', 'before i order',
  'i want to know', 'want to know',
  // Classic question openers that are NEVER valid flow answers
  'how much', 'how long does', 'how long will', 'how long is',
  'what is your', 'what are your', 'what time do you',
  'do you have', 'do you offer', 'can you tell me',
  'is it possible', 'are you able', 'can you help me',
  'opening hours', 'what time do you open', 'when do you open', 'when do you close',
  'where are you', 'where are you located',
  'do you deliver', 'do you do delivery',
  'how do i pay', 'payment options',
  'tell me more about', 'can you explain',
]);

// Regex for classic question forms: starts with wh-/how/can/is/are/do/does/would/could
const MFQ_QUESTION_RE = /^(wh(at|o|y|en|ere|ich)|how|can|is|are|do|does|would|could|will|shall|may|might)\b/i;

// ── [FIX-SUPPORT-ESCAPE] Mid-Flow Support/Admin Escalation detector ──────────
//
// PROBLEM: a customer mid-flow (e.g. at the BOOKING step "How many guests will
// be dining?") types "want to talk to the admin". This is not question-shaped
// (doesn't start with a wh-word, no "?"), so _detectMidFlowQuestion never fires.
// Only CANCEL/CANCEL_BOOKING/CANCEL_ORDER and SHOW_MENU/0/MENU/HOME were treated
// as "global escape intents" for active flows — every other typed message,
// including an explicit request for a human, fell straight through to advance(),
// which silently re-displayed the current flow prompt in an infinite loop.
//
// FIX: mirror the CANCEL/SHOW_MENU escape check with a SUPPORT escape check, run
// BEFORE the MFQ question intercept so an explicit "talk to admin" always wins.
// Uses the same SUPPORT keyword list as top-level intent detection (single source
// of truth in core/intents/patterns.js) so adding a new admin phrase there also
// fixes mid-flow escalation with no other code change needed.
function _detectMidFlowSupportRequest(text, session) {
  const step  = (session.step || '').toUpperCase();
  const clean = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // Never intercept genuinely free-text fields where a keyword could appear
  // incidentally as part of a real answer (e.g. an address or note).
  if (MFQ_FREE_TEXT_STEPS.has(step) || MFQ_DATE_TIME_STEPS.has(step)) return false;
  if (step === 'PAYMENT_PROOF') return false;
  if (!clean || clean.length < 3) return false;

  const words = clean.split(' ');
  for (const kw of (INTENT_PATTERNS.SUPPORT || [])) {
    if (kw.includes(' ')) {
      if (clean === kw || clean.startsWith(kw + ' ') || clean.includes(' ' + kw)) return true;
    } else if (words.includes(kw)) {
      return true;
    }
  }
  return false;
}

// ── [AUDIT-FIX-TRACE-6] Mid-Flow Order/Booking-Status Escape detector ────────
//
// PROBLEM: the "works from any state" quick STATUS command (step 14.6, see
// STATUS_CMD_RE below) only runs when `!session.currentFlow` — so a customer who
// is mid-flow (e.g. halfway through a NEW booking) and types "my booking" or
// "active orders" to check on something OLDER never reaches it. That message
// falls through to advance(), which silently re-displays the current flow step
// — the exact same infinite-loop shape as the SUPPORT and MFQ-question gaps
// above, just for status questions. This matters most for the "lost my phone /
// chat history" case this feature exists for: that customer has no way to know
// they're mid-flow, so they just type their status question wherever they land.
//
// FIX: same tier as the SUPPORT escape — exact-phrase match only (reusing
// STATUS_CMD_RE, the single source of truth already used by the no-flow fast
// path) so it never hijacks a genuine free-text flow answer.
function _detectMidFlowStatusRequest(text, session) {
  const step = (session.step || '').toUpperCase();
  if (MFQ_FREE_TEXT_STEPS.has(step) || MFQ_DATE_TIME_STEPS.has(step)) return false;
  if (step === 'PAYMENT_PROOF') return false;
  if (!text) return false;
  return isStatusCommand(text);
}

// ── [FIX-STUCK-ORDER-GENERIC] Mid-flow generic re-order request detector ────
//
// PROBLEM: a customer already sitting inside an active ORDER flow (started
// earlier, possibly abandoned/forgotten) who types a *generic* re-order
// phrase with no actual product name — "I want to order food", "I want to
// order", "can I order" — never reaches the [CATALOG-FIRST] generic-browse
// handling in moduleRegistry.js at all, because that code only runs from
// fresh intent detection (step 16 below), which is gated behind
// `!session.currentFlow`. With currentFlow already set to 'ORDER', the
// message goes straight to advance() (step 15), which treats it as a
// free-text answer to whatever step the customer happens to be stuck on —
// e.g. re-prompting for a delivery address, or trying (and failing) to
// match "food" against a specific menu item. The customer sees the exact
// same "couldn't find *food* in our products" or unrelated re-prompt
// regardless of how many times they retype it — a real dead end, distinct
// from (and not covered by) _detectMidFlowSwitchRequest above, which
// deliberately no-ops when the requested flow equals the current flow
// (targetFlow === flow) since it assumes same-flow text is a valid in-flow
// answer.
//
// FIX: mirrors moduleRegistry.js's own FILLER_ONLY_RE / isGenericBrowseIntent
// logic (the exact test already used to decide "this message names no real
// product, it's pure navigational filler") so a phrase this narrow can never
// be a genuine specific-item answer to any real ORDER-flow step. Deliberately
// does NOT fire for a message that names an actual item ("I want to order
// jollof rice") — that must still reach advance() as a normal in-flow
// answer. Reuses the same step exclusions (MFQ_FREE_TEXT_STEPS/
// MFQ_DATE_TIME_STEPS/PAYMENT_PROOF) as every other mid-flow detector in
// this file, for the same reason: those steps expect arbitrary free text
// (an address, a name, a date) that must never be hijacked.
const MID_FLOW_GENERIC_ORDER_STRIP_RE =
  /^(?:hi|hello|hey)[,\s]+/i;
const MID_FLOW_GENERIC_ORDER_LEADIN_RE =
  /^(?:i\s+)?(?:want|need|would\s+like|like\s+to\s+order)\s+(?:to\s+order\s+)?/i;
// [FIX-STUCK-ORDER-GENERIC-VERB] Trailing part must be OPTIONAL — the original
// draft of this regex required something to follow the verb (`\s+` with no
// `?`), so a bare "can I order" (nothing after "order") failed to match at
// all and fell straight through as unrecognized leftover text. Verified by
// isolated testing against a matrix of phrases before this shipped.
const MID_FLOW_GENERIC_ORDER_VERB_RE =
  /^(?:can\s+i\s+)?(?:give|get|have|order|buy|purchase)(?:\s+me)?\s*/i;
const MID_FLOW_GENERIC_ORDER_QTY_RE =
  /^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:plates?\s+of\s+)?/i;
// [FIX-STUCK-ORDER-GENERIC-SOME] "some" added — moduleRegistry.js's original
// FILLER_ONLY_RE (mirrored here) was missing it, so "I want to order some
// food please" left "some food please" as unrecognized leftover even though
// every word in it is filler. Added here only (not touching moduleRegistry.js
// — different file, different verified/tested contract; out of scope to
// change there right now).
const MID_FLOW_GENERIC_ORDER_FILLER_RE =
  /^(?:to|the|your|our|see|view|show|browse|order|get|find|for|a|an|of|me|please|some|food|menu|menus|catalog|catalogue|catalogs|products?|options?|item|items)(?:\s+(?:to|the|your|our|see|view|show|browse|order|get|find|for|a|an|of|me|please|some|food|menu|menus|catalog|catalogue|catalogs|products?|options?|item|items))*$/i;

function _detectMidFlowGenericOrderRequest(text, session) {
  const flow = (session.currentFlow || '').toUpperCase();
  if (flow !== 'ORDER') return false;
  const step = (session.step || '').toUpperCase();
  if (MFQ_FREE_TEXT_STEPS.has(step) || MFQ_DATE_TIME_STEPS.has(step)) return false;
  if (step === 'PAYMENT_PROOF') return false;
  const raw = String(text || '').trim();
  if (!raw) return false;

  // Must actually look like a re-order attempt (contains "order"/"want"/etc.)
  // — bail out fast on anything that isn't even shaped like this, so a plain
  // one-word item answer ("Fries") is never routed through the filler check.
  if (!/\b(order|want|need|buy|purchase)\b/i.test(raw)) return false;

  const leftover = raw
    .replace(MID_FLOW_GENERIC_ORDER_STRIP_RE, '')
    .replace(MID_FLOW_GENERIC_ORDER_LEADIN_RE, '')
    .replace(MID_FLOW_GENERIC_ORDER_VERB_RE, '')
    .replace(MID_FLOW_GENERIC_ORDER_QTY_RE, '')
    .replace(/[?!.]+$/, '')
    .trim();

  return leftover.length === 0 || MID_FLOW_GENERIC_ORDER_FILLER_RE.test(leftover);
}

// ── [FSI] Mid-Flow Order/Booking-Switch intercept detector ───────────────────
//
// PROBLEM: a customer already inside an active BOOKING flow (or ORDER flow) who
// deliberately types a request for the OTHER flow (e.g. "I want to order food"
// while mid-booking) previously had that message silently swallowed by the
// current step's handler, which just re-showed its existing prompt — no
// acknowledgement, no way forward except finding CANCEL on their own.
//
// Mirrors the MFQ question intercept above: reuses ORDER_DIRECT_RE/
// BOOKING_DIRECT_RE/DIRECT_INTENT_EXCLUDE_RE (the same source of truth the
// no-flow direct-intent step in intentEngine.js uses) so a phrase is detected
// identically whether the customer is mid-flow or not.
//
// [FIX-FSI-1] Item-name collision guard: a business can sell a product/service
// literally named something that matches the OTHER flow's vocabulary (e.g. a
// wine called "Reserve Cabernet", a salon treatment called "Coloring Book").
// Only checks the CURRENT flow's own catalog (menuItems for ORDER, services for
// BOOKING) — a coincidental match against the OTHER flow's catalog isn't what
// the customer is currently selecting from and must not suppress a genuine switch.
//
// [FIX-FSI-2] Capability gate: never offers a switch into a flow the business's
// vertical doesn't support (e.g. RETAIL/FASHION/DELIVERY have no BOOKING flow).
const normaliseFsi = normalise;

function _detectMidFlowSwitchRequest(text, session, business, isInteractive = false) {
  const flow = (session.currentFlow || '').toUpperCase();
  // 'SPEC_REQUEST' is electronics' Question Mode currentFlow value (set when a
  // customer enters Q&A via the "Ask a Question" button on an item detail card,
  // as opposed to the top-level QUESTION action which uses currentFlow='QUESTION').
  // Without it here, a switch request typed while in electronics Question Mode via
  // that entry point was silently ignored instead of prompting to switch.
  const questionFlows = new Set(['QUESTION', 'ENQUIRY', 'SPEC_REQUEST']);

  if (isInteractive) {
    const id = String(text || '').trim().toUpperCase();
    if (questionFlows.has(flow)) {
      if (id === 'ORDER') return 'ORDER';
      if (id === 'BOOK' || id === 'BOOK_NOW') return 'BOOKING';
    }
    if ((flow === 'ORDER' || flow === 'BOOKING') && id === 'QUESTION') return 'QUESTION';
    if (flow === 'ORDER' && (id === 'BOOK' || id === 'BOOK_NOW')) return 'BOOKING';
    if (flow === 'BOOKING' && id === 'ORDER') return 'ORDER';
    return null;
  }

  // Only ORDER/BOOKING/QUESTION have a meaningful "other activity" to switch into.
  if (flow !== 'ORDER' && flow !== 'BOOKING' && !questionFlows.has(flow)) return null;

  // [AUDIT-FIX-QMODE-1] AWAITING_QUESTION / SPEC_QUESTION are listed in
  // MFQ_FREE_TEXT_STEPS so the separate MFQ *question* intercept
  // (_detectMidFlowQuestion) doesn't re-fire on someone who is already inside
  // Q&A — see the SPEC_QUESTION comment on that set. But this function is a
  // different detector with the opposite goal: it exists specifically to
  // catch "I want to order food" / "let's book instead" typed WHILE sitting
  // in Question Mode. Applying the same free-text bail-out here silently
  // killed that path for every question after the first one (the first
  // question is asked while currentFlow is still 'ENQUIRY' and briefly
  // matches a different, bespoke switch-check inside webhookController's
  // ENQUIRY branch; every question after that runs with currentFlow flipped
  // to 'QUESTION'/'SPEC_REQUEST' by persistQuestionSession, step stuck on
  // AWAITING_QUESTION/SPEC_QUESTION, and only this function stands between
  // the customer and a switch — so it must not bail out here.
  const step = (session.step || '').toUpperCase();
  if (!questionFlows.has(flow) && (MFQ_FREE_TEXT_STEPS.has(step) || MFQ_DATE_TIME_STEPS.has(step))) return null;

  const raw = String(text || '').trim();
  if (!raw || raw.length < 4 || /^\d+$/.test(raw)) return null;

  const clean = normaliseFsi(raw);
  if (DIRECT_INTENT_EXCLUDE_RE.test(clean)) return null;

  // [FIX-QUESTION-VS-ORDER] Checked BEFORE BOOKING_DIRECT_RE/ORDER_DIRECT_RE:
  // "I want to know the prices of your food items" contains "i want" (an
  // ORDER_DIRECT_RE trigger) but is an information request, not an order.
  // Left unguarded, this function treated it as "customer wants to switch
  // out of Question Mode into ORDER", which handed the raw sentence to the
  // order flow's product-name parser — it obviously matched no menu item,
  // producing a nonsense "I couldn't find ... in our current products"
  // reply for a question the business's own menu data could have answered.
  // QUESTION_LEADIN_RE (shared with intentEngine.js's step 4.5) catches this
  // "asking" framing and routes/keeps the customer in QUESTION instead.
  let targetFlow = null;
  if (QUESTION_LEADIN_RE.test(clean)) targetFlow = 'QUESTION';
  else if (BOOKING_DIRECT_RE.test(clean)) targetFlow = 'BOOKING';
  else if (ORDER_DIRECT_RE.test(clean)) targetFlow = 'ORDER';
  if (!targetFlow || targetFlow === flow) return null;

  // Item-name collision guard — only for ORDER/BOOKING switches.
  if (flow === 'ORDER' || flow === 'BOOKING') {
    const catalog = flow === 'ORDER' ? (business?.menuItems || []) : (business?.services || []);
    if (catalog.length && targetFlow !== 'QUESTION') {
      const match = findBestMatch(catalog, raw);
      if (match?.confidenceLevel === 'HIGH') return null;
    }
  }

  const cfg = getModeConfig(business);
  const supportedFlows = cfg?.flows || [];
  if (targetFlow === 'QUESTION') return 'QUESTION';
  if (!supportedFlows.includes(targetFlow)) return null;

  return targetFlow;
}

function _detectMidFlowQuestion(text, session, business) {
  const step  = (session.step  || '').toUpperCase();
  const flow  = (session.currentFlow || '').toUpperCase();
  const clean = text.toLowerCase().replace(/[^\w\s?]/g, ' ').replace(/\s+/g, ' ').trim();

  // 1. Free-text steps — never intercept (these accept any text as the expected answer)
  if (MFQ_FREE_TEXT_STEPS.has(step)) return false;

  // 2. Date/time steps — never intercept (customer is typing a date/time, not a question)
  if (MFQ_DATE_TIME_STEPS.has(step)) return false;

  // 3. PAYMENT_PROOF step — handled by its own guard; never intercept here
  if (step === 'PAYMENT_PROOF') return false;

  // 3b. Order input steps — qty, item picks, cart edits must reach orderFlow
  if (MFQ_ORDER_INPUT_STEPS.has(step)) return false;

  // 3c. Catalog-sourced ORDER flows — item picks and cart actions must not pause for MFQ
  //
  // [AUDIT-FIX-XZ-REMOVE-2] Previously this trusted ONLY session?.data?.orderViaCatalog,
  // the same session-level flag that orderFlow.js's SELECT_ITEM reset and
  // _browseForMoreItems() used to trust exclusively before the audit fix there. Same
  // root cause, same failure mode: a tenant whose WA Catalog went live after this
  // session started (or any other path that left the flag unset on an otherwise
  // catalog-ready session) would have typed item-picks/cart text wrongly intercepted
  // here as a "question" and yanked into Question Mode — before the request ever
  // reached orderFlow.js, where the earlier fix would otherwise have handled it
  // correctly. isCatalogEnabled(business) is now checked directly alongside the flag,
  // matching the fix already applied in orderFlow.js.
  const catalogReady = isCatalogEnabled(business);
  if (flow === 'ORDER' && (session?.data?.orderViaCatalog || catalogReady) &&
      ['SELECT_ITEM', 'CONFIRM', 'ITEM_ADDED', 'EDIT_CART_MENU', 'EDIT_CART_PICK'].includes(step)) {
    return false;
  }

  // 4. Confirm steps accept "confirm"/"cancel" only — anything else is worth intercepting
  //    BUT very short inputs (1-2 words, < 15 chars) at confirm steps are noise, not questions
  if ((step === 'CONFIRM' || step === 'BOOKING_CONFIRM') && clean.length < 15 && !clean.includes('?')) {
    return false;
  }

  // 5. Explicit keyword match (highest precision, zero cost)
  // Exact match first (e.g. "question" alone)
  if (MFQ_QUESTION_KEYWORDS.has(clean)) return true;
  // Starts-with match only for multi-word keywords (single words already caught above)
  for (const kw of MFQ_QUESTION_KEYWORDS) {
    if (kw.includes(' ') && (clean.startsWith(kw) || clean.includes(' ' + kw))) {
      return true;
    }
  }

  // 6. Ends with "?" — classic question
  if (text.trim().endsWith('?')) return true;

  // 7. Classic question form: starts with wh-/how/can/is/are/do/does...
  //    Only fires for genuinely long messages to avoid false positives.
  //    "which" at SELECT_SERVICE step is a service name start, not a question.
  //    15-char minimum means the message must be a real sentence, not a single word.
  if (MFQ_QUESTION_RE.test(clean) && clean.length >= 15) return true;

  // 8. "before i [verb]" pattern — question as a prerequisite
  if (/\bbefore (i|we)\b/i.test(text)) return true;

  return false;
}

// _mfqStepLabel(flow, step)
//   Returns a human-readable description of the current flow + step.
//   Used in the intercept message: "You're currently [stepLabel]."
function _mfqStepLabel(flow, step) {
  const f = (flow || '').toUpperCase();
  const s = (step || '').toUpperCase();

  const stepMap = {
    // Booking / restaurant table booking
    'BOOKING:SELECT_DATE':      'in the middle of booking — choosing a date',
    'BOOKING:SELECT_TIME':      'in the middle of booking — choosing a time',
    'BOOKING:BOOKING_DATE':     'in the middle of booking — choosing a date',
    'BOOKING:BOOKING_TIME':     'in the middle of booking — choosing a time',
    'BOOKING:PARTY_SIZE':       'in the middle of booking — selecting the number of guests',
    'BOOKING:SELECT_PARTY':     'in the middle of booking — selecting your party size',
    'BOOKING:SELECT_GUESTS':    'in the middle of booking — selecting the number of guests',
    'BOOKING:SELECT_SERVICE':   'in the middle of booking — choosing a service',
    'BOOKING:SELECT_STYLIST':   'in the middle of booking — choosing a stylist',
    'BOOKING:SELECT_STAFF':     'in the middle of booking — choosing a team member',
    'BOOKING:DATE':             'in the middle of booking — choosing a date',
    'BOOKING:DATE_CONFIRM':     'in the middle of booking — confirming your date',
    'BOOKING:TIME':             'in the middle of booking — choosing a time',
    'BOOKING:TIME_CONFIRM':     'in the middle of booking — confirming your time',
    'BOOKING:BOOKING_CONFIRM':  'in the middle of booking — confirming your appointment',
    'BOOKING:CONFIRM':          'in the middle of booking — confirming your appointment',
    // Walk-in queue
    'WALKIN:SELECT_SERVICE':    'joining the walk-in queue — choosing a service',
    'WALKIN:SELECT_STYLIST':    'joining the walk-in queue — choosing a stylist',
    'WALKIN:CONFIRM':           'joining the walk-in queue — confirming your spot',
    // Order flow
    'ORDER:SELECT_ITEM':        'placing an order — choosing an item',
    'ORDER:QUANTITY':           'placing an order — entering a quantity',
    'ORDER:UPSELL':             'placing an order — reviewing extras',
    'ORDER:CONFIRM':            'placing an order — confirming your order',
    'ORDER:FULFILMENT':         'placing an order — choosing delivery or collection',
    'ORDER:SELECT_SKIN':        'placing an order — selecting your skin type',
    'ORDER:BROWSE_CATEGORY':    'browsing products — selecting a category',
    'ORDER:ITEM_DETAIL':        'browsing products — viewing a product',
    'ORDER:SUGGEST_CONFIRM':    'placing an order — reviewing a suggestion',
    'ORDER:PICKUP_TIME':        'placing an order — choosing a pickup time',
    'ORDER:PAYMENT_PROOF':      'finalising payment',  // shouldn't reach MFQ but just in case
    'ORDER:AWAIT_ADMIN_CONFIRM':'waiting for your order to be confirmed',
    // General / enquiry
    'ENQUIRY:AWAITING_QUESTION':'asking a question',
    'LEAD_CAPTURE:ENTER_NAME':  'sharing your details',
    'LEAD_CAPTURE:ENTER_PHONE': 'sharing your contact number',
  };

  const key = `${f}:${s}`;
  if (stepMap[key]) return stepMap[key];

  // Generic fallbacks by flow
  const flowFallbacks = {
    'BOOKING':      'in the middle of booking your appointment',
    'WALKIN':       'in the walk-in queue process',
    'ORDER':        'placing your order',
    'ENQUIRY':      'in the middle of an enquiry',
    'LEAD_CAPTURE': 'sharing your contact information',
  };
  if (flowFallbacks[f]) return flowFallbacks[f];

  return 'in the middle of something';
}

/** Strip leading backslashes and normalize for cancel-intent matching. */
function _normalizeCancelText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/^\\+/, '')
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Typed cancel phrases during an active flow (not just button id CANCEL). */
function _isMidFlowCancelRequest(messageText) {
  const clean = _normalizeCancelText(messageText);
  if (!clean) return false;
  if (['cancel', 'stop', 'quit', 'exit', 'nevermind', 'never mind', 'abort'].includes(clean)) return true;
  if (/^cancel (my )?(booking|order|it|this)( please)?$/.test(clean)) return true;
  if (/^(i want to|please) cancel/.test(clean)) return true;
  return false;
}

// ── Main handler ──────────────────────────────────────────────────────────────
// ── [FIX-RACE-1] Per-customer message serialization ─────────────────────────
// ROOT CAUSE of the "reply gets clobbered / session snaps back to the welcome
// menu" class of bug (production case: customer sends "i want to see your
// menu" 2-3 times while impatient — each hits the WA-Catalog-offer path,
// which does several awaited network calls (sendCatalogMessageWithRetry, up
// to 3 attempts with 500ms/900ms backoff — see waCatalogFlow.js) — then
// sends "hello i want to order four plates of domoda", which resolves FAST
// (no network calls) and correctly writes an ambiguity-resolution session
// state (currentFlow:'ORDER', step:'SELECT_ITEM', data.pendingNaturalQuantity).
// The customer then taps "Domoda (Beef)". Meta delivers every one of these as
// its OWN separate webhook HTTP POST, and receiveWebhook() replies 200 and
// starts processing immediately (fire-and-forget) with NO lock across
// requests — so all of these handleIncomingMessage() calls for the SAME
// customer run fully concurrently. Each one independently reads `session`
// near-simultaneously (step 4 below), does its own async work, and
// independently calls updateSession() from ITS OWN stale snapshot. Whichever
// write finishes LAST wins, regardless of which message arrived last. A slow
// "menu" request finishing after the fast "domoda" ambiguity is exactly what
// overwrites data.pendingNaturalQuantity / currentFlow back to a fresh state
// — which is why the very next message (the button tap) finds no active
// flow, falls through to intent detection, and gets the welcome menu instead
// of the order continuing.
//
// Fix: serialize all processing for a given (tenantId, customerPhone) pair
// through an in-memory promise chain, so messages from the same customer are
// always handled one at a time, strictly in arrival order — the read-modify-
// write session cycle for message N always completes before message N+1
// starts reading. This is transparent to every caller (webhook + simulator)
// since the lock lives inside handleIncomingMessage itself.
//
// [CAVEAT] This lock is per-process (an in-memory Map). It fully protects a
// single Railway instance/process — the common case here — but does NOT
// protect across multiple horizontally-scaled replicas sharing one Mongo
// instance. If WhatSales ever runs >1 replica, this same class of race can
// reappear across processes and would need a distributed lock (e.g. a Mongo
// findOneAndUpdate-based mutex) instead.
const _customerLocks = new Map(); // key `${tenantId}:${from}` → tail Promise of the chain

// [FIX-RACE-2] Bounded queue hold — without this, [FIX-RACE-1]'s strict
// serialization becomes a head-of-line-blocking bug of its own. A single slow
// message can legitimately take a long time to resolve here: WA Catalog's
// sendCatalogMessageWithRetry (waCatalogFlow.js) chains up to 3 attempts, and
// each attempt's dispatchMessage() (dispatcher.js) can itself fall through
// list→buttons→text or catalog_message→text retries — every individual Meta
// Graph API call has its own independent 10s timeout (_postPayloadToMeta).
// Worst case, ONE "i want to see your menu" message — especially while WA
// Catalog is unhealthy for a tenant (see the ongoing catalog-send investigation
// in memory) — can take upwards of a minute to fully settle. Strict
// serialization with no ceiling means every later message from that SAME
// customer, including completely unrelated ones like a plain "hello", queues
// behind it for the full duration — which looks exactly like "half my
// messages are being ignored," when they are actually just stuck waiting.
// Fix: the lock only holds the queue for CUSTOMER_LOCK_MAX_HOLD_MS. After
// that, the NEXT queued message is allowed to start even if the current one
// hasn't finished — the slow task keeps running in the background and still
// dispatches its own reply whenever it completes (nothing is cancelled, JS
// can't abort an in-flight await), it just no longer blocks anyone else.
// This preserves the [FIX-RACE-1] ordering guarantee for the common case
// (fast messages) while capping the worst-case delay for everyone behind a
// slow one.
const CUSTOMER_LOCK_MAX_HOLD_MS = 12000; // 12s — comfortably covers a single
// full dispatchMessage() fallback chain (worst case ~3×10s Meta timeouts is
// still possible for a single attempt, but the common slow case — one Meta
// call succeeding on retry — resolves well within this) without leaving a
// customer's other messages stuck for anywhere near the multi-attempt worst case.

function _runSerialized(key, task) {
  const prior = _customerLocks.get(key) || Promise.resolve();
  const run = prior.then(task, task); // run even if the prior link in the chain rejected

  let releaseTimer;
  const timeoutGate = new Promise(resolve => {
    releaseTimer = setTimeout(() => {
      logger.warn('[Webhook] Customer message lock held past max — releasing queue for next message', { key });
      resolve();
    }, CUSTOMER_LOCK_MAX_HOLD_MS);
  });
  const settled = run.then(() => {}, () => {});
  // Whichever comes first — the task actually finishing, or the hold timeout —
  // unblocks the NEXT queued message. clearTimeout on the fast path avoids
  // leaking timers when messages resolve quickly (the overwhelming majority).
  const gate = Promise.race([settled, timeoutGate]).finally(() => clearTimeout(releaseTimer));

  _customerLocks.set(key, gate);
  gate.finally(() => {
    // Only clean up if nothing newer has chained onto this key since —
    // avoids deleting a newer in-flight lock out from under a later caller.
    if (_customerLocks.get(key) === gate) _customerLocks.delete(key);
  });
  return run;
}

export async function handleIncomingMessage({ tenantId, tenantDoc, from, msgObj, phoneNumberId }) {
  const _lockKey = `${tenantId}:${from}`;
  return _runSerialized(_lockKey, () =>
    _handleIncomingMessageSerialized({ tenantId, tenantDoc, from, msgObj, phoneNumberId }));
}

async function _handleIncomingMessageSerialized({ tenantId, tenantDoc, from, msgObj, phoneNumberId }) {
  const { text: messageText, imageUrl, isInteractive, isListReply, isFlowReply, flowReply } = extractMessage(msgObj);
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
  // [CATALOG-ORDER-WIRE] msg.type === 'order' (a completed WhatsApp Catalog
  // checkout) is not handled by extractMessage() — it falls through to that
  // function's default branch (empty text, no image) and would be dropped
  // right here, silently, before business/session are even loaded. That is
  // exactly what was happening: handleCatalogOrderMessage() (waCatalogFlow.js)
  // was fully built but never wired to anything, so every real catalog
  // checkout vanished with no reply and no Order saved. Exempted here; the
  // actual handoff happens at [CATALOG-ORDER-WIRE] below, once business and
  // session are loaded the normal way.
  if (!messageText && !imageUrl && !isFlowReply && msgObj?.type !== 'order') {
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

  // [AUDIT-FIX-USAGE-WIRE] usageService.incrementTenantUsage() was fully built
  // (Tenant.usage.messagesThisMonth counter + resetDate rollover) but never
  // actually called from anywhere — the schema field was pure dead weight and
  // every tenant's usage stayed at 0 forever, regardless of plan or traffic.
  // Fire-and-forget per the service's own contract: never awaited, errors are
  // swallowed inside the service itself, so a tracking failure can never
  // delay or break the actual customer-facing reply. Placed here — past the
  // dedup and empty-message guards, with a confirmed BusinessConfig — so it
  // only counts genuine inbound customer messages, not retries or no-ops.
  import('../services/shared/usageService.js')
    .then(({ incrementTenantUsage }) => incrementTenantUsage(tenantId))
    .catch(() => {});

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

  // ── 4.6 [CATALOG-ORDER-WIRE] WA Catalog checkout ("order" message) ─────────
  // Meta sends msg.type === 'order' with an `order` payload
  // ({ catalog_id, product_items: [...] }) when a customer completes checkout
  // through the native WhatsApp Catalog UI (Review Order → Send). This is the
  // actual call site handleCatalogOrderMessage()'s own header comment already
  // documented as existing — it didn't. Bypasses business-hours/rapid-dup
  // gates below deliberately: the customer already completed a transaction
  // via Meta's own UI, so the sale must be captured regardless of what gate a
  // normal chat message would hit.
  if (msgObj?.type === 'order' && msgObj.order) {
    try {
      const { handleCatalogOrderMessage, drainCatalogQueue } = await import('../modules/catalog/waCatalogFlow.js');
      const catalogReply = await handleCatalogOrderMessage({
        session, business, tenant: tenantDoc, catalogOrder: msgObj.order,
      });
      if (catalogReply) await dispatchMessage(from, catalogReply, tenantDoc);

      // If this single-item handoff reached ORDER_CONFIRMED with nothing further
      // to ask the customer (no variant/quantity step pending), drain the next
      // queued line from this same WA cart now instead of leaving it stranded.
      const postSession = await getSession(from, tenantId);
      if (postSession?.postFlowAck === 'ORDER_CONFIRMED' && postSession?.pendingCatalogQueue?.length) {
        await drainCatalogQueue({ session: postSession, business, tenant: tenantDoc });
      }
    } catch (err) {
      logger.error('[Webhook] handleCatalogOrderMessage failed', { err: err.message, from, tenantId });
    }
    return;
  }

  // ── 4.5 [FEAT-SPAM-1] Rapid identical-message suppression ──────────────────
  // Spec: "Ignore repeated identical messages (e.g. 'hello' sent 4 times) —
  // respond once." Distinct from the wamid dedup above (network-level duplicate
  // delivery of the SAME event, different customer intent) and from
  // checkAndHandleLoop (many-turn stuck-loop detection across a whole
  // conversation) — this specifically catches the same customer re-sending the
  // exact same text within a few seconds (flaky connection triggering a resend,
  // an impatient double-tap, etc.). Text messages only — interactive taps
  // (buttons/lists) are legitimate to repeat (e.g. tapping "+1" twice in a row)
  // and are deliberately excluded, as are very short/numeric messages (already
  // handled as CONTINUE_FLOW quantity/digit input elsewhere).
  if (!isInteractive && messageText && messageText.trim().length > 1 && !/^\d+$/.test(messageText.trim())) {
    const RAPID_DUPLICATE_WINDOW_MS = 6000; // 6 seconds
    const cleanText   = messageText.trim().toLowerCase();
    const lastText    = (session.lastRapidMessage || '').trim().toLowerCase();
    const lastAt      = session.lastRapidMessageAt ? new Date(session.lastRapidMessageAt) : null;
    const isDuplicate = Boolean(cleanText && lastAt && cleanText === lastText
      && (Date.now() - lastAt.getTime()) < RAPID_DUPLICATE_WINDOW_MS);

    if (isDuplicate) {
      logger.debug('[Webhook] Rapid duplicate text — responding once, skipping repeat reply', {
        from, tenantId, textPreview: messageText.slice(0, 60),
      });
      return;
    }

    updateSession(from, tenantId, {
      lastRapidMessage: messageText.trim(), lastRapidMessageAt: new Date().toISOString(),
    }).catch(() => {});
  }

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
      upper.startsWith('CANCEL ')       ||
      upper.startsWith('CONFIRM BOOK ') ||
      upper.startsWith('DECLINE BOOK ') ||
      upper.startsWith('MARK READY ')   ||
      upper === 'RESUME BOT' || upper.startsWith('RESUME BOT ')
    ) {
      const { handleAdminTextCommand, isAdminPhone } = await import('../services/admin/adminCommandService.js');
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
      const { handleAdminButtonReply, isAdminPhone } = await import('../services/admin/adminCommandService.js');
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
    const { receiveProof } = await import('../services/payment/paymentService.js');
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
    const { handleDonePayment } = await import('../services/payment/paymentService.js');
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
        // [AUDIT-FIX-7] cancelledBy/cancelledAt were missing here — every other
        // customer-initiated cancel path (moduleRouter CANCEL, flowEngine.cancelFlow,
        // postFlowHandler SWITCH_YES) writes these audit fields, but this PAYMENT_PROOF
        // step cancel only set status/paymentStatus, silently losing the who/when trail
        // for cancellations made while awaiting a payment screenshot.
        { $set: { status: 'cancelled', paymentStatus: 'cancelled', cancelledBy: 'customer', cancelledAt: new Date() } },
        { sort: { createdAt: -1 } }
      ).catch(() => {});
      await updateSession(from, tenantId, { currentFlow: null, step: null, data: {} });
      const cfg = getModeConfig(business);
      await dispatchMessage(from, buildOptionsReply(
        cfg,
        '❌ Your order has been cancelled.\n\nWhat would you like to do next?',
        [{ id: 'ORDER', title: '🛒 Place New Order' }]
      ), tenantDoc);
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
      // [FIX-PROOF-ACK] If the customer has a pending ORDER_REJECTED postFlowAck
      // (set by adminCommandService.rejectPayment for the payment retry window), an
      // acknowledgement message like "ok", "thanks" would be caught here and shown
      // "awaiting screenshot" — the ORDER_REJECTED handler at step 14 is unreachable.
      // Allow ack/filler messages through to postFlowAck handling when postFlowAck is set,
      // so the customer gets a warm rejection-context reply instead of screenshot reminder.
      if (session.postFlowAck) {
        // Fall through to step 14 — don't return here
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
      // [FIX-AAC-CANCEL-1] Was only setting status:'cancelled' here, leaving paymentStatus
      // untouched (e.g. still 'unpaid'/'proof_received'). Every other cancel path in this
      // file (PAYMENT_PROOF step 10.5, PENDING ORDER LOCK step 11.7) sets BOTH fields, and
      // the cross-system cancellation audit standardised on paymentStatus:'cancelled' /
      // { $nin: ['cancelled', ...] } filters everywhere (activeOrderResolver, AI context
      // queries, admin views) to keep cancelled orders excluded. Without paymentStatus also
      // set here, a cancelled AWAIT_ADMIN_CONFIRM order could still surface as "pending
      // payment" in those other paymentStatus-based queries.
      await Order.findOneAndUpdate(
        { customerPhone: from, tenantId, status: 'pending' },
        // [AUDIT-FIX-7] Add cancelledBy/cancelledAt — same gap as the PAYMENT_PROOF
        // cancel path above; this cash/delivery AWAIT_ADMIN_CONFIRM cancel was also
        // dropping the audit trail.
        { $set: { status: 'cancelled', paymentStatus: 'cancelled', cancelledBy: 'customer', cancelledAt: new Date() } },
        { sort: { createdAt: -1 } }
      ).catch(() => {});
      await updateSession(from, tenantId, { currentFlow: null, step: null, data: {} });
      const cfg = getModeConfig(business);
      await dispatchMessage(from, buildOptionsReply(
        cfg,
        '❌ Your order has been cancelled.\n\nWhat would you like to do?',
        [{ id: 'ORDER', title: '🛒 Place New Order' }]
      ), tenantDoc);
      return;
    }
    // Everything else — classify ack/filler first, then politely hold the customer
    const AAC_ACK_RE = /^(ok|okay|k|thanks?|thank\s*you|thx|got\s*it|noted|alright|cool|nice|great|sure|👍|🙏|😊|ahhh?|ohh?|hmm+|wow|yay|np)$/i;
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
    // typed as free text.
    const _polCancelAllRe = /^cancel\s+all(\s+of\s+(them|the\s+orders?))?$/i;
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
          // [AUDIT-FIX-7] Add cancelledBy/cancelledAt — same gap as the other inline
          // cancel paths in this file; the PENDING ORDER LOCK cancel escape was also
          // dropping the audit trail.
          { $set: { status: 'cancelled', paymentStatus: 'cancelled', cancelledBy: 'customer', cancelledAt: new Date() } }
        ).catch(() => {});
        await updateSession(from, tenantId, { currentFlow: null, step: null, data: {} });
        const cfgPOL = getModeConfig(business);
        await dispatchMessage(from, buildOptionsReply(
          cfgPOL,
          `❌ Your order *#${pendingOrder.shortId}* has been cancelled.\n\nWhat would you like to do next?`,
          [{ id: 'ORDER', title: '🛒 Place New Order' }]
        ), tenantDoc);
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
        const POL_ACK_RE = /^(ok|okay|k|kk|thanks?|thank\s*you|thank\s*u|thx|ty|tq|great|perfect|got\s*it|noted|alright|cool|nice|sounds\s*good|good|👍|🙏|😊|yep|yh|yah|understood|cheers|appreciate\s*it|brilliant|wonderful|awesome|lovely|received|sure|fine|no\s*problem|np|ahhh?|ohh?|hmm+|wow|oh|yay|phew|aight)$/i;
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
    const { handleLeadCapture } = await import('../services/leads/leadCaptureService.js');
    const reply = await handleLeadCapture(session, messageText, business, tenantDoc);
    if (reply) await dispatchMessage(from, reply, tenantDoc);
    return;
  }

  // ── 13. ENQUIRY active flow (Question Mode) ───────────────────────────────
  if (session.currentFlow === 'ENQUIRY') {
    if (session.step === 'AWAITING_QUESTION') {
      const { processQuestionMessage, persistQuestionSession } = await import('../services/question/questionAnswerService.js');
      const { detectIntent } = await import('../core/intents/intentEngine.js');
      const { buildStatusReply } = await import('../services/activity/activityStatusService.js');

      let statusReply = null;
      let switchIntent = null;
      try {
        const intentResult = await detectIntent({ message: messageText, isInteractive: false, session: { ...session, currentFlow: null }, business });
        if (intentResult.action === 'TRACK_ORDER' && intentResult.confidence === 'HIGH') {
          statusReply = await buildStatusReply({ session, business, message: messageText });
        } else if (
          intentResult.confidence === 'HIGH' &&
          ['START_ORDER', 'START_BOOKING', 'CANCEL', 'CANCEL_ALL'].includes(intentResult.action)
        ) {
          // [ENHANCED-QA-SWITCH] Spec: "should not automatically push the customer
          // into ordering or other workflows unless the customer's intent clearly
          // changes." Only HIGH confidence — same bar the TRACK_ORDER escape above
          // already uses — so a vague message never yanks the customer out of Q&A.
          // Handled locally (route() called directly, same as buildStatusReply
          // above) rather than falling through the rest of the webhook pipeline,
          // so nothing else about message handling (postFlowAck, active-order
          // resolver, etc.) is touched by this change.
          switchIntent = intentResult;
        }
      } catch (_) { /* non-fatal */ }

      if (statusReply) {
        await persistQuestionSession(session, tenantDoc, { lastMessage: messageText, lastTopic: 'ORDER_TRACKING' });
        await dispatchMessage(from, statusReply, tenantDoc);
        return;
      }

      if (switchIntent) {
        await updateSession(from, tenantId, { currentFlow: null, step: null }).catch(() => {});
        const { route } = await import('../core/conversations/moduleRouter.js');
        const switchReply = await route({
          action: switchIntent.action, intent: switchIntent.intent,
          session: { ...session, currentFlow: null, step: null },
          message: messageText, business, tenant: tenantDoc,
          isInteractive: false, suggestion: switchIntent.suggestion, nlu: switchIntent.nlu,
        });
        if (switchReply) {
          const payloads = Array.isArray(switchReply) ? switchReply : [switchReply];
          for (const payload of payloads) await dispatchMessage(from, payload, tenantDoc);
        }
        return;
      }

      // Answer-only: stay in Question Mode and wait — no buttons. Switching to
      // another activity is already detected above (switchIntent) from the
      // customer's own words, not offered as a tap target on every answer.
      const reply = await processQuestionMessage({ session, message: messageText, business, tenant: tenantDoc, intent: 'FAQ' });
      await persistQuestionSession(session, tenantDoc, reply.context || { lastMessage: messageText });
      await dispatchMessage(from, {
        type: reply.type || 'text',
        body: reply.body,
      }, tenantDoc);
      return;
    }
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
  //
  // [FIX-MFQ-DBLTAP] MFQ_RESUME_FLOW / MFQ_SWITCH_YES / MFQ_SWITCH_NO button taps must
  // be exempted here. When postFlowAck === 'MFQ_RESUME', handlePostFlowMessage's
  // MFQ_RESUME case unconditionally re-sends the "Hope that helped! Continue?" prompt —
  // it has no special handling for the MFQ_RESUME_FLOW button id because the actual
  // resume logic lives in step 15.1b further down. Without this guard, the customer's
  // FIRST tap of "↩️ Continue" was swallowed here (re-showing the same prompt and
  // clearing postFlowAck) and only a SECOND tap would actually resume the flow —
  // step 15.1b never saw the first tap at all. Computed inline since upperMsg is not
  // declared until later in this function.
  const _step14UpperMsg = (messageText || '').trim().toUpperCase();
  const _isMfqButtonTap = isInteractive && (
    _step14UpperMsg === 'MFQ_RESUME_FLOW' ||
    _step14UpperMsg === 'MFQ_SWITCH_YES'  ||
    _step14UpperMsg === 'MFQ_SWITCH_NO'
  );
  if (session.postFlowAck && messageText && !_isMfqButtonTap) {
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
    const _cancelAllPattern = /^cancel\s+all(\s+of\s+(them|the\s+orders?))?$/i;
    const _aorIsEscape = _aorUpper === 'CANCEL' || _aorUpper === 'CANCEL_ORDER'
      || _aorUpper === 'SUPPORT' || _aorUpper === 'SHOW_MENU' || _aorUpper === 'MENU'
      || _aorUpper === 'HOME' || _aorUpper === '0'
      || _aorUpper === 'CANCEL_ALL' || _cancelAllPattern.test(messageText.trim())
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
    // [FIX-AOR-REJECT] Was querying paymentStatus:'rejected', a value no code path in
    // this codebase ever writes — adminCommandService.rejectPayment() intentionally
    // writes status:'pending'/paymentStatus:'unpaid' instead (see activeOrderResolver.js
    // for the full explanation). This button is shown by the AOR "Payment Not Approved"
    // card, which now uses the same real-state detection — match it here too, or the
    // button silently does nothing (rejectedOrder always null) when tapped.
    const rejectedOrder = await Order.findOne({
      customerPhone: from, tenantId,
      status: 'pending',
      paymentStatus: 'unpaid',
      paymentReviewedAt: { $ne: null },
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
          `💰 Amount: *${currency}${rejectedOrder.totalPrice ? formatMoney(rejectedOrder.totalPrice) : '—'}*

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
        shortId: pickedShortId, tenantId, customerPhone: from,
        status: { $nin: ['cancelled', 'completed'] },
      }).lean().catch(() => null);

      if (pickedOrder) {
        const { formatOrderStatusCard } = await import('../services/activity/activityStatusService.js');
        await dispatchMessage(from, {
          type: 'buttons',
          body: formatOrderStatusCard(pickedOrder, business),
          buttons: [
            { id: 'SUPPORT',   title: '💬 Contact Support' },
            { id: 'SHOW_MENU', title: '🔄 Main Menu'       },
          ],
        }, tenantDoc);
        return;
      }
    }
  }

  // ── 14.43. BOOKING_STATUS_* — customer picking from multiple-booking list ─
  if (isInteractive && messageText && /^BOOKING_STATUS_[A-Z0-9]+$/i.test(messageText.trim().toUpperCase())) {
    const pickedShortId = messageText.trim().toUpperCase().replace('BOOKING_STATUS_', '');
    if (pickedShortId) {
      const { default: Booking } = await import('../models/Booking.js');
      const { formatBookingStatusCard } = await import('../services/activity/activityStatusService.js');
      const pickedBooking = await Booking.findOne({
        shortId: pickedShortId, tenantId, customerPhone: from,
        status: { $in: ['pending', 'confirmed'] },
      }).lean().catch(() => null);

      if (pickedBooking) {
        await dispatchMessage(from, {
          type: 'buttons',
          body: formatBookingStatusCard(pickedBooking, business),
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
      // [AUDIT-FIX-TRACE-5] Was missing `customerPhone: from` — without it, any customer
      // who learned another customer's order shortId (e.g. by observing a receipt or
      // guessing) could tap/replay a COLLECTED_<shortId> id and mark THAT customer's
      // order as completed, even though it wasn't theirs. Scoped to match the same
      // customerPhone + tenantId pattern used by every other customer-triggered
      // order write in this file.
      await Order.findOneAndUpdate(
        { shortId: shortIdCollect, tenantId, customerPhone: from, status: { $in: ['ready', 'confirmed'] } },
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
  // intent detection so they always get an instant, accurate order/booking summary
  // regardless of session state — no button navigation required. Since the lookup is
  // keyed on customerPhone (not session), it also covers a customer who lost their
  // WhatsApp chat history and is asking cold "what's the status of my stuff?" — the
  // DB, not the chat, is the source of truth here.
  //
  // [AUDIT-FIX-TRACE-1] STATUS_CMD_RE only recognised order-flavoured phrasing
  // ("my order", "track my order", "check order") — a SALON/BARBERSHOP/SERVICES
  // customer typing "my booking", "booking status" or "check my appointment" never
  // matched, so this fast path silently skipped them. Worse: even when it DID match
  // (e.g. bare "status"), the handler only ever queried the Order collection — a
  // customer with an active booking but no order got "No recent order — fall through"
  // instead of their booking info. This is the same "order OR booking" gap already
  // fixed for the TRACK_ORDER action (see AUDIT-FIX-14 in core/shared/moduleRegistry.js)
  // but that fix never touched this separate, earlier-running quick-command path.
  // Fixed by (1) adding booking phrasing to the regex and (2) always checking both
  // Order and Booking, reporting on whichever actually exist.
  // (STATUS_CMD_RE is now declared once at module scope — see above — so this
  // no-flow fast path and the mid-flow STATUS escape share one definition.)
  if (messageText && isStatusCommand(messageText) && !session.currentFlow) {
    try {
      const { buildStatusReply } = await import('../services/activity/activityStatusService.js');
      const statusReply = await buildStatusReply({
        session: { ...session, customerPhone: from },
        business,
        message: messageText,
      });

      await dispatchMessage(from, statusReply, tenantDoc);
      return;
    } catch (err) {
      logger.debug('[Webhook] STATUS command lookup failed (non-fatal)', { err: err.message });
    }
  }

  // ── 15. Active flow ───────────────────────────────────────────────────────
  if (session.currentFlow) {
    // Natural-order ambiguity continuation: the clarification buttons use the
    // live menu item's name as their ID. Consume that selection before any
    // generic intent/flow-switch/stale-button logic can reset the session.
    if (session.currentFlow === 'ORDER' && session.step === 'SELECT_ITEM' &&
        session.data?.pendingNaturalQuantity && messageText) {
      const selectedName = String(messageText).trim().toUpperCase();
      const selectedItem = (business?.menuItems || [])
        .filter(item => item.available !== false)
        .find(item => String(item.name || '').trim().toUpperCase() === selectedName);
      if (selectedItem) {
        const { mergeCartLines } = await import('../core/shared/cartEngine.js');
        const cart = mergeCartLines(
          Array.isArray(session.data.cart) ? session.data.cart : [],
          [{ item: selectedItem, quantity: session.data.pendingNaturalQuantity, variant: null }],
        );
        const data = { ...(session.data || {}), cart, pendingNaturalQuantity: null, _nluPending: null };
        await updateSession(from, tenantId, {
          currentFlow: 'ORDER', step: 'CONFIRM', data, orderChannel: 'menu', menuViewed: true,
        });
        const { advance: advanceSelectedOrder } = await import('../core/conversations/flowEngine.js');
        const reply = await advanceSelectedOrder({
          session: { ...session, currentFlow: 'ORDER', step: 'CONFIRM', data, orderChannel: 'menu' },
          message: null, business, tenant: tenantDoc, isInteractive: false,
        });
        if (reply) {
          const payloads = Array.isArray(reply) ? reply : [reply];
          for (const payload of payloads) await dispatchMessage(from, payload, tenantDoc);
        }
        return;
      }
    }

    // [FIX-LISTNAV-ORDER-COLLISION] buildWelcomeSequence()'s LIST-NAV-1 welcome
    // list uses row id 'ORDER' for "🍔 Order Food" — which is ALSO the literal
    // currentFlow value the ORDER flow sets (flows: ['ORDER','BOOKING']). Before
    // LIST-NAV-1 the welcome screen sent BUTTON replies (isListReply=false), so
    // the very next check below — written for genuine in-flow menu-item taps —
    // could never see a welcome-screen tap. Switching the welcome screen to a
    // LIST message made that collision reachable: a customer who already has
    // currentFlow='ORDER' (they tapped Order Food once already, or have a cash
    // order sitting in AWAIT_ADMIN_CONFIRM awaiting the admin) who then taps the
    // OLD "🍔 Order Food" welcome row again — WhatsApp never disables old
    // interactive messages — sends id='ORDER' as a list_reply. That used to fall
    // straight into the menu-item-selection branch below and get treated as if
    // the customer had ordered a dish literally named "ORDER", which matches
    // nothing — a confusing "couldn't find that" reply instead of the menu they
    // tapped for. BOOK/BROWSE_CATALOG/QUESTION never collide this way (their row
    // ids don't match any currentFlow value, and QUESTION bypasses this whole
    // section via FLOW_PASSTHROUGH_IDS) — which is exactly why only Order Food
    // looked broken while Book a Table and Ask a Question worked fine.
    // Fix: recognise this specific re-tap and treat it as "show me the order
    // flow" (restart via startFlow, same as a fresh tap) instead of feeding the
    // literal string 'ORDER' to the item picker.
    if (isListReply && session.currentFlow === 'ORDER' && messageText.trim().toUpperCase() === 'ORDER') {
      // [AUDIT-FIX-CATALOG-VIEWMENU] Same catalog-first gate as the other two
      // fixes above/below — a stale "🍔 Order Food" re-tap is functionally a
      // fresh "start ordering" request, so it should reach a catalog-ready
      // tenant's real WA Catalog instead of unconditionally re-rendering the
      // internal text/list menu.
      const freshOrderSession = await getSession(from, tenantId) || session;
      const { isCatalogEnabled, hasSellableProducts } = await import('../modules/catalog/waCatalogConfig.js');
      if (isCatalogEnabled(business) && hasSellableProducts(business)) {
        const { browseCatalogExplicit } = await import('../modules/catalog/waCatalogFlow.js');
        const reply = await browseCatalogExplicit({ session: freshOrderSession, business, tenant: tenantDoc });
        if (reply) await dispatchMessage(from, reply, tenantDoc);
        return;
      }
      const { startFlow: _startOrderFlow } = await import('../core/conversations/flowEngine.js');
      const reply = await _startOrderFlow({ flowName: 'ORDER', session: freshOrderSession, business, tenant: tenantDoc });
      if (reply) {
        const payloads = Array.isArray(reply) ? reply : [reply];
        for (const payload of payloads) await dispatchMessage(from, payload, tenantDoc);
      }
      return;
    }

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
                  // [AUDIT-FIX-VIEWMENU] was SHOW_MENU — see SELECT_ITEM case in patterns.js/moduleRouter.js
                  buttons: [{ id: 'VIEW_MENU', title: '📋 View Full Menu' }, { id: 'CANCEL', title: '❌ Cancel' }],
                },
            QUANTITY: {
              body:    `How many *${itemName || 'units'}* would you like?\n\nJust type a number — for example: *1*, *2*, *three*.`,
              buttons: [{ id: 'CANCEL', title: '❌ Cancel Order' }],
            },
            ITEM_ADDED: {
              body:    `Would you like to add another item, or review your cart and checkout?`,
              buttons: [
                { id: 'ADD_ANOTHER_ITEM', title: 'âž• Add Another Item' },
                { id: 'REVIEW_CART',      title: '🧾 Review & Checkout' },
              ],
            },
            EDIT_CART_MENU: {
              body:    `Tap an option to edit your cart, or type *back* to return to the summary.`,
              buttons: [{ id: 'EDIT_BACK', title: '⬅️ Back to Summary' }],
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
      SELECT_ITEM:          new Set(['SHOW_MENU', 'BROWSE_CATALOG', 'CANCEL', 'CONFIRM']),
      SUGGESTION_CONFIRM:   new Set(['CONFIRM', 'SHOW_MENU', 'CANCEL']),
      QUANTITY:             new Set([]), // expects free text — no valid buttons
      UPSELL:               new Set(['UPSELL_YES', 'UPSELL_NO']),
      // [MULTICART-v40-EDIT] ITEM_ADDED — shown after every item added to the
      // cart; EDIT_CART_MENU/EDIT_CART_PICK — the Edit Order sub-flow. CONFIRM
      // now also offers Edit Order (EDIT_CART) alongside Confirm/Cancel.
      ITEM_ADDED:           new Set(['ADD_ANOTHER_ITEM', 'REVIEW_CART']),
      CONFIRM:              new Set(['CONFIRM', 'CANCEL', 'ADD_MORE_ITEMS', 'ADD_ANOTHER_ITEM', 'EDIT_CART']),
      EDIT_CART_MENU:       new Set(['EDIT_ADD', 'EDIT_REMOVE', 'EDIT_INCREASE', 'EDIT_DECREASE', 'EDIT_CLEAR', 'EDIT_BACK']),
      EDIT_CART_PICK:       new Set([]), // expects free text (line number) or "back"
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
      // [FIX-22] Removed BAKERY_FULFILMENT and RETAIL_FULFILMENT — dead code.
      // Both bakery and retail use step='FULFILMENT' internally; the specific-named
      // keys never matched. FULFILMENT entry above covers both correctly.
      PICKUP_TIME:         new Set(['SLOT_MORNING', 'SLOT_AFTERNOON', 'SLOT_EVENING', 'SLOT_TOMORROW', 'CANCEL']),
      NOTES:               new Set([]), // free-text OR NOTES_NONE — passthrough handles button
      SELECT_SKIN:         new Set(['SKIN_DRY', 'SKIN_OILY', 'SKIN_COMBO', 'SKIN_NORMAL', 'SKIN_CUSTOM', 'SKIP_SKIN', 'CANCEL']),
      GIFT_NOTE:           new Set([]), // free-text OR GIFT_NONE — passthrough handles button
      // [FIX-22] RETAIL_FULFILMENT removed — retail uses step='FULFILMENT' internally,
      // not 'RETAIL_FULFILMENT'. The FULFILMENT entry above covers retail correctly.
      // ── Salon / Barbershop specific steps ──────────────────────────────────
      // [v14-BUG-1] BOOKING_CONFIRM was missing — stale button taps (e.g. QTY_1 from
      // a previous order screen) passed through validation unchecked and reached the
      // BOOKING_CONFIRM handler with an unexpected button ID, causing silent mis-routing.
      // CANCEL_BOOKING is also valid here (same semantic as CANCEL for booking screens).
      BOOKING_CONFIRM:     new Set(['CONFIRM', 'CANCEL', 'CANCEL_BOOKING']),
      // SELECT_SERVICE and SELECT_STYLIST use dynamic SVC_* / STYLIST_* IDs covered by
      // isFlowPassthroughId() regex — no static set needed. Omitting them is correct.
    };
    // [AUDIT-FIX-RECOVERY-1] Global escape button IDs — must always be actionable
    // no matter which step's allowed-button set they're validated against. These
    // are exactly the recovery/reset affordances the bot itself hands the customer
    // from system-level fallback messages (flowEngine's "No active session" / "not
    // available right now" replies, loop-guard hints, etc.), so rejecting a tap on
    // one of them as "stale" is always wrong — there is no step at which "start
    // over" or "cancel" should ever be an invalid response.
    //
    // Previously each STEP_VALID_BUTTONS entry had to explicitly list SHOW_MENU/
    // CANCEL for a tap to succeed, and several steps didn't (CONFIRM, ITEM_ADDED,
    // EDIT_CART_MENU, UPSELL, EDIT_CART_PICK's guarded steps, etc.). Concretely: a
    // customer whose session/flow was lost (e.g. TTL expiry) and who tapped the
    // bot's own "🔄 Start Over" button in response got THIS gate's "⚠️ That option
    // is no longer available at this stage of your order" instead of actually
    // starting over — a permanent dead end, since every subsequent tap hit the
    // exact same stale step. Exempting these IDs here closes that loop for good,
    // independent of whether any single step's allow-list happens to include them.
    const GLOBAL_ESCAPE_BUTTON_IDS = new Set(['SHOW_MENU', 'CANCEL', 'CANCEL_ORDER', 'CANCEL_BOOKING', 'SUPPORT']);
    const upperMsg = messageText.trim().toUpperCase();
    const currentStep = session.step;
    const pendingNaturalQuantity = session.data?.pendingNaturalQuantity;
    const pendingNaturalCandidate = currentStep === 'SELECT_ITEM' && pendingNaturalQuantity &&
      parseNaturalOrderMessage(
        (business?.menuItems || []).filter(item => item.available !== false),
        messageText,
      )?.lines?.length > 0;
    // [FIX-21] List-reply taps (isListReply=true) always bypass stale-button validation.
    // WhatsApp list widget row IDs are dynamic numeric strings ('1','2','3') and cannot be
    // enumerated statically in STEP_VALID_BUTTONS. Without this guard, every menu/product
    // list-reply tap at SELECT_ITEM was rejected — breaking restaurant, retail, and electronics.
    if (isInteractive && !isListReply && currentStep && STEP_VALID_BUTTONS[currentStep] !== undefined) {
      const validSet = STEP_VALID_BUTTONS[currentStep];
      // Only enforce when the set is non-empty (empty means free-text step, no valid buttons)
        if (validSet.size > 0 && !validSet.has(upperMsg) && !GLOBAL_ESCAPE_BUTTON_IDS.has(upperMsg)
          && upperMsg !== 'BROWSE_CATALOG'
          && !isFlowPassthroughId(upperMsg) && !pendingNaturalCandidate) {
        await dispatchMessage(from, {
          type: 'text',
          body: "⚠️ That option is no longer available at this stage of your order.\n\nPlease follow the current prompt, or type *CANCEL* if you'd like to start over.",
        }, tenantDoc);
        return;
      }
    }

    // [FIX-FRESH-1] Fetch the latest session once here — used both by the
    // isInteractive passthrough path below AND by the final advance() call at the
    // bottom of the active-flow block. Previously freshSession was declared INSIDE
    // the isInteractive block, so the final advance() call (outside that block)
    // hit a ReferenceError on every non-passthrough, non-escape in-flow tap,
    // causing the bot to go completely silent for typed messages inside active flows.
    const freshSession = await getSession(from, tenantId) || session;

    if (isInteractive && upperMsg === 'BROWSE_CATALOG') {
      const { route } = await import('../core/conversations/moduleRouter.js');
      const catalogReply = await route({
        action: 'BROWSE_CATALOG',
        intent: 'BROWSE_CATALOG',
        session: freshSession,
        message: messageText,
        business,
        tenant: tenantDoc,
        isInteractive: true,
      });
      if (catalogReply) {
        const catalogPayloads = Array.isArray(catalogReply) ? catalogReply : [catalogReply];
        for (const catalogPayload of catalogPayloads) await dispatchMessage(from, catalogPayload, tenantDoc);
      }
      return;
    }

    if (isInteractive && pendingNaturalCandidate) {
      const directReply = await route({
        action: 'START_ORDER',
        intent: 'ORDER',
        session: freshSession,
        message: `${pendingNaturalQuantity} ${messageText}`,
        business,
        tenant: tenantDoc,
        isInteractive: true,
      });
      if (directReply) {
        const directPayloads = Array.isArray(directReply) ? directReply : [directReply];
        for (const directPayload of directPayloads) await dispatchMessage(from, directPayload, tenantDoc);
      }
      return;
    }

    // [FIX-MFQ-BTN] MFQ response buttons (MFQ_SWITCH_YES, MFQ_SWITCH_NO, MFQ_RESUME_FLOW)
    // were listed in FLOW_PASSTHROUGH_IDS which caused them to be routed to advance()
    // BEFORE the MFQ intercept block at 15.1a could handle them. The flow engine
    // (e.g. restaurant SELECT_ITEM) received "MFQ_SWITCH_YES" as a menu item name,
    // producing "I couldn't find MFQ_SWITCH_YES on our menu." Fix: intercept MFQ
    // button responses HERE, before the passthrough block, so they always reach 15.1a.
    // [FSI] FSI_SWITCH_YES/NO must be exempted the same way MFQ_SWITCH_YES/NO
    // are above — otherwise the flow engine (e.g. restaurant SELECT_ITEM) would
    // receive "FSI_SWITCH_YES" as a menu item name instead of reaching the FSI
    // handler block below.
    if (isInteractive && (upperMsg === 'MFQ_SWITCH_YES' || upperMsg === 'MFQ_SWITCH_NO' || upperMsg === 'MFQ_RESUME_FLOW' || upperMsg === 'FSI_SWITCH_YES' || upperMsg === 'FSI_SWITCH_NO')) {
      // Falls through to the 15.1a / 15.1b / FSI handlers below — do NOT call advance()
    } else
    // [FIX-BUG9] Flow-internal button IDs — bypass intent detection entirely
    if (isInteractive && isFlowPassthroughId(upperMsg)) {
      const reply = await advance({ session: freshSession, message: messageText, business, tenant: tenantDoc, isInteractive, flowReply });
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
    //
    // [FIX-CANCEL-4] A previous edit (FIX-CANCEL-2) here got corrupted: the comment
    // line above ended with a literal "\n" (backslash-n text) instead of an actual
    // newline character, which merged the guarding `if (upperMsg === 'CANCEL' || ...) {`
    // into the comment itself. That made the if-guard non-executable, so the block
    // below ran UNCONDITIONALLY for every message reaching this point in an active
    // flow — not just CANCEL taps — silently cancelling the flow and returning early
    // before code further down (MFQ question handling, SHOW_MENU, etc.) ever ran.
    // The leftover unmatched closing brace also shifted bracket nesting for the rest
    // of the function. Restored as a real, properly-closed if-statement below.
    //
    // The Booking-cancel DB write that used to live inline here has been moved into
    // cancelFlow() itself (core/conversations/flowEngine.js) so every caller gets it,
    // not just this one call site — see [FIX-CANCEL-3].
    if (upperMsg === 'CANCEL' || upperMsg === 'CANCEL_BOOKING' || upperMsg === 'CANCEL_ORDER'
        || (!isInteractive && _isMidFlowCancelRequest(messageText))) {
      const { cancelFlow } = await import('../core/conversations/flowEngine.js');
      const reply = await cancelFlow(session, business);
      await dispatchMessage(from, reply, tenantDoc);
      return;
    }
    // [AUDIT-FIX-VIEWMENU] "View Menu" (button id VIEW_MENU, or typed "menu" /
    // "show menu" / "view menu" / "see menu" / "main menu" / "back to menu")
    // used to fall into the SHOW_MENU branch below, which wipes currentFlow/step
    // and dumps the customer on the generic welcome buttons — never showing any
    // menu content, despite the button label promising exactly that. A dead
    // fallback in restaurant/flows/orderFlow.js (SELECT_ITEM step) already tried
    // to handle typed "menu"/"home" by calling buildMenuUI(), but it was
    // unreachable because this check upstream always intercepted first.
    //
    // Fix: while inside an ORDER flow, re-render the real menu via
    // startFlow('ORDER') (reuses each module's own INIT step / buildMenuUI)
    // instead of resetting to the unrelated top-level buttons. Outside an
    // ORDER flow (e.g. mid-booking) there's no menu concept to show, so it
    // falls back to the same safe reset behavior as SHOW_MENU.
    //
    // [AUDIT-FIX-SHOWMENU-PARITY] The button id 'SHOW_MENU' was previously
    // EXCLUDED from this menu-rendering branch and handled only by the plain
    // reset block below — but SHOW_MENU is the exact button id every module
    // OTHER than restaurant/delivery uses for its "view the menu/products"
    // affordance (bakery "📋 Browse All", retail "📋 View All Products",
    // cosmetics "🛍 Browse All", fashion "📋 Browse All", etc — see each
    // module's flows/index.js / orderFlow.js). Because SHOW_MENU skipped this
    // branch, tapping any of those buttons mid-ORDER-flow silently reset the
    // session and dumped the customer on the generic top-level welcome
    // buttons instead of showing the menu the label promised — the exact same
    // bug class already fixed here for VIEW_MENU, just left unfixed for every
    // other vertical's equivalent button. The customer then had to tap
    // "Order Food" a second time just to see products again — a visible
    // delay/dead-end that reads as the button being wired to the wrong
    // (mismatched) action. Adding SHOW_MENU here gives it the exact same
    // "show the real menu when inside an ORDER flow, otherwise fall through
    // to the safe reset" treatment as VIEW_MENU, with zero behavior change
    // outside an active ORDER flow (mid-booking, post-flow, or top-level
    // "Start Over" taps still reset exactly as before via the block below).
    if (upperMsg === 'VIEW_MENU' || upperMsg === 'SHOW_MENU' || upperMsg === 'MENU' || upperMsg === 'SHOW MENU'
        || upperMsg === 'VIEW MENU' || upperMsg === 'SEE MENU' || upperMsg === 'MAIN MENU'
      || upperMsg === 'BACK TO MENU'
      || (!isInteractive && VIEW_MENU_DIRECT_RE.test(normalise(messageText)))
      // [FIX-STUCK-ORDER-GENERIC] A generic re-order phrase with no actual
      // product name ("I want to order food", "I want to order") gets the
      // exact same treatment as an explicit "view menu" request — see
      // _detectMidFlowGenericOrderRequest above for why this must be scoped
      // this narrowly (never fires on a message that names a real item).
      || (!isInteractive && _detectMidFlowGenericOrderRequest(messageText, session))) {
      if ((session.currentFlow || '').toUpperCase() === 'ORDER') {
        // [AUDIT-FIX-CATALOG-VIEWMENU] This branch used to call
        // startFlow('ORDER') unconditionally, which renders the module's own
        // internal text/list menu (buildMenuUI, etc.) even for a tenant whose
        // WA Catalog is enabled and fully synced — the same "View Menu shows
        // the fallback instead of the real catalog" gap fixed in
        // moduleRouter.js's VIEW_MENU case. Mirrored here since mid-flow
        // "menu"/"View Menu" taps are intercepted at this earlier point in
        // route(), before moduleRouter.js's case even runs.
        const { isCatalogEnabled, hasSellableProducts } = await import('../modules/catalog/waCatalogConfig.js');
        if (isCatalogEnabled(business) && hasSellableProducts(business)) {
          const { browseCatalogExplicit } = await import('../modules/catalog/waCatalogFlow.js');
          const reply = await browseCatalogExplicit({ session, business, tenant: tenantDoc });
          if (reply) await dispatchMessage(from, reply, tenantDoc);
          return;
        }
        const { startFlow } = await import('../core/conversations/flowEngine.js');
        const reply = await startFlow({ flowName: 'ORDER', session, business, tenant: tenantDoc });
        if (reply) await dispatchMessage(from, reply, tenantDoc);
        return;
      }
    }

    if (upperMsg === '0' || upperMsg === 'SHOW_MENU' || upperMsg === 'MENU' || upperMsg === 'HOME'
        || upperMsg === 'VIEW_MENU' || upperMsg === 'SHOW MENU' || upperMsg === 'VIEW MENU'
        || upperMsg === 'SEE MENU' || upperMsg === 'MAIN MENU' || upperMsg === 'BACK TO MENU') {
      await updateSession(from, tenantId, { currentFlow: null, step: null, postFlowAck: null });
      const cfg = getModeConfig(business);
      // [FIX] Mid-session "Start Over" tap → short prompt, NOT full welcome greeting
      await dispatchMessage(from, buildOptionsReply(cfg, '👇 What would you like to do?'), tenantDoc);
      return;
    }

    // [FIX-SUPPORT-ESCAPE] SUPPORT is now a global escape intent, same tier as
    // CANCEL/SHOW_MENU above. Covers both a direct button tap (e.g. "Contact
    // Support" shown outside its normally-validated steps) and typed requests
    // for a human/admin — see _detectMidFlowSupportRequest for the matching rules.
    if (
      (isInteractive && upperMsg === 'SUPPORT') ||
      (!isInteractive && _detectMidFlowSupportRequest(messageText, session))
    ) {
      const reply = await route({
        action: 'SUPPORT', intent: 'SUPPORT', session, message: messageText,
        business, tenant: tenantDoc, isInteractive,
      });
      if (reply) await dispatchMessage(from, reply, tenantDoc);
      return;
    }

    // [AUDIT-FIX-TRACE-6] ORDER/BOOKING-STATUS is also a global escape intent —
    // same loop bug as SUPPORT above, applied to "my booking" / "active orders"
    // style status questions typed mid-flow. A customer who lost their chat
    // history and comes back cold has no way to know they're mid-flow — they'll
    // just type their status question wherever they land, so this must work
    // from inside a flow too, not only from the step 14.6 no-flow fast path.
    // Exact-phrase match only (STATUS_CMD_RE), deliberately conservative so a
    // genuine free-text flow answer is never hijacked.
    if (!isInteractive && _detectMidFlowStatusRequest(messageText, session)) {
      const reply = await route({
        action: 'TRACK_ORDER', intent: 'TRACK_ORDER', session, message: messageText,
        business, tenant: tenantDoc, isInteractive,
      });
      if (reply) await dispatchMessage(from, reply, tenantDoc);
      return;
    }

    // ── 15.1. [MFQ] Mid-Flow Question Intercept ───────────────────────────
    // CONTEXT: The customer is inside an active flow (booking, order, etc.) and has
    // sent a free-text message that looks like a question or question intent.
    //
    // PROBLEM (seen in screenshots): typing "question" or "i want to ask a question"
    // while at the BOOKING step "How many guests?" caused the bot to silently pass the
    // text to advance(), which didn't recognise it and re-sent the same step prompt —
    // creating an infinite loop until the customer typed "cancel".
    //
    // FIX: Detect QUESTION/ENQUIRY intent mid-flow. If detected:
    //   1. Identify the current flow+step in plain customer language.
    //   2. Inform the customer what step they are on.
    //   3. Offer two buttons: pause for questions or continue current flow.
    //   4. Store the pending question text + flow context in session so we can
    //      restore the flow after the question is answered.
    //
    // RULE: This ONLY fires for typed (non-interactive) text. Button taps inside a
    // flow are already handled by the passthrough/stale-button logic above and should
    // NEVER reach this block — they go directly to advance(). This keeps button UX crisp.
    //
    // RULE: Short messages (< 4 chars), numeric-only, or pure emojis are NOT treated as
    // question intents here — they're far more likely to be quantity/date inputs.
    //
    // RULE: The intercept checks the AI classifier ONLY when keyword matching is
    // inconclusive — it never fires blindly, so it never breaks legitimate flow inputs.
    //
    // SESSION KEYS USED:
    //   session.data._mfqPendingQuestion  — the raw question text the customer typed
    //   session.data._mfqResumeFlow       — flow name to resume after Q&A (e.g. 'BOOKING')
    //   session.data._mfqResumeStep       — step to resume at (e.g. 'SELECT_TIME')
    //   session.data._mfqResumeData       — full session.data snapshot at intercept time

    // ── 15.1a: Handle MFQ button responses (YES = answer question, NO = continue flow)
    if (isInteractive) {
      if (upperMsg === 'MFQ_SWITCH_YES') {
        // Customer wants to ask their question. Clear the flow, open the AI Q&A channel.
        const pendingQ    = session.data?._mfqPendingQuestion || null;
        const resumeFlow  = session.data?._mfqResumeFlow  || null;
        const resumeStep  = session.data?._mfqResumeStep  || null;
        const resumeData  = session.data?._mfqResumeData  || {};

        // Persist resume context + clear flow so AI Q&A handler gets a clean session
        await updateSession(from, tenantId, {
          currentFlow:  null,
          step:         null,
          // Store resume context so after the question is answered the flow can restart
          // from where it was. postFlowData carries it through to postFlowHandler.
          postFlowAck:  resumeFlow ? 'MFQ_RESUME' : null,
          postFlowData: resumeFlow ? { resumeFlow, resumeStep, resumeData } : null,
          data:         {},
        });

        // If the customer already typed their question (captured in _mfqPendingQuestion),
        // answer it immediately. Otherwise ask them to type it.
        if (pendingQ && pendingQ.length >= 4) {
          // [AUDIT-FIX-12] Previously this ALWAYS answered the pending question with a
          // bare getAIReply() call forced to intent:'QUESTION' — a pure LLM Q&A prompt
          // with no access to the customer's actual order/booking records. That meant a
          // genuinely answerable question like "do I have any active order or booking?"
          // asked mid-flow got the generic groqProvider fallback line ("I'll need to
          // check that — please contact us directly") instead of the real answer, even
          // though the exact same question typed OUTSIDE a flow correctly routes through
          // detectIntent -> TRACK_ORDER and returns live order/booking data.
          //
          // Fix: classify the pending question the same way any top-level message would
          // be (detectIntent), using a flow-less session snapshot so it's judged on its
          // own merits. If it resolves with real confidence to a known DATA-BACKED action
          // (currently just TRACK_ORDER — deliberately a narrow whitelist of read-only,
          // side-effect-free lookups; we do NOT want e.g. ORDER/BOOKING starting flows
          // here), route it through the real handler so the reply reflects live data.
          // The card is sent first, followed by a short separate resume prompt — this
          // avoids fighting over WhatsApp's 3-button-per-message limit with whatever
          // buttons the data handler itself returns (e.g. "New Order"/"Contact Support").
          // Anything else falls back to the general AI Q&A reply, same as before.
          const DATA_BACKED_MFQ_ACTIONS = new Set(['TRACK_ORDER']);
          const flowlessSession = { ...session, currentFlow: null, step: null, data: {} };

          let dataReply = null;
          try {
            const pqResult = await detectIntent({
              message: pendingQ, isInteractive: false, session: flowlessSession, business,
            });
            if (DATA_BACKED_MFQ_ACTIONS.has(pqResult.action) && pqResult.confidence !== 'LOW') {
              dataReply = await route({
                action: pqResult.action, intent: pqResult.intent, session: flowlessSession,
                message: pendingQ, business, tenant: tenantDoc, isInteractive: false,
                suggestion: pqResult.suggestion,
              }).catch(() => null);
            }
          } catch (err) {
            logger.warn('[MFQ] pending-question data routing failed', { err: err.message });
          }

          const resumeButtons = resumeFlow
            ? [
                { id: 'MFQ_RESUME_FLOW', title: '↩️ Continue'        },
                { id: 'QUESTION',        title: '❓ Ask Another'       },
                { id: 'SHOW_MENU',       title: '🔄 Main Menu'         },
              ]
            : [
                { id: 'QUESTION',  title: '❓ Ask Another' },
                { id: 'SHOW_MENU', title: '🔄 Main Menu'   },
              ];

          if (dataReply) {
            const dataPayloads = Array.isArray(dataReply) ? dataReply : [dataReply];
            for (const dp of dataPayloads) await dispatchMessage(from, dp, tenantDoc);
            await dispatchMessage(from, {
              type:    'buttons',
              body:    resumeFlow
                ? `_When you're ready, tap below to continue where you left off._`
                : `👇 Anything else?`,
              buttons: resumeButtons,
            }, tenantDoc);
            return;
          }

          // No data-backed handler matched — fall back to the general AI Q&A reply.
          const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
          const aiText = await getAIReply({ customerMessage: pendingQ, business, session, intent: 'QUESTION' }).catch(() => null);

          const resumeHint = resumeFlow
            ? `\n\n_When you're done, tap below to continue where you left off._`
            : '';

          await dispatchMessage(from, {
            type:    'buttons',
            body:    (aiText || 'Let me check that for you! 😊') + resumeHint,
            buttons: resumeButtons,
          }, tenantDoc);
          return;
        }

        // No pending question captured — ask them to type it
        const resumeHint = resumeFlow
          ? `\n\n_Tap "↩️ Continue" at any time to go back to what you were doing._`
          : '';

        await dispatchMessage(from, {
          type:    'buttons',
          body:    `❓ *Go ahead — what would you like to know?*${resumeHint}\n\nJust type your question below.`,
          buttons: resumeFlow
            ? [
                { id: 'MFQ_RESUME_FLOW', title: '↩️ Continue'  },
                { id: 'SHOW_MENU',       title: '🔄 Main Menu'  },
              ]
            : [{ id: 'SHOW_MENU', title: '🔄 Main Menu' }],
        }, tenantDoc);
        return;
      }

      if (upperMsg === 'MFQ_SWITCH_NO') {
        // Customer wants to continue their flow. Restore session and re-send the current step.
        const resumeFlow  = session.data?._mfqResumeFlow || session.currentFlow;
        const resumeStep  = session.data?._mfqResumeStep || session.step;
        const resumeData  = session.data?._mfqResumeData || {};

        await updateSession(from, tenantId, {
          currentFlow: resumeFlow,
          step:        resumeStep,
          data:        resumeData,
        });

        // Re-run advance() with a null message to re-send the current step prompt
        const freshSess = await getSession(from, tenantId) || session;
        const resumeReply = await advance({
          session:       { ...freshSess, currentFlow: resumeFlow, step: resumeStep, data: resumeData },
          message:       '',   // empty = re-send the step prompt
          business,
          tenant:        tenantDoc,
          isInteractive: false,
        });

        // If advance() returned nothing (some flows don't re-send on empty), show a
        // context hint instead of going silent.
        if (resumeReply) {
          const rPayloads = Array.isArray(resumeReply) ? resumeReply : [resumeReply];
          for (const rp of rPayloads) await dispatchMessage(from, rp, tenantDoc);
        } else {
          const stepLabel = _mfqStepLabel(resumeFlow, resumeStep);
          await dispatchMessage(from, {
            type: 'text',
            body: `👍 No problem! Let's continue — ${stepLabel}`,
          }, tenantDoc);
        }
        return;
      }
    }

    // ── 15.1b: Handle MFQ_RESUME_FLOW button (re-enter the flow after question answered)
    if (isInteractive && upperMsg === 'MFQ_RESUME_FLOW') {
      const resumeFlow = session.postFlowData?.resumeFlow || null;
      const resumeStep = session.postFlowData?.resumeStep || null;
      const resumeData = session.postFlowData?.resumeData || {};

      if (resumeFlow) {
        await updateSession(from, tenantId, {
          currentFlow:  resumeFlow,
          step:         resumeStep,
          data:         resumeData,
          postFlowAck:  null,
          postFlowData: null,
        });
        const freshSess2 = await getSession(from, tenantId) || session;
        const resumeReply2 = await advance({
          session:       { ...freshSess2, currentFlow: resumeFlow, step: resumeStep, data: resumeData },
          message:       '',
          business,
          tenant:        tenantDoc,
          isInteractive: false,
        });
        if (resumeReply2) {
          const rPayloads2 = Array.isArray(resumeReply2) ? resumeReply2 : [resumeReply2];
          for (const rp2 of rPayloads2) await dispatchMessage(from, rp2, tenantDoc);
        } else {
          const cfg = getModeConfig(business);
          await dispatchMessage(from, buildOptionsReply(cfg, '👇 What would you like to do?'), tenantDoc);
        }
        return;
      }
      // No resume context — fall through to main menu
      await updateSession(from, tenantId, { postFlowAck: null, postFlowData: null });
      const cfg = getModeConfig(business);
      await dispatchMessage(from, buildOptionsReply(cfg, '👇 What would you like to do?'), tenantDoc);
      return;
    }

    // [DIRECT-ORDER-SHORTCUT] A resolved natural-language order is a stronger
    // signal than the active flow's current prompt. Reuse START_ORDER so the
    // shared parser, cart merge, pricing, and confirmation summary remain the
    // single implementation for both fresh and mid-flow orders.
    if (!isInteractive && session.currentFlow && messageText.length >= 4) {
      const cleanDirectOrder = normalise(messageText);
      if (!DIRECT_INTENT_EXCLUDE_RE.test(cleanDirectOrder) && !QUESTION_LEADIN_RE.test(cleanDirectOrder) && ORDER_DIRECT_RE.test(cleanDirectOrder)) {
        const { parseMultiItemMessage, parseNaturalOrderMessage } = await import('../core/shared/cartEngine.js');
        const liveMenu = (business?.menuItems || []).filter(item => item.available !== false);
        const parsedDirectOrder = parseMultiItemMessage(liveMenu, messageText)
          || parseNaturalOrderMessage(liveMenu, messageText);
        if (parsedDirectOrder?.lines?.length || parsedDirectOrder?.ambiguous) {
          const directReply = await route({
            action: 'START_ORDER',
            intent: 'ORDER',
            session: freshSession,
            message: messageText,
            business,
            tenant: tenantDoc,
            isInteractive: false,
          });
          if (directReply) {
            const directPayloads = Array.isArray(directReply) ? directReply : [directReply];
            for (const directPayload of directPayloads) await dispatchMessage(from, directPayload, tenantDoc);
          }
          return;
        }
      }
    }

    // ── 15.1c: Detect question intent in typed free-text mid-flow ──────────
    // Only fires for non-interactive (typed) text with no active flow passthrough.
    // Numeric inputs, pure emoji, and very short inputs are excluded — they are
    // almost certainly quantity/date answers, not questions.
    //
    // [FIX-MFQ-DIRECT] Previously this stopped to ask "pause and get your question
    // answered, or continue?" and made the customer tap a THIRD button (after
    // whatever got them mid-flow, and before the actual answer) just to receive an
    // answer they'd already typed. That defeated the point of typing a question
    // instead of tapping "❓ Ask a Question" in the first place — a customer should
    // be able to ask at any point, with or without the button, and just get answered.
    // Fix: answer immediately (same data-backed/AI logic previously gated behind the
    // MFQ_SWITCH_YES tap), then offer a single "↩️ Continue" so they can pick the
    // flow back up whenever they're ready. No permission-to-ask step in between.
    // MFQ_SWITCH_YES/NO handlers above are kept as a safety net for any in-flight
    // session that already received the old two-button prompt before this change.
    if (
      !isInteractive &&
      messageText.length >= 4 &&
      !/^\d+$/.test(messageText.trim()) &&
      session.currentFlow &&
      session.step
    ) {
      const _mfqIsQuestionLike = _detectMidFlowQuestion(messageText, session, business);
      if (_mfqIsQuestionLike) {
        const resumeFlow = session.currentFlow;
        const resumeStep = session.step;
        const resumeData = { ...(session.data || {}) };
        delete resumeData._mfqPendingQuestion;
        delete resumeData._mfqResumeFlow;
        delete resumeData._mfqResumeStep;
        delete resumeData._mfqResumeData;

        // Clear the flow and park resume context in postFlowData, same as MFQ_SWITCH_YES,
        // so MFQ_RESUME_FLOW can pick it back up later.
        await updateSession(from, tenantId, {
          currentFlow:  null,
          step:         null,
          postFlowAck:  'MFQ_RESUME',
          postFlowData: { resumeFlow, resumeStep, resumeData },
          data:         {},
        });

        // Same data-backed/AI answer logic as the old MFQ_SWITCH_YES branch — see
        // [AUDIT-FIX-12] above for why TRACK_ORDER-style questions must route through
        // detectIntent/route rather than a bare AI reply with no order/booking access.
        const DATA_BACKED_MFQ_ACTIONS = new Set(['TRACK_ORDER']);
        const flowlessSession = { ...session, currentFlow: null, step: null, data: {} };

        const resumeButtons = [
          { id: 'MFQ_RESUME_FLOW', title: '↩️ Continue'  },
          { id: 'QUESTION',        title: '❓ Ask Another' },
          { id: 'SHOW_MENU',       title: '🔄 Main Menu'   },
        ];

        let dataReply = null;
        try {
          const pqResult = await detectIntent({
            message: messageText, isInteractive: false, session: flowlessSession, business,
          });
          if (DATA_BACKED_MFQ_ACTIONS.has(pqResult.action) && pqResult.confidence !== 'LOW') {
            dataReply = await route({
              action: pqResult.action, intent: pqResult.intent, session: flowlessSession,
              message: messageText, business, tenant: tenantDoc, isInteractive: false,
              suggestion: pqResult.suggestion,
            }).catch(() => null);
          }
        } catch (err) {
          logger.warn('[MFQ] mid-flow question data routing failed', { err: err.message });
        }

        if (dataReply) {
          const dataPayloads = Array.isArray(dataReply) ? dataReply : [dataReply];
          for (const dp of dataPayloads) await dispatchMessage(from, dp, tenantDoc);
          await dispatchMessage(from, {
            type:    'buttons',
            body:    `_When you're ready, tap below to continue where you left off._`,
            buttons: resumeButtons,
          }, tenantDoc);
          return;
        }

        // Use the DB-first question layer here too. It resolves contextual menu
        // references against the current catalog before falling back to Groq.
        const { processQuestionMessage } = await import('../services/question/questionAnswerService.js');
        const questionReply = await processQuestionMessage({
          session: flowlessSession, message: messageText, business, tenant: tenantDoc, intent: 'QUESTION',
        }).catch(() => null);
        const aiText = questionReply?.body || null;

        await dispatchMessage(from, {
          type:    'buttons',
          body:    (aiText || 'Let me check that for you! 😊') +
                    `\n\n_When you're done, tap below to continue where you left off._`,
          buttons: resumeButtons,
        }, tenantDoc);
        return;
      }
    }

    // ── 15.1d: Handle FSI switch-prompt button responses ────────────────────
    if (isInteractive) {
      if (upperMsg === 'FSI_SWITCH_YES') {
        // Customer confirmed — abandon the current flow and start the requested one fresh.
        const _fsiTargetFlow = session.data?._fsiTargetFlow || null;
        await updateSession(from, tenantId, {
          currentFlow: null, step: null, data: {}, postFlowAck: null, postFlowData: null,
        });
        if (_fsiTargetFlow) {
          const freshSessFsi = await getSession(from, tenantId) || session;
          const switchReply = await startFlow({
            flowName: _fsiTargetFlow, session: freshSessFsi, business, tenant: tenantDoc,
          });
          if (switchReply) {
            const switchPayloads = Array.isArray(switchReply) ? switchReply : [switchReply];
            for (const payload of switchPayloads) await dispatchMessage(from, payload, tenantDoc);
            return;
          }
        }
        const cfgFsiYes = getModeConfig(business);
        await dispatchMessage(from, buildOptionsReply(cfgFsiYes, '👇 What would you like to do?'), tenantDoc);
        return;
      }

      if (upperMsg === 'FSI_SWITCH_NO') {
        // Customer wants to continue their original flow — restore and re-send the current step.
        const _fsiResumeFlow = session.data?._fsiResumeFlow || session.currentFlow;
        const _fsiResumeStep = session.data?._fsiResumeStep || session.step;
        const _fsiResumeData = session.data?._fsiResumeData || {};

        await updateSession(from, tenantId, {
          currentFlow: _fsiResumeFlow, step: _fsiResumeStep, data: _fsiResumeData,
        });

        const freshSessFsiNo = await getSession(from, tenantId) || session;
        const fsiResumeReply = await advance({
          session:       { ...freshSessFsiNo, currentFlow: _fsiResumeFlow, step: _fsiResumeStep, data: _fsiResumeData },
          message:       '',
          business, tenant: tenantDoc, isInteractive: false,
        });
        if (fsiResumeReply) {
          const fsiPayloads = Array.isArray(fsiResumeReply) ? fsiResumeReply : [fsiResumeReply];
          for (const payload of fsiPayloads) await dispatchMessage(from, payload, tenantDoc);
        } else {
          const stepLabelFsi = _mfqStepLabel(_fsiResumeFlow, _fsiResumeStep);
          await dispatchMessage(from, {
            type: 'text',
            body: `👍 No problem! Let's continue — ${stepLabelFsi}`,
          }, tenantDoc);
        }
        return;
      }
    }

    // ── 15.1e: Detect a mid-flow request to switch activity ────────
    const _fsiEligible = session.currentFlow && (session.step || isInteractive);
    if (_fsiEligible) {
      const _fsiTargetFlow = _detectMidFlowSwitchRequest(
        messageText, session, business, isInteractive,
      );
      if (_fsiTargetFlow) {
        const stepLabelFsi = _mfqStepLabel(session.currentFlow, session.step);
        const fsiSwitchFlow = session.currentFlow;
        const fsiSwitchStep = session.step;
        const fsiSwitchData = { ...(session.data || {}) };
        const { snapshotActivityData } = await import('../services/question/questionModeHelper.js');
        const activitySnapshot = snapshotActivityData(session, session.currentFlow);

        await updateSession(from, tenantId, {
          data: {
            ...fsiSwitchData,
            _fsiTargetFlow,
            _fsiResumeFlow: fsiSwitchFlow,
            _fsiResumeStep: fsiSwitchStep,
            _fsiResumeData: { ...fsiSwitchData, _activitySnapshot: activitySnapshot },
          },
        });

        // [AUDIT-FIX-9] Label must be mode-aware — a literal restaurant-only
        // wording here read strangely once the [FIX-FSI-2] capability gate let
        // non-restaurant verticals (salon, bakery, cosmetics, etc.) reach this
        // branch too. Source it from the business's own mode config welcomeButtons
        // instead of a hardcoded string.
        const cfgFsi         = getModeConfig(business);
        const targetBtnId   = _fsiTargetFlow === 'BOOKING' ? 'BOOK'
          : _fsiTargetFlow === 'QUESTION' ? 'QUESTION' : 'ORDER';
        const targetBtn       = (cfgFsi.ui?.welcomeButtons || []).find(b => b.id === targetBtnId);
        const targetLabel     = targetBtn?.title || (
          _fsiTargetFlow === 'BOOKING' ? '📅 Switch flow'
            : _fsiTargetFlow === 'QUESTION' ? '❓ Ask Questions'
              : '🛒 Switch flow'
        );

        await dispatchMessage(from, {
          type:    'buttons',
          body:
            `👋 Looks like you'd like to switch things up — you're currently ${stepLabelFsi}.\n\n` +
            `Would you like to *${targetLabel}* instead, or *continue* what you were doing?`,
          buttons: [
            { id: 'FSI_SWITCH_YES', title: `✅ ${targetLabel}` },
            { id: 'FSI_SWITCH_NO',  title: '↩️ Continue'      },
          ],
        }, tenantDoc);
        return;
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ensure imageUrl cannot be truthy here with messageText empty — but including it as
    // a fallback is a silent footgun: if either guard is ever relaxed or a new message
    // type is added, advance() would receive a WhatsApp media ID as customer text,
    // producing nonsense flow transitions with no error. Remove the dead fallback entirely.
    const reply = await advance({
      session: freshSession,
      message: messageText,
      business, tenant: tenantDoc, isInteractive, flowReply,
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

  const { action, intent, confidence, suggestion, nlu } = await detectIntent({
    message: messageText, isInteractive, session, business,
  });

  // [ENHANCED-NLU] Persist extracted entities for START_ORDER handoff (cart pre-seed).
  if (nlu?.entities?.products?.length) {
    updateSession(from, tenantId, {
      data: { ...(session.data || {}), _nluPending: nlu.entities },
    }).catch(() => {});
    session = {
      ...session,
      data: { ...(session.data || {}), _nluPending: nlu.entities },
    };
  }

  // [ENHANCED-NLU] Record typed customer message for multi-turn Groq context.
  if (!isInteractive && messageText && messageText.trim().length >= 2) {
    import('../core/nlu/nluContext.js').then(({ appendAiHistoryTurn }) => {
      const aiHistory = appendAiHistoryTurn(session, 'user', messageText);
      updateSession(from, tenantId, { aiHistory }).catch(() => {});
      session = { ...session, aiHistory };
    }).catch(() => {});
  }

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

  // [FEAT-EMOTION-WIRE-1] emotionEngine.js was fully built and unit-tested but
  // never actually invoked anywhere in the live pipeline — detectPreFlowEmotion()/
  // applyEmotionTone() existed only in isolation, with zero effect on any
  // customer-facing reply. Wiring it in here: deterministic regex detection on
  // the raw customer message, zero cost, works on every message. Emotion changes
  // reply tone only, per spec — never routing. (This codebase's AI classify step
  // no longer returns its own emotion signal, so unlike an earlier iteration of
  // this wiring, there is no AI-derived fallback here — regex detection only.)
  //
  // [FIX-EMOTION-INTERACTIVE-1] messageText for a button/list tap is the
  // internal id (extractMessage() prefers btn.id over btn.title, correctly,
  // for intent routing) — e.g. "BROWSE_CATALOG", "VIEW_MENU", "CONFIRM_ORDER".
  // Running detectPreFlowEmotion on that id is a category error: the
  // shouting/all-caps heuristic (built to catch a customer typing in caps)
  // fires on almost any ALL_CAPS_SNAKE_CASE id >=6 letters, misclassifying it
  // as FRUSTRATED and prepending "😔 Sorry about that — let's sort this out
  // quickly." to what should be a normal, happy-path button-driven reply.
  // A button tap is a selection, not customer prose — never a sentiment
  // signal — so emotion detection only runs for actual typed text.
  let finalEmotion = 'NEUTRAL';
  if (!isInteractive) {
    try {
      const { detectPreFlowEmotion } = await import('../core/sentiment/emotionEngine.js');
      finalEmotion = detectPreFlowEmotion(messageText).emotion;
    } catch (err) {
      logger.debug('[Webhook] emotion detection skipped', { err: err.message });
    }
  }

  // [AUDIT-FIX-EMOTION-ESCALATE-1] The tone-prefix wiring above (FEAT-EMOTION-WIRE-2)
  // is purely cosmetic — it prepends "😔 Sorry about that" to whatever route()
  // already decided to send, but never changes WHAT gets sent. That's fine when
  // intent detection found something genuinely relevant, but FALLBACK/CLARIFY
  // specifically mean "nothing matched — here's an AI guess plus the default menu
  // buttons" (see moduleRouter.js FALLBACK/CLARIFY case). Stacking an apology on
  // top of an unrelated menu dump reads as the bot ignoring an upset customer —
  // exactly the "here's our menu" failure mode this fix targets.
  //
  // A message this angry that ALSO matches something specific (COMPLAINT_RE,
  // CANCEL, a real keyword/direct-phrase/AI intent) already resolved to that
  // more specific action upstream in detectIntent() and never reaches here as
  // FALLBACK/CLARIFY — the broadened negationGuard.js COMPLAINT_RE
  // ([AUDIT-FIX-COMPLAINT-BROADEN-1]) already escalates most of these cases
  // earlier. This is the narrower net for whatever still slips through (e.g.
  // frustration expressed only via punctuation/shouting, which the regex-only
  // complaint guard can't see): redirect a FRUSTRATED customer with no other
  // match straight into the existing SUPPORT flow (human handoff + admin
  // alert + bot goes silent) instead of the generic fallback.
  let effectiveAction = action;
  let effectiveIntent = intent;
  if (finalEmotion === 'FRUSTRATED' && (action === 'FALLBACK' || action === 'CLARIFY')) {
    logger.info('[Webhook] FRUSTRATED + generic action — escalating to SUPPORT', {
      from, tenantId, originalAction: action, messagePreview: messageText?.slice(0, 60),
    });
    effectiveAction = 'SUPPORT';
    effectiveIntent = 'SUPPORT';
  }

  let reply = await route({
    action: effectiveAction, intent: effectiveIntent, session,
    message: messageText, business,
    tenant: tenantDoc, isInteractive, suggestion, nlu,
  });

  // [FEAT-EMOTION-WIRE-2] Apply the tone prefix using the SAME finalEmotion
  // computed above (before route()) — no need to re-detect. NEUTRAL/URGENT
  // intentionally have no prefix (see emotionEngine.js TONE_PREFIX) so this is
  // a no-op for those. [AUDIT-FIX-EMOTION-ESCALATE-1] Skipped when we just
  // escalated to SUPPORT above — that reply already opens with its own
  // apologetic framing ("I've flagged this to our team"), so a second, separate
  // "Sorry about that" line on top would just be redundant.
  if (reply && finalEmotion !== 'NEUTRAL' && effectiveAction !== 'SUPPORT') {
    try {
      const { applyEmotionTone } = await import('../core/sentiment/emotionEngine.js');
      reply = applyEmotionTone(reply, finalEmotion);
    } catch (err) {
      logger.debug('[Webhook] emotion tone skipped', { err: err.message });
    }
  }

  // [ENHANCED-NLU] Multi-intent messages ("add 2 Domoda, also what time do you
  // close?") — the primary intent already executed normally via route() above.
  // If the classifier pulled out a distinct secondary business question, answer
  // it too and append the answer to the same reply, rather than silently
  // dropping it. Deliberately DB-first/deterministic (tryDatabaseAnswer, same
  // lookup QUESTION mode uses) and never triggers a flow itself — consistent
  // with the golden rule that AI never triggers flows directly, it only
  // informs. Skipped when the primary action already IS 'QUESTION' (that
  // path already answers this exact message) or when there's nothing to add.
  if (reply && effectiveAction !== 'QUESTION' && nlu?.entities?.questions?.length) {
    try {
      const { tryDatabaseAnswer } = await import('../services/question/questionAnswerService.js');
      const secondaryQuestion = nlu.entities.questions[0];
      const dbAnswer = await tryDatabaseAnswer({ message: secondaryQuestion, business, session });
      if (dbAnswer?.handled && dbAnswer.body) {
        const wasArray = Array.isArray(reply);
        const payloads = wasArray ? [...reply] : [reply];
        const idx = payloads.length - 1;
        const last = payloads[idx];
        if (typeof last === 'string') {
          payloads[idx] = `${last}\n\n${dbAnswer.body}`;
        } else if (last && typeof last.body === 'string') {
          payloads[idx] = { ...last, body: `${last.body}\n\n${dbAnswer.body}` };
        }
        reply = wasArray ? payloads : payloads[0];
      }
    } catch (err) {
      logger.debug('[Webhook] secondary question answer skipped', { err: err.message });
    }
  }

  if (reply) {
    // reply can be an array (e.g. [imagePayload, buttonsPayload]) — dispatch each in order
    const payloads = Array.isArray(reply) ? reply : [reply];
    for (const payload of payloads) {
      await dispatchMessage(from, payload, tenantDoc);
    }
    const lastPayload = payloads[payloads.length - 1];
    const body = typeof lastPayload === 'string' ? lastPayload : lastPayload?.body;
    if (body) {
      updateSession(from, tenantId, { lastBotMessage: body }).catch(() => {});
      import('../core/nlu/nluContext.js').then(({ appendAiHistoryTurn }) => {
        getSession(from, tenantId).then(s => {
          if (!s) return;
          updateSession(from, tenantId, {
            aiHistory: appendAiHistoryTurn(s, 'assistant', body),
          }).catch(() => {});
        }).catch(() => {});
      }).catch(() => {});
    }

    // [CATALOG-ORDER-WIRE] The customer's own in-flow path (typed quantity,
    // tapped variant, etc. — as opposed to the immediate no-further-questions
    // handoff at [CATALOG-ORDER-WIRE] above) just reached ORDER_CONFIRMED.
    // If this order originated from a multi-item WA Catalog cart, drain the
    // next queued line now instead of leaving it stranded until some
    // unrelated future message happens to touch it.
    try {
      const postSession = await getSession(from, tenantId);
      if (postSession?.postFlowAck === 'ORDER_CONFIRMED' && postSession?.pendingCatalogQueue?.length) {
        const { drainCatalogQueue } = await import('../modules/catalog/waCatalogFlow.js');
        await drainCatalogQueue({ session: postSession, business, tenant: tenantDoc });
      }
    } catch (err) {
      logger.debug('[Webhook] drainCatalogQueue check skipped (non-fatal)', { err: err.message });
    }
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
          // [AUDIT-FIX-SAFETYNET-SCOPE] Hoisted out of the try block below.
          // Previously `from` and `tenant` were declared with `const` INSIDE the
          // try{} — invisible to the catch{} block that follows it. The
          // [FIX-SILENCE-SAFETYNET] fallback reply in that catch block referenced
          // both, so instead of guaranteeing the customer got a reply on any
          // unexpected error, it threw its own "from is not defined" /
          // "tenant is not defined" ReferenceError, which was swallowed by the
          // fallback's own inner try/catch — leaving the customer with the exact
          // total silence this safety net was written to prevent.
          let from   = msg?.from;
          let tenant = null;
          try {
            from   = msg.from;
            const msgType = msg.type || 'unknown';

            logger.info('[Webhook] â–º Incoming message', {
              from,
              type: msgType,
              phoneNumberId,
              wamid: msg.id,
            });

            tenant = await Tenant.findOne({ 'whatsapp.phoneNumberId': phoneNumberId, status: 'ACTIVE' }).lean();

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

            // [META-CREDS] Per-tenant webhook HMAC verification. Tries the tenant's own
            // secret and the global META_APP_SECRET fallback (see [FIX-SIG-1] on
            // _verifyTenantWebhookSignature) — either matching is sufficient. Runs after
            // tenant resolution so we know which secret(s) to try. On failure, the
            // detailed diagnostic log is emitted inside _verifyTenantWebhookSignature
            // itself (it has the rawBody/secret-source context this call site doesn't).
            if (!_verifyTenantWebhookSignature(req, tenant, msg.id)) {
              // [FIX-SIG-DUP] A mismatch does NOT necessarily mean the customer's tap
              // was lost. WhatsApp/Meta fans a single event out to every webhook
              // subscription configured on the WABA — if more than one Meta App (e.g.
              // an old/legacy app left subscribed alongside the current one) points at
              // this same URL, each copy is signed with ITS OWN App Secret. Only the
              // copy signed with the secret we know about verifies; the other copy of
              // the *same* wamid legitimately fails HMAC here even though nothing is
              // actually broken for the customer.
              //
              // Distinguish the two cases instead of alarming on both:
              //   - wamid already in ProcessedMessage → the valid twin already got
              //     through and was handled. This is delivery noise, not an incident.
              //   - wamid NOT found → this copy is the only one we've seen; the
              //     customer really did not get a reply. Keep this loud.
              const alreadyHandled = await ProcessedMessage.findOne({ wamid: msg.id, tenantId: String(tenant._id) }).lean();
              if (alreadyHandled) {
                logger.info('[Webhook] Duplicate delivery with non-matching signature ignored — ' +
                  'message already processed via a valid delivery, customer unaffected', {
                  tenantId: String(tenant._id), wamid: msg.id, from,
                });
              } else {
                // [FIX-SIG-FINGERPRINT] Escalated from warn → error: unlike the
                // duplicate-noise branch above, this is not routine — no valid
                // copy of this message was ever processed, so the customer got
                // no reply at all. Includes fingerprints so the fix (re-enter
                // the correct secret vs. hunt for a legacy subscribed app) is
                // directly actionable from this one log line.
                logger.error('[Webhook] ✗✗ Signature mismatch and NO successful duplicate found for this wamid — ' +
                  'customer did NOT receive a reply. Check for a second/legacy Meta App still ' +
                  'subscribed to this WABA\'s webhook, or re-verify meta.appSecret/META_APP_SECRET via ' +
                  'POST /admin/webhook-secret-fingerprint.', {
                  tenantId: String(tenant._id), wamid: msg.id, from, phoneNumberId,
                });
              }
              continue; // Skip this message — possible spoofed request, or an unmatched duplicate
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
            // [FIX-SILENCE-SAFETYNET] Previously an uncaught exception anywhere in
            // handleIncomingMessage() (a bug, a genuinely broken dependency, an
            // unexpected null, etc.) resulted in TOTAL silence for the customer —
            // logged here but nothing ever sent back. From the customer's side
            // that's indistinguishable from the bot being dead. A best-effort,
            // dependency-free plain-text reply here guarantees they always get
            // SOMETHING, even when the real handler failed in a way we haven't
            // seen before. Wrapped in its own try/catch and never rethrows —
            // this is a last resort, not a new failure point.
            try {
              await dispatchMessage(from, {
                type: 'text',
                body: "⚠️ Sorry, something went wrong on our end processing that. Please try again in a moment.",
              }, tenant);
            } catch { /* truly nothing more we can do */ }
          }
        }
      }
    }
  } catch (err) {
    logger.error('[Webhook] receiveWebhook outer error', { err: err.message, stack: err.stack?.slice(0, 300) });
  }
}

