/**
 * matchEngine.js — Dreamline Sales Bot v10
 *
 * STRICT MATCHING ALGORITHM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ROOT CAUSE OF THE BUG (v8/v9):
 *   "hello" was auto-selected as "Jollof Rice" because they share a 3-letter
 *   sequential run ("llo"). The old engine treated that as a "strong match"
 *   and auto-selected without asking the customer. WRONG.
 *
 * FIX — Five-tier system with a strict confidence gate:
 *
 *  ┌───────────────────────────────────────────────────────────────────────┐
 *  │  Tier 1 — EXACT word match            → confidenceLevel "HIGH"        │
 *  │  Tier 2 — PREFIX match (>=3 chars)    → confidenceLevel "HIGH"        │
 *  │  Tier 3 — SUFFIX match (>=3 chars)    → confidenceLevel "HIGH"        │
 *  │  Tier 4 — SUBSTRING match (>=3 chars) → confidenceLevel "HIGH"        │
 *  │  Tier 5 — TRIGRAM (>=3 consecutive)   → confidenceLevel "LOW"         │
 *  │           ONLY IF prefix OR suffix overlap >= 2 chars also present.   │
 *  │           (This gate is what blocks "hello" -> "jollof".)             │
 *  └───────────────────────────────────────────────────────────────────────┘
 *
 * Caller decision rules (enforced in flowService):
 *   "HIGH"  -> auto-select (strong, unambiguous match)
 *   "LOW"   -> ask "Did you mean...?" — ONLY select if customer replies YES
 *   "NONE"  -> no match — ask customer to retype or clarify
 *
 * WHY "hello" NO LONGER MATCHES "jollof":
 *   - "hello" and "jollof" share trigram "llo" (Tier 5 candidate)
 *   - commonPrefixLength("hello","jollof") = 0  (h != j)
 *   - commonSuffixLength("hello","jollof") = 1  (only "o" at end)
 *   - 1 < MIN_AFFIX (2) -> gate fails -> confidenceLevel "NONE" -> no match
 */

// --- Constants ----------------------------------------------------------------

const MIN_NGRAM = 3; // minimum consecutive-char overlap for Tier 4/5
const MIN_AFFIX = 2; // prefix OR suffix overlap required to unlock Tier 5 (LOW)

// --- Normalisation ------------------------------------------------------------

export const normalize = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .trim();

const getName = (item) =>
  typeof item === "string" ? item : item.name;

const tokenize = (text) => normalize(text).split(" ").filter(Boolean);

// --- String helpers -----------------------------------------------------------

/** Number of chars matching at the START of both strings. */
const commonPrefixLength = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

/** Number of chars matching at the END of both strings. */
const commonSuffixLength = (a, b) => {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  )
    i++;
  return i;
};

/**
 * Length of longest contiguous substring of `a` that appears in `b`.
 * Only counts runs of length >= MIN_NGRAM.
 * e.g. longestCommonSubstring("jollf","jollof") -> 4 ("joll")
 */
const longestCommonSubstring = (a, b) => {
  let best = 0;
  for (let s = 0; s < a.length; s++) {
    for (let e = s + MIN_NGRAM; e <= a.length; e++) {
      const sub = a.slice(s, e);
      if (b.includes(sub) && sub.length > best) best = sub.length;
    }
  }
  return best;
};

// --- Per-token-pair scoring --------------------------------------------------

/**
 * Score one (inputToken, itemToken) pair.
 * Returns { score, level } where level is "HIGH" | "LOW" | "NONE".
 */
const scoreTokenPair = (input, item) => {
  // Tier 1: EXACT
  if (input === item) return { score: 5, level: "HIGH" };

  // Short inputs cannot produce meaningful matches
  if (input.length < MIN_NGRAM) return { score: 0, level: "NONE" };

  // Tier 2: PREFIX (>= MIN_NGRAM chars in common at the start)
  if (item.startsWith(input)) return { score: 4, level: "HIGH" };
  if (input.startsWith(item) && item.length >= MIN_NGRAM)
    return { score: 4, level: "HIGH" };

  // Tier 3: SUFFIX (>= MIN_NGRAM chars in common at the end)
  if (item.endsWith(input)) return { score: 4, level: "HIGH" };
  if (input.endsWith(item) && item.length >= MIN_NGRAM)
    return { score: 4, level: "HIGH" };

  // Tier 4: SUBSTRING (input >= 3 chars found inside item, or vice versa)
  if (item.includes(input)) return { score: 3, level: "HIGH" };
  if (item.length >= MIN_NGRAM && input.includes(item))
    return { score: 3, level: "HIGH" };

  // Tier 5: TRIGRAM + AFFIX GATE (LOW confidence - "Did you mean?" only)
  //
  // THE KEY FIX: two words can share a 3-letter run by coincidence
  // ("hello"/"jollof" both contain "llo"). Requiring meaningful overlap at
  // the START or END of the words filters those false positives out.
  //
  // Both conditions must be true to reach LOW confidence:
  //   (a) longestCommonSubstring >= MIN_NGRAM  (trigram overlap)
  //   (b) prefix overlap >= MIN_AFFIX  OR  suffix overlap >= MIN_AFFIX
  //
  if (item.length >= MIN_NGRAM) {
    const trigramLen = longestCommonSubstring(input, item);
    if (trigramLen >= MIN_NGRAM) {
      const prefixLen = commonPrefixLength(input, item);
      const suffixLen = commonSuffixLength(input, item);
      if (prefixLen >= MIN_AFFIX || suffixLen >= MIN_AFFIX) {
        return { score: 2, level: "LOW" };
      }
    }
  }

  return { score: 0, level: "NONE" };
};

// --- Aggregate scorer --------------------------------------------------------

const LEVEL_RANK = { NONE: 0, LOW: 1, HIGH: 2 };

const computeScore = (inputTokens, itemTokens) => {
  let totalScore = 0;
  let highestLevel = "NONE";

  for (const input of inputTokens) {
    for (const item of itemTokens) {
      const { score, level } = scoreTokenPair(input, item);
      totalScore += score;
      if (LEVEL_RANK[level] > LEVEL_RANK[highestLevel]) {
        highestLevel = level;
      }
    }
  }

  return { totalScore, highestLevel };
};

// --- Public API --------------------------------------------------------------

/**
 * findBestMatch(menu, input)
 *
 * Returns { item, score, confidenceLevel }
 *   confidenceLevel: "HIGH" | "LOW" | "NONE"
 *
 * "HIGH"  -> caller should auto-select
 * "LOW"   -> caller MUST ask "Did you mean X?" — NEVER auto-select on LOW
 * "NONE"  -> no useful match, ask customer to retype
 *
 * Number-based selection must be handled upstream.
 * Items with available === false are always skipped.
 */
export const findBestMatch = (menu = [], input = "") => {
  const inputTokens = tokenize(input);

  if (!inputTokens.length) {
    return { item: null, score: 0, confidenceLevel: "NONE" };
  }

  let best = { item: null, score: 0, level: "NONE" };

  for (const candidate of menu) {
    if (candidate.available === false) continue;

    const name = getName(candidate);
    const itemTokens = tokenize(name);
    const { totalScore, highestLevel } = computeScore(inputTokens, itemTokens);

    // Prefer higher confidence level first, then higher score
    const candidateWins =
      LEVEL_RANK[highestLevel] > LEVEL_RANK[best.level] ||
      (LEVEL_RANK[highestLevel] === LEVEL_RANK[best.level] &&
        totalScore > best.score);

    if (candidateWins) {
      best = { item: candidate, score: totalScore, level: highestLevel };
    }
  }

  if (!best.item || best.level === "NONE") {
    return { item: null, score: 0, confidenceLevel: "NONE" };
  }

  return { item: best.item, score: best.score, confidenceLevel: best.level };
};

// ─── v15: findBestServiceMatch ────────────────────────────────────────────────
/**
 * findBestServiceMatch(services, input)
 * Same algorithm as findBestMatch but for the services[] array used in Salon mode.
 */
export const findBestServiceMatch = (services = [], input = '') => {
  return findBestMatch(services, input);
};
