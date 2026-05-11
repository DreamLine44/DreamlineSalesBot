/**
 * faqService.js
 *
 * FIX [8]: FAQ map / custom Q&A — proper trigger/reply schema with keyword matching.
 *
 * Business config schema (stored in BusinessConfig.js / DB):
 *   faq: [
 *     { trigger: "wifi", reply: "Our wifi password is GuestPass2024" },
 *     { trigger: "parking", reply: "Free parking is available behind the building." },
 *     { trigger: "opening hours", reply: "We open Mon–Fri 9am to 5pm." },
 *   ]
 *
 * Matching is case-insensitive substring match against each trigger keyword.
 * The FIRST matching FAQ entry wins (order matters — put specific before generic).
 *
 */

/**
 * Try to match `messageText` against the business FAQ entries.
 *
 * @param {string}   messageText   Raw incoming customer message
 * @param {object}   business      Business document (has .faq array)
 * @returns {string|null}          The reply string, or null if no FAQ matched
 */
function resolveFaq(messageText, business) {
  const faqs = business?.faq;
  if (!Array.isArray(faqs) || faqs.length === 0) return null;

  const lower = messageText.toLowerCase();

  for (const entry of faqs) {
    if (!entry.trigger || !entry.reply) continue;

    // Support multi-word triggers and comma-separated aliases:
    //   { trigger: "wifi, wi-fi, password", reply: "..." }
    const triggers = entry.trigger
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    for (const t of triggers) {
        // [v11] Prefer word-boundary match to avoid "price" matching "prices" partially
        // Falls back to simple includes() for multi-word triggers like "opening hours"
        const wordMatch = t.includes(' ')
          ? lower.includes(t)
          : new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower);
        if (wordMatch) {
          return entry.reply;
        }
      }
  }

  return null; // No match — let Groq handle it
}

/**
 * Build a human-readable FAQ summary for the Groq system prompt.
 * (Used as supplemental context so Groq knows what the business offers.)
 *
 * @param {object} business
 * @returns {string}
 */
function buildFaqContext(business) {
  const faqs = business?.faq;
  if (!Array.isArray(faqs) || faqs.length === 0) return '';

  const lines = faqs
    .filter((e) => e.trigger && e.reply)
    .map((e) => `• "${e.trigger}" → ${e.reply}`);

  if (lines.length === 0) return '';

  return `\nKnown FAQ answers (answer these directly, do not make up alternatives):\n${lines.join('\n')}\n`;
}

export { resolveFaq, buildFaqContext };
