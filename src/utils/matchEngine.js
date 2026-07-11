/**
 * utils/matchEngine.js
 * Fuzzy item name matching for menu/catalog selection.
 * Uses trigram similarity + Levenshtein distance.
 * Returns HIGH / LOW / NONE confidence — callers decide what to do with LOW.
 */

import levenshtein from 'fast-levenshtein';

const norm = (s = '') =>
  s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

function trigrams(str) {
  const s = ` ${str} `;
  const set = new Set();
  for (let i = 0; i < s.length - 2; i++) set.add(s.slice(i, i + 3));
  return set;
}

function trigramSimilarity(a, b) {
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size + tb.size - shared, 1);
}

/**
 * findBestMatch(items, query)
 *
 * @param items  Array of menu/catalog items with .name property
 * @param query  Normalised customer input string
 * @returns { item, confidenceLevel: 'HIGH'|'LOW'|'NONE', score }
 */
export function findBestMatch(items = [], query = '') {
  if (!items.length || !query.trim()) return { item: null, confidenceLevel: 'NONE', score: 0 };

  const q = norm(query);
  let best = null;
  let bestScore = -1;

  for (const item of items) {
    const n = norm(item.name);

    // [AUDIT-FIX-KEYWORDS] Menu items carry an optional `keywords` array —
    // tenant-configured aliases/synonyms for the item (schema: menuItemSchema.keywords,
    // max 20/item; editable via the dashboard's addMenuItem/updateMenuItem CRUD).
    // e.g. a tenant sells "Coca-Cola" but wants customers typing "coke" or "soda" to
    // still find it. Previously this function only ever compared against `item.name`
    // — `keywords` was written to the DB and returned by every menu API response, but
    // had ZERO effect on matching anywhere in the codebase, for any of the 8+ modules
    // that call findBestMatch(). A customer typing a tenant-configured alias got
    // "I couldn't find that" instead of the item. Fix: score every keyword alongside
    // the item name and let the best of them win.
    const candidates = [n];
    if (Array.isArray(item.keywords)) {
      for (const kw of item.keywords) {
        const nkw = norm(String(kw ?? ''));
        if (nkw) candidates.push(nkw);
      }
    }

    for (const c of candidates) {
      // Exact match → instant HIGH
      if (c === q) return { item, confidenceLevel: 'HIGH', score: 1 };

      // Substring match → HIGH
      if (c.includes(q) || q.includes(c)) {
        const score = 0.85 + (Math.min(c.length, q.length) / Math.max(c.length, q.length)) * 0.15;
        if (score > bestScore) { bestScore = score; best = item; }
        continue;
      }

      // Trigram similarity
      const tri = trigramSimilarity(q, c);
      // Levenshtein — normalised
      const lev = 1 - levenshtein.get(q, c) / Math.max(q.length, c.length, 1);
      const score = tri * 0.6 + lev * 0.4;
      if (score > bestScore) { bestScore = score; best = item; }
    }
  }

  if (!best) return { item: null, confidenceLevel: 'NONE', score: 0 };

  const confidenceLevel = bestScore >= 0.72 ? 'HIGH' : bestScore >= 0.45 ? 'LOW' : 'NONE';
  return { item: best, confidenceLevel, score: bestScore };
}
