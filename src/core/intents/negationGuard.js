/**
 * core/intents/negationGuard.js
 *
 * [FEAT-NEGATION-1] Deterministic, zero-latency negation / cancellation /
 * rejection / correction / hesitation detector.
 *
 * WHY THIS EXISTS
 * intentEngine.js's exact-keyword step (step 4) already requires the WHOLE
 * normalised message to equal an INTENT_PATTERNS entry, so an isolated keyword
 * inside a negated sentence ("I don't want food") can never accidentally fire
 * a workflow in this codebase — that specific bug class described in the
 * WhatSales Conversational Intelligence spec doesn't apply here.
 *
 * The real, existing gap is longer free-form cancellation/rejection/correction
 * phrasing that doesn't literally equal a CANCEL/SUPPORT keyword entry (e.g.
 * "please just forget it, I don't want to continue with this"), which:
 *   - falls through every deterministic layer, AND
 *   - is entirely unavailable whenever session.currentFlow is set, because
 *     AI classify (step 7) is deliberately skipped for in-flow sessions
 *     (see intentEngine.js FIX-INTENT-AI) — it would otherwise land on the
 *     generic FALLBACK/CLARIFY card and silently derail the active flow.
 *
 * This module gives cancellation/rejection/correction detection a synchronous,
 * AI-free path that works identically in and out of active flows, consistent
 * with the file's own golden rule: "Only CANCEL/CONFIRM can escape" a flow.
 *
 * DESIGN CONSTRAINT (same as emotionEngine.js): synchronous regex only, no
 * network call, no timers — safe to run unconditionally on the hot path.
 *
 * Deliberately conservative: every pattern requires an explicit, high-signal
 * phrase (mirrors the vocabulary in the spec's Negation / Cancellation /
 * Rejection / Correction / Hesitation sections). Ambiguous or single-word
 * input is left to the existing keyword/Levenshtein/AI layers untouched.
 *
 * NOTE: deliberately does NOT import from intentEngine.js (which imports this
 * module) — a tiny local normalise() avoids a circular import.
 */

function normaliseLocal(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Explicit cancellation of an active workflow/order/booking.
const CANCELLATION_RE = /\b(cancel(?:led|ling)?|forget\s*it|never\s*mind|nevermind|stop\s*(?:this|the\s*order|it)?|don\s*t\s*continue|leave\s*it|not\s*anymore|scrap\s*(?:this|it|that)|i\s*don\s*t\s*want\s*(?:this|it|that)\s*anymore)\b/i;

// Soft rejection — decline without necessarily cancelling an active flow.
const REJECTION_RE = /\b(no\s*thanks|nah|not\s*now|maybe\s*later|not\s*interested|i\s*don\s*t\s*want\s*(?:it|this|that)\b(?!\s*anymore)|rather\s*not|don\s*t\s*need\s*(?:it|this|that))\b/i;

// General negation that should block a positive-intent read when it wraps
// the whole message (e.g. "I'm not looking for the menu").
const NEGATION_RE = /\b(i\s*don\s*t\s*want|i\s*am\s*not\s*(?:looking|interested|ordering)|i\s*m\s*not\s*(?:looking|interested|ordering)|not\s*looking\s*for|not\s*interested\s*in|don\s*t\s*need|no\s*longer\s*want|not\s*right\s*now)\b/i;

// Confirmation — proceed with the current step.
const CONFIRMATION_RE = /\b(yes|yeah|yep|sure|okay|ok|correct|that\s*s\s*right|confirmed?|go\s*ahead)\b/i;

// Corrections — customer is amending something they already said, not
// starting a fresh request. Routing should treat this as CONTINUE_FLOW and
// let the active flow's own handler reparse the correction.
const CORRECTION_RE = /^(actually|sorry|wait|i\s*meant|correction|no\s*wait|scratch\s*that)\b|\bmake\s*(?:it|that)\s+/i;

// Hesitation — customer is unsure; don't push a workflow, just be helpful.
const HESITATION_RE = /\b(maybe|perhaps|i\s*m\s*(?:just\s*)?thinking|not\s*sure|i\s*might|possibly|just\s*browsing|just\s*looking)\b/i;

// Complaints — must always escape to support, never be swallowed as a flow
// answer, FAQ, or the correction guard (spec: Complaint Handling — "Route to
// START_SUPPORT_WORKFLOW... never treat as FAQ or redirect to an unrelated
// workflow"). Free-form complement to the existing bare-word SUPPORT keyword
// entries ('refund', 'complaint', 'wrong order', 'manager', ...), which only
// match when they are the ENTIRE message.
const COMPLAINT_RE = /\b(wrong\s*order|cold\s*food|late\s*delivery|poor\s*service|terrible\s*service|awful\s*service|missing\s*items?|speak\s*to\s*(?:a\s*)?manager|i\s*have\s*a\s*complaint|this\s*is\s*(?:wrong|unacceptable)|not\s*happy\s*with|order\s*was\s*wrong|food\s*was\s*cold|i\s*want\s*a\s*refund)\b/i;

/**
 * analyzeMessage(rawMessage)
 *
 * @param {string} rawMessage — raw, un-normalised customer message text
 * @returns {{
 *   cancelled: boolean,
 *   rejected: boolean,
 *   negated: boolean,
 *   confirmed: boolean,
 *   correction: boolean,
 *   hesitant: boolean,
 *   complaint: boolean,
 * }}
 */
export function analyzeMessage(rawMessage = '') {
  const clean = normaliseLocal(rawMessage);
  if (!clean) {
    return {
      cancelled: false, rejected: false, negated: false, confirmed: false,
      correction: false, hesitant: false, complaint: false,
    };
  }

  const negated  = NEGATION_RE.test(clean);
  const rejected = REJECTION_RE.test(clean);

  return {
    cancelled:  CANCELLATION_RE.test(clean),
    rejected,
    negated,
    // A clean confirmation must not also read as a negation/rejection —
    // "yes but actually no" should never register as a confirm.
    confirmed:  CONFIRMATION_RE.test(clean) && !negated && !rejected,
    correction: CORRECTION_RE.test(clean),
    hesitant:   HESITATION_RE.test(clean),
    complaint:  COMPLAINT_RE.test(clean),
  };
}
