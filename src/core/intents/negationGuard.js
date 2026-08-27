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
//
// [AUDIT-FIX-COMPLAINT-BROADEN-1] This list used to only cover specific
// product/order complaints ("wrong order", "cold food"...) and had zero
// overlap with core/sentiment/emotionEngine.js's FRUSTRATED_RE, which detects
// general anger/frustration at the BOT/CONVERSATION itself ("ridiculous",
// "unacceptable", "fed up", "useless bot", "this is not working"...).
// Because emotionEngine only ever prepends a short "sorry" tone line to
// whatever route() already decided to send — it never changes the underlying
// action — a customer typing "this is ridiculous, just give me a real
// person" previously fell through to FALLBACK/CLARIFY (an AI reply plus the
// same welcome menu) with only a one-line apology stuck on top, reading as
// if the bot ignored what was actually said.
// Folding that frustration vocabulary in here means the SAME message now
// hits this guard (which runs BEFORE any flow-ownership / AI-skip check —
// see intentEngine.js step 4.2) and is properly escalated to the existing
// SUPPORT action: human handoff, admin alert, bot goes silent — instead of
// only getting a softer tone on an unrelated reply.
// Also added: free-form requests for a human ("talk to someone", "connect me
// with an agent"...) that don't exactly equal one of the SUPPORT keyword
// entries in patterns.js (those only match when they ARE the whole message).
const COMPLAINT_RE = /\b(wrong\s*order|cold\s*food|late\s*delivery|poor\s*service|terrible\s*service|awful\s*service|missing\s*items?|speak\s*to\s*(?:a\s*)?manager|i\s*have\s*a\s*complaint|this\s*is\s*(?:wrong|unacceptable|ridiculous)|not\s*happy\s*with|order\s*was\s*wrong|food\s*was\s*cold|i\s*want\s*a\s*refund|ridiculous|unacceptable|fed\s*up|sick\s*of\s*this|so\s*annoy\w*|annoyed|frustrat\w*|waste\s*of\s*time|useless|worst\s*(?:service|bot|app|experience)|this\s*is\s*not\s*working|is\s*this\s*not\s*working|why\s*is\s*(?:n\s*t\s*)?this\s*working|(?:talk|speak|connect\s*me)\s*(?:to|with)\s*(?:an?\s*)?(?:real\s*)?(?:human|person|agent|someone|manager|owner|boss)|i\s*(?:a|')?m\s*(?:so\s*)?(?:angry|furious|upset)|i\s*am\s*(?:so\s*)?(?:angry|furious|upset)|this\s*is\s*a\s*disaster|completely\s*unacceptable)\b/i;

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
