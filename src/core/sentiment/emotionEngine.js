/**
 * core/sentiment/emotionEngine.js
 *
 * [FEAT-EMOTION-1] Pre-flow emotion detection.
 *
 * WHY THIS EXISTS
 * postFlowHandler.js already classifies sentiment (ACK/COMPLIMENT/COMPLAINT/QUESTION)
 * for messages that arrive AFTER an order/booking completes. There was no equivalent
 * for the PRE-flow window — the first message(s) before/while a customer is starting
 * an order or booking, where urgency, frustration, or confusion most needs a
 * different tone or shortcut.
 *
 * DESIGN CONSTRAINT (non-negotiable, see groqProvider.js AUDIT-FIX-LIVE-1 history):
 * This module must NEVER add latency to the customer-facing reply. Every check here
 * is a synchronous regex/heuristic — no network call, no AI classification, no
 * timers. It runs on the same hot path as ORDER_DIRECT_RE/BOOKING_DIRECT_RE in
 * intentEngine.js and costs about the same (microseconds).
 *
 * If deeper nuance is ever wanted, it must be added as a fire-and-forget, post-reply
 * enrichment step (e.g. refining an admin log entry after the customer already has
 * their answer) — never inserted before dispatchMessage().
 *
 * SCOPE: only meaningful pre-flow (session.currentFlow empty). Post-completion
 * sentiment is already owned by classifyPostFlowSentiment() in postFlowHandler.js —
 * this module does not duplicate that.
 *
 * Returns exactly one label, priority-ordered because a message can trigger more
 * than one pattern (e.g. "this is ridiculous, i need it now" is both frustrated
 * and urgent — frustration is the more actionable signal so it wins):
 *   ANGRY > FRUSTRATED > CONFUSED > URGENT > THANKFUL > HAPPY > NEUTRAL
 */

import { normalise } from '../intents/intentEngine.js';

const ANGRY_RE = /\b(furious|angry|pissed|outraged|disgusted|hate\s+this)\b/i;

// ── Frustration ────────────────────────────────────────────────────────────────
// Deliberately narrow, unambiguous frustration language — not the same list as
// postFlowHandler's COMPLAINT_RE (that's about a completed order being bad; this
// is about the BOT/CONVERSATION itself being frustrating pre-flow).
// [AUDIT-FIX-EMOTION-5] `this\s*is\s*not\s*working` only matched the
// subject-negation-verb order ("this is not working"). A customer typing the
// words in the other natural order — "why IS THIS NOT working" ("is" before
// "this", "not" between "this" and "working") — matched neither this branch nor
// the `why...this\s*working` branch below, and fell all the way through to
// NEUTRAL. `is\s*this\s*not\s*working` covers that second order explicitly
// (kept as its own alternative, rather than folding "not" into the branch
// below, so plain "why is this working" — no negation — still isn't
// misclassified as frustration).
const FRUSTRATED_RE = /\b(ridiculous|unacceptable|fed\s*up|sick\s*of\s*this|so\s*annoy\w*|annoyed|frustrat\w*|waste\s*of\s*time|useless\s*bot|this\s*is\s*not\s*working|is\s*this\s*not\s*working|why\s*is\s*(?:n\s*t\s*)?this\s*working|worst\s*(service|bot|app)|come\s*on)\b/i;

// [AUDIT-FIX-EMOTION-2] Words that indicate a positive/appreciative tone. The
// punctuation/shouting heuristic below (hasFrustrationPunctuation) is intentionally
// blunt — it has no idea what the words actually mean, only how they're punctuated
// or capitalised. Without this guard, "Thanks!!", "THANK YOU SO MUCH", or "SO GOOD!!"
// were misclassified as FRUSTRATED purely for being enthusiastic, which is the
// opposite of correct — a customer being warmly appreciative should never get back
// "Sorry about that — let's sort this out quickly."
const POSITIVE_GUARD_RE = /\b(thanks?|thank\s*you|thx|ty|great|awesome|love|nice|good|perfect|appreciate|amazing|yay|woohoo|excellent|wonderful)\b/i;

// Repeated punctuation / shouting heuristic — computed on the RAW string, not the
// normalised one, since normalise() strips punctuation and lowercases everything.
// [AUDIT-FIX-EMOTION-2] Gated behind POSITIVE_GUARD_RE so "Thanks!!" or "GREAT JOB"
// are never caught here. Bare "!!" alone is no longer a trigger — repeated/combined
// question marks ("??", "?!") are a much more reliable frustration/confusion signal
// than exclamation marks, which are just as commonly used for enthusiasm.
function hasFrustrationPunctuation(raw, clean) {
  if (POSITIVE_GUARD_RE.test(clean)) return false;
  if (/(\?{2,}|\?!|!\?)/.test(raw)) return true; // "??" "?!" "!?"
  const letters = raw.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 6) {
    const upper = raw.replace(/[^A-Z]/g, '');
    if (upper.length / letters.length > 0.7) return true; // SHOUTING
  }
  return false;
}

// ── Confusion ──────────────────────────────────────────────────────────────────
const CONFUSED_RE = /\b(i\s*don\s*t\s*understand|what\s*do\s*you\s*mean|confus\w*|i\s*m\s*lost|no\s*idea\s*what|i\s*don\s*t\s*get\s*it|can\s*you\s*explain|what\s*is\s*going\s*on|huh)\b/i;

// ── Urgency ────────────────────────────────────────────────────────────────────
const URGENT_RE = /\b(asap|as\s*soon\s*as\s*possible|hurry|quick\w*|urgent\w*|right\s*away|in\s*a\s*rush|running\s*late|need\s*(this|it)\s*now|now\s*please|immediately)\b/i;

// ── Thankfulness / happiness ───────────────────────────────────────────────────
const THANKFUL_RE = /\b(thanks?|thank\s*you|thx|ty|cheers|appreciate\s*it|much\s*appreciated)\b/i;
const HAPPY_RE = /\b(can\s*t\s*wait|so\s*excited|yesss+|omg|amazing|woohoo|yay|finally+|great|awesome|love\s+it)\b/i;

/**
 * detectPreFlowEmotion(rawMessage)
 *
 * @param {string} rawMessage — the raw, un-normalised customer message text
 * @returns {{ emotion: 'ANGRY'|'FRUSTRATED'|'CONFUSED'|'URGENT'|'THANKFUL'|'HAPPY'|'NEUTRAL'|'EXCITED', source: string }}
 */
export function detectPreFlowEmotion(rawMessage = '') {
  const raw   = String(rawMessage || '').trim();
  if (!raw) return { emotion: 'NEUTRAL', source: 'empty' };

  const clean = normalise(raw);

  if (ANGRY_RE.test(clean)) {
    return { emotion: 'ANGRY', source: 'regex' };
  }
  if (FRUSTRATED_RE.test(clean)) {
    return { emotion: 'FRUSTRATED', source: 'regex' };
  }
  if (CONFUSED_RE.test(clean)) {
    return { emotion: 'CONFUSED', source: 'regex' };
  }
  if (URGENT_RE.test(clean)) {
    return { emotion: 'URGENT', source: 'regex' };
  }
  if (THANKFUL_RE.test(clean)) {
    return { emotion: 'THANKFUL', source: 'regex' };
  }
  if (HAPPY_RE.test(clean)) {
    return { emotion: 'HAPPY', source: 'regex' };
  }
  // Punctuation/shouting is a weaker, fallback-only signal — checked last so it
  // never overrides a clear keyword match for a different emotion.
  if (hasFrustrationPunctuation(raw, clean)) {
    return { emotion: 'FRUSTRATED', source: 'punctuation' };
  }
  return { emotion: 'NEUTRAL', source: 'none' };
}

// ── Tone prefixes ──────────────────────────────────────────────────────────────
// Short, generic lines only — never displace or rewrite the underlying reply,
// just prepend a one-line acknowledgement. Kept mode-agnostic on purpose so this
// works identically across all business verticals without per-mode copies.
const TONE_PREFIX = {
  ANGRY:      "I'm really sorry — let's fix this right away.\n\n",
  FRUSTRATED: "😔 Sorry about that — let's sort this out quickly.\n\n",
  CONFUSED:   "🙂 No worries at all — let's take it one step at a time.\n\n",
  HAPPY:      '😄 ',
  EXCITED:    '😄 Love the energy! ', // legacy alias
  THANKFUL:   '🙏 ',
  // URGENT and NEUTRAL intentionally have no prefix
};

/**
 * applyEmotionTone(reply, emotion)
 *
 * Prepends a short tone line to the first text-bearing payload found — whether
 * that's a plain string, the only payload, or one item in a multi-payload array
 * (e.g. [imagePayload, buttonsPayload]). Every other payload (images, etc.) is
 * left untouched. Purely additive to whatever route() already built — does not
 * alter flow logic, button sets, or any other field.
 *
 * @param {string|object|Array} reply — whatever route() returned
 * @param {string} emotion
 * @returns same shape as `reply`, with the tone line prepended where applicable
 */
export function applyEmotionTone(reply, emotion) {
  const prefix = TONE_PREFIX[emotion];
  if (!prefix || !reply) return reply;

  const isArray  = Array.isArray(reply);
  const payloads = isArray ? [...reply] : [reply];
  if (!payloads.length) return reply;

  const idx = payloads.findIndex(p =>
    typeof p === 'string' || (p && typeof p === 'object' && typeof p.body === 'string')
  );
  if (idx === -1) return reply; // no text-bearing payload anywhere — leave untouched

  const target = payloads[idx];
  payloads[idx] = typeof target === 'string'
    ? prefix + target
    : { ...target, body: prefix + target.body };

  return isArray ? payloads : payloads[0];
}
