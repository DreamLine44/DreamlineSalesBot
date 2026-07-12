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

    // Exact match → instant HIGH
    if (n === q) return { item, confidenceLevel: 'HIGH', score: 1 };

    // Substring match → HIGH
    if (n.includes(q) || q.includes(n)) {
      const score = 0.85 + (Math.min(n.length, q.length) / Math.max(n.length, q.length)) * 0.15;
      if (score > bestScore) { bestScore = score; best = item; }
      continue;
    }

    // Trigram similarity
    const tri = trigramSimilarity(q, n);
    // Levenshtein — normalised
    const lev = 1 - levenshtein.get(q, n) / Math.max(q.length, n.length, 1);
    const score = tri * 0.6 + lev * 0.4;
    if (score > bestScore) { bestScore = score; best = item; }
  }

  if (!best) return { item: null, confidenceLevel: 'NONE', score: 0 };

  const confidenceLevel = bestScore >= 0.72 ? 'HIGH' : bestScore >= 0.45 ? 'LOW' : 'NONE';
  return { item: best, confidenceLevel, score: bestScore };
}
