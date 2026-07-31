/**
 * utils/parseQuantity.js
 * Converts customer quantity inputs ("two", "3", "a dozen") to integers.
 *
 * [FIX] Removed the internal upper-bound check (n <= 99).
 *       parseQuantity's job is only to PARSE — not to enforce business rules.
 *       Callers (orderFlow, bookingFlow, etc.) set their own max and return
 *       a specific, helpful error message (e.g. "max is 20").
 *       Before this fix, parseQuantity(109) returned null and the caller said
 *       "Please enter a valid quantity" with no hint about the maximum.
 */

const WORD_MAP = {
  'a':1,'an':1,'one':1,'two':2,'three':3,'four':4,'five':5,
  'six':6,'seven':7,'eight':8,'nine':9,'ten':10,
  'eleven':11,'twelve':12,'thirteen':13,'fourteen':14,'fifteen':15,
  'sixteen':16,'seventeen':17,'eighteen':18,'nineteen':19,'twenty':20,
  'dozen':12,'half dozen':6,'couple':2,'few':3,'several':4,
};

/**
 * parseQuantity(input) → positive integer | null
 *
 * Returns null only when the input cannot be parsed as a positive number at all
 * (e.g. "any", "yes", empty string). Does NOT enforce a maximum — the caller must.
 */
export function parseQuantity(input = '') {
  const s = String(input).trim().toLowerCase();
  if (!s) return null;

  // Word lookup (must come before parseInt to catch "one", "two", etc.)
  if (WORD_MAP[s] !== undefined) return WORD_MAP[s];

  // Pure integer string — no upper cap here
  const n = parseInt(s, 10);
  if (!isNaN(n) && String(n) === s) return n > 0 ? n : null;

  // Extract first number from mixed input like "2 please" or "about 3"
  const match = s.match(/\d+/);
  if (match) {
    const v = parseInt(match[0], 10);
    return v > 0 ? v : null;
  }

  return null;
}
