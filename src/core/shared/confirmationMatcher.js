/**
 * core/shared/confirmationMatcher.js
 *
 * [FIX-DUALLAYER-CONFIRM] Shared "did the customer mean yes/no" resolver.
 *
 * ROOT PROBLEM THIS FIXES
 * ------------------------
 * Several modules' CONFIRM-style steps (bakery, delivery, salon, cosmetics,
 * retail, services, general) only recognised the LITERAL button-ID strings,
 * e.g.:
 *
 *     if (!['CONFIRM', 'YES'].includes(raw.toUpperCase())) { ...re-prompt... }
 *
 * A button tap always sends exactly that ID, so this silently worked for
 * anyone who only ever taps buttons. But a customer who ignores the buttons
 * and types naturally — "yes please", "sure, confirm it", "go ahead",
 * "yeah that's fine", "nah cancel it" — matches NONE of those exact strings.
 * They fall straight into the "didn't understand, please tap below" re-prompt
 * on a message that was perfectly clear to a human. That's the exact
 * "bot ignores what I typed" failure: the button path works, the typed
 * shortcut path silently fails right next to it.
 *
 * Meanwhile core/intents/negationGuard.js already has a solid deterministic
 * confirm/cancel/reject detector — but it only ever runs at the ROUTER level
 * (intentEngine.js step 4.4/4.6), BEFORE the message is handed to the active
 * flow. Once the router decides "this is a CONTINUE_FLOW", it forwards the
 * *original raw text* to the flow handler, which then re-parses it itself
 * with a much weaker, module-specific check. This file closes that gap by
 * giving every flow step the same robust resolver the router already trusts,
 * plus an AI safety net for the residue neither can classify.
 *
 * TWO-LAYER DESIGN (button method + text method, no weak spots)
 * ---------------------------------------------------------------
 *   Layer 0 — Button IDs. If the reply matches one of the flow's own
 *             affirm/negate button IDs, it wins outright — zero ambiguity,
 *             zero regex, zero AI. "Buttons always win" (same golden rule as
 *             intentEngine.js).
 *   Layer 1 — Deterministic regex (negationGuard.js's analyzeMessage, already
 *             battle-tested elsewhere in this codebase). Instant, free, and
 *             covers the overwhelming majority of natural yes/no phrasing:
 *             yeah, yep, sure, go ahead, correct, that's right / nah, no
 *             thanks, cancel it, forget it, don't want it anymore, etc.
 *   Layer 2 — Groq AI fallback. Only reached when Layers 0–1 are both
 *             inconclusive AND the message looks like it was actually meant
 *             as an answer (not a stray button-style ID, not empty, not a
 *             clearly unrelated new request). Handles genuinely natural
 *             phrasing no regex list will ever fully cover — "I think that
 *             looks right, let's go with it", "hmm actually that's fine",
 *             "no wait, hold on let me check first" — the exact kind of
 *             message a customer sends when they're ignoring the buttons and
 *             just talking normally.
 *
 * Returns 'yes' | 'no' | null. null means "still genuinely unclear" — the
 * caller re-shows the same buttons exactly like before, so behaviour never
 * gets WORSE than today, only more forgiving of real typed language.
 *
 * This never overrides an active cart-modification / item-add / other
 * flow-specific intercept a caller already ran first — it is purely a
 * yes/no classifier for the exact prompt just shown to the customer.
 */

import { analyzeMessage } from '../intents/negationGuard.js';
import logger from '../../config/logger.js';

/**
 * isAffirmative(raw, extraIds?)
 * Synchronous, Layer 0 + Layer 1 only (no AI). Handy for simple binary
 * checks that don't want to await anything.
 */
export function isAffirmative(raw, extraIds = []) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return false;
  const upper = trimmed.toUpperCase();
  if (['CONFIRM', 'YES', ...extraIds.map(x => x.toUpperCase())].includes(upper)) return true;
  return analyzeMessage(trimmed).confirmed;
}

/**
 * isNegative(raw, extraIds?)
 * Synchronous, Layer 0 + Layer 1 only (no AI).
 */
export function isNegative(raw, extraIds = []) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return false;
  const upper = trimmed.toUpperCase();
  if (['CANCEL', 'CANCEL_BOOKING', 'NO', ...extraIds.map(x => x.toUpperCase())].includes(upper)) return true;
  const guard = analyzeMessage(trimmed);
  return guard.cancelled || guard.rejected;
}

// A message that is entirely upper-case letters/digits/underscores AND
// identical to its own raw form is almost certainly a stray/unmapped button
// or list-reply ID, not a human sentence — never worth an AI call, and never
// a valid "yes"/"no" answer on its own.
const LOOKS_LIKE_SYSTEM_ID_RE = /^[A-Z0-9_]+$/;

/**
 * resolveConfirmation({ raw, business, affirmIds, negateIds, allowAI })
 *
 * Full three-layer resolver — the one flow CONFIRM/CANCEL steps should call.
 *
 * @param {string}   raw        - customer's raw message (untrimmed OK)
 * @param {object}   business   - business doc, used only for AI mode context
 * @param {string[]} affirmIds  - button IDs that mean "yes" for this step
 *                                (default ['CONFIRM', 'YES'])
 * @param {string[]} negateIds  - button IDs that mean "no" for this step
 *                                (default ['CANCEL', 'CANCEL_BOOKING', 'NO'])
 * @param {boolean}  allowAI    - set false to skip Layer 2 entirely (default true)
 * @returns {Promise<'yes'|'no'|null>}
 */
export async function resolveConfirmation({
  raw,
  business = null,
  affirmIds = ['CONFIRM', 'YES'],
  negateIds = ['CANCEL', 'CANCEL_BOOKING', 'NO'],
  allowAI = true,
} = {}) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();

  // ── Layer 0: button IDs win outright ──────────────────────────────────────
  if (affirmIds.map(x => x.toUpperCase()).includes(upper)) return 'yes';
  if (negateIds.map(x => x.toUpperCase()).includes(upper)) return 'no';

  // ── Layer 1: deterministic regex guard, zero cost ─────────────────────────
  const guard = analyzeMessage(trimmed);
  if (guard.cancelled || guard.rejected) return 'no';
  if (guard.confirmed) return 'yes';

  // An unrecognised system-style ID (e.g. a stale/renamed button) was never
  // meant for a human reader — don't burn an AI call guessing at it.
  if (LOOKS_LIKE_SYSTEM_ID_RE.test(upper) && upper === trimmed) return null;

  // ── Layer 2: Groq AI fallback — only for genuinely ambiguous free text ────
  if (!allowAI || !process.env.GROQ_API_KEY) return null;
  if (trimmed.length < 4 || trimmed.length > 300) return null;

  try {
    const { classifyIntent } = await import('../ai/providers/groqProvider.js');
    const mode = (business?.businessMode || 'RETAIL').toUpperCase();
    const result = await classifyIntent({
      message:
        `The bot just asked the customer to confirm ("yes") or cancel ("no") ` +
        `their current order/booking/enquiry. The customer replied: "${trimmed}"`,
      validIntents: ['AFFIRM', 'DECLINE', 'UNCLEAR'],
      mode,
    });
    if (result.intent === 'AFFIRM' && (result.confidence === 'HIGH' || result.confidence === 'MEDIUM')) return 'yes';
    if (result.intent === 'DECLINE' && (result.confidence === 'HIGH' || result.confidence === 'MEDIUM')) return 'no';
  } catch (err) {
    logger.warn('[ConfirmationMatcher] AI fallback failed', { err: err.message });
  }
  return null;
}
