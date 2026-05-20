/**
 * utils/parseQuantity.js
 * Converts customer quantity inputs ("two", "3", "a dozen") to integers.
 */

const WORD_MAP = {
  'a':1,'an':1,'one':1,'two':2,'three':3,'four':4,'five':5,
  'six':6,'seven':7,'eight':8,'nine':9,'ten':10,
  'eleven':11,'twelve':12,'thirteen':13,'fourteen':14,'fifteen':15,
  'sixteen':16,'seventeen':17,'eighteen':18,'nineteen':19,'twenty':20,
  'dozen':12,'half dozen':6,'couple':2,'few':3,'several':4,
};

export function parseQuantity(input = '') {
  const s = String(input).trim().toLowerCase();
  if (!s) return null;

  // Pure integer
  const n = parseInt(s, 10);
  if (!isNaN(n) && String(n) === s) return n > 0 && n <= 99 ? n : null;

  // Word lookup
  if (WORD_MAP[s] !== undefined) return WORD_MAP[s];

  // Extract first number
  const match = s.match(/\d+/);
  if (match) {
    const v = parseInt(match[0], 10);
    return v > 0 && v <= 99 ? v : null;
  }

  return null;
}
