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
 * In groqService.js, remove the loose `customMessages` dump from the prompt.
 * Instead call resolveFaq() first; if it returns a reply, send it without hitting Groq.
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
      if (lower.includes(t)) {
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
