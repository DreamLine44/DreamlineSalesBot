/**
 * utils/multiItemParser.js
 *
 * [MULTICART-FLOW-1] Root-cause fix for the "AI misunderstands multi-item orders"
 * bug: utils/matchEngine.js's findBestMatch() only ever returns ONE item for an
 * entire message, so "2 burgers and a coke" was matched against the whole string
 * as if it were a single item name, failed, and fell through to a "couldn't find
 * that on our menu" dead end.
 *
 * extractCartLines() is a pure, side-effect-free scanner: given free text and the
 * tenant's available menu/catalog items, it finds every KNOWN item name actually
 * present in the message, pulls out an adjacent quantity for each, and merges
 * repeats. It does NOT split the message on words like "and"/"with" — instead it
 * searches directly for full item names (longest first), which is what lets
 * "Fish and Chips" match as one line instead of being torn apart by a naive
 * "and"-based split.
 *
 * This module has ZERO dependencies on session/business/DB shape beyond the
 * `{ name }` field every vertical's catalog items already share (menuItems,
 * products, services — see each vertical's flows directory), so it is safe
 * to reuse unchanged across every vertical.
 */

// Word-number lookup for the quantity token immediately preceding a matched
// item name. Intentionally small and unambiguous — anything not in this list
// falls back to parseInt.
const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  dozen: 12, couple: 2, few: 3, several: 4,
};

const MASK_CHAR = '\u0000';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Builds a case-insensitive, word-boundary regex for an item name that also
// tolerates a simple plural ("Burger" also matches "Burgers"). Names that
// already end in 's' (e.g. "Fish and Chips") are left as-is — doubling the
// suffix would create false negatives, not positives.
function buildItemRegex(name) {
  const escaped = escapeRegex(name.trim());
  const pluralSuffix = /s$/i.test(name.trim()) ? '' : '(?:es|s)?';
  return new RegExp(`\\b${escaped}${pluralSuffix}\\b`, 'gi');
}

// Looks at up to `window` characters immediately before `index` in the
// ORIGINAL (unmasked) text for a trailing quantity token — a bare number
// ("2"), a word-number ("two"/"a"/"dozen"), optionally followed by a
// throwaway "x" ("2x burgers"). Returns 1 (the sensible default for "add a
// coke") when nothing is found.
function lookbackQuantity(text, index, window = 25) {
  const before = text.slice(Math.max(0, index - window), index);
  // Strip a trailing loose connector/filler before reading the quantity token
  // itself — "2x ", "3 x ", "2 of ", and modifiers like "two MORE burgers" /
  // "extra fries" that sit between the number and the item name.
  let cleaned = before;
  let stripped;
  do {
    stripped = cleaned;
    cleaned = cleaned.replace(/\s*(?:x|of|more|additional|extra)\s*$/i, '');
  } while (cleaned !== stripped);
  const tokenMatch = cleaned.match(/([a-z]+|\d+)\s*$/i);
  if (!tokenMatch) return 1;

  const token = tokenMatch[1].toLowerCase();
  if (/^\d+$/.test(token)) {
    const n = parseInt(token, 10);
    return n > 0 ? n : 1;
  }
  return NUM_WORDS[token] || 1;
}

/**
 * extractCartLines(text, menuItems)
 *
 * @param text       Raw customer message, e.g. "2 burgers and a coke please"
 * @param menuItems  Array of catalog items with at least a `.name`; pass only
 *                   items already filtered to `available !== false`.
 * @returns {
 *   lines: [{ item: <menuItem>, quantity: number }],   // merged, one per item
 *   matchedCount: number,                              // distinct items found
 * }
 */
export function extractCartLines(text, menuItems = []) {
  const raw = String(text || '');
  if (!raw.trim() || !menuItems.length) return { lines: [], matchedCount: 0 };

  // Longest name first so a compound name ("Fish and Chips") is claimed
  // before its own substrings ("Fish", "Chips") get a chance to match inside it.
  const candidates = [...menuItems]
    .filter(i => i && i.name)
    .sort((a, b) => b.name.length - a.name.length);

  let searchText = raw; // progressively masked so nothing double-matches
  const linesByKey = new Map();

  for (const menuItem of candidates) {
    const re = buildItemRegex(menuItem.name);
    let match;
    while ((match = re.exec(searchText)) !== null) {
      const qty = lookbackQuantity(raw, match.index);
      const key = menuItem._id ? String(menuItem._id) : menuItem.name.toLowerCase();

      if (linesByKey.has(key)) {
        linesByKey.get(key).quantity += qty;
      } else {
        linesByKey.set(key, { item: menuItem, quantity: qty });
      }

      // Mask the matched span (same length, so all other indices stay valid)
      // so this text can never be re-claimed by a shorter/overlapping name.
      searchText =
        searchText.slice(0, match.index) +
        MASK_CHAR.repeat(match[0].length) +
        searchText.slice(match.index + match[0].length);
      re.lastIndex = match.index + match[0].length;
    }
  }

  return { lines: [...linesByKey.values()], matchedCount: linesByKey.size };
}
