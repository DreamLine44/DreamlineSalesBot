'use strict';

/**
 * NLP Engine — Intent detection, fuzzy matching, quantity parsing.
 * Handles casual language, typos, partial names, and multi-intent messages.
 */

// ─── Word-to-Number Map ───────────────────────────────────────────────────────
const WORD_NUMBERS = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17,
  eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70,
  eighty:80, ninety:90, hundred:100,
  // Common misspellings
  twleve:12, tweleve:12, elven:11, elevan:11, fiveteen:15, forteen:14, sevteen:17,
  eigteen:18, ninteen:19,
};

// Compound phrases
const PHRASE_NUMBERS = {
  'a dozen': 12, 'one dozen': 12, 'two dozen': 24, 'a couple': 2, 'a pair': 2,
  'half dozen': 6, 'a few': 3, 'several': 4,
  'twenty one': 21, 'twenty two': 22, 'twenty three': 23, 'twenty four': 24,
  'twenty five': 25, 'thirty five': 35, 'forty five': 45,
};

// ─── Intent Patterns ─────────────────────────────────────────────────────────
const INTENTS = [
  // Greetings
  { name: 'GREETING', patterns: [/^(hi|hello|hey|good\s*(morning|afternoon|evening|day|night)|salaam|salam|hola|ola|yo|sup|howdy|greetings|helo|hii+|hey+)\b/i], weight: 10 },
  // Ordering
  { name: 'ORDER',    patterns: [/\b(order|buy|get|want|need|i'?d? ?(like|want)|give me|can i (have|get)|let me (have|get)|ordering|purchase)\b/i, /^order$/i], weight: 9 },
  // Menu / browse
  { name: 'MENU',     patterns: [/\b(menu|list|show|what(('?s| is) (available|on offer|today))?|what do you (have|sell)|options|choices|catalog|price(s|list)?|see food|browse)\b/i], weight: 8 },
  // Table booking
  { name: 'BOOK',     patterns: [/\b(book|reserve|reservation|table|seat|booking|schedule( a table)?|dine\s*in|sit in)\b/i], weight: 8 },
  // Checkout / pay
  { name: 'CHECKOUT', patterns: [/\b(checkout|check out|pay|payment|total|bill|confirm order|place order|finalise|finalize|done ordering|that'?s all|i'?m done|done|ready to (pay|order))\b/i], weight: 9 },
  // View cart
  { name: 'VIEW_CART', patterns: [/\b(cart|basket|my order|what i (have|ordered)|order so far|show (my )?order|current order)\b/i], weight: 7 },
  // Modify cart
  { name: 'REMOVE_ITEM', patterns: [/\b(remove|delete|cancel|drop|take off|don'?t want|remove the|delete the)\b/i], weight: 7 },
  { name: 'CLEAR_CART', patterns: [/\b(clear (cart|order|all|everything)|start over|restart|new order|empty (cart|order))\b/i], weight: 7 },
  { name: 'ADD_MORE',   patterns: [/\b(add (more|another|again)|i also want|also (get|add|include)|plus|additionally)\b/i], weight: 7 },
  // Payment proof
  { name: 'PAYMENT_PROOF', patterns: [/\b(proof|screenshot|receipt|paid|transfer|payment (done|made|sent|complete)|i (have )?paid|here('?s| is) (the )?(proof|receipt|screenshot))\b/i], weight: 9 },
  // Help
  { name: 'HELP',  patterns: [/\b(help|support|assist|question|how (do|does|can)|what can you|issue|problem|stuck)\b/i], weight: 6 },
  // Cancel
  { name: 'CANCEL', patterns: [/^(cancel|nevermind|never mind|forget it|stop|quit|abort|not now)$/i, /b(nevermind|never mind|forget it|abort)b/i], weight: 9 },
  // Yes/Confirm
  { name: 'YES',    patterns: [/^(yes|yeah|yep|yup|sure|ok(ay)?|correct|right|exactly|confirm|affirmative|sounds good|perfect|great|go ahead|proceed|absolutely|definitely|of course|ofc|y)\b/i], weight: 8 },
  // No
  { name: 'NO',     patterns: [/^(no|nope|nah|not really|negative|don'?t|dont)\b/i], weight: 8 },
  // Delivery type
  { name: 'DELIVERY', patterns: [/\b(deliver(y)?|bring (it )?to|send to|delivery (order|please))\b/i], weight: 7 },
  { name: 'PICKUP',   patterns: [/\b(pick(up| up)|collect|i'?ll (pick|come)|coming in|takeaway|take away)\b/i], weight: 7 },
  // Track order
  { name: 'TRACK', patterns: [/\b(track|status|where(('?s| is) my order)?|order status|update|eta|how long)\b/i], weight: 6 },
  // Contact/Human
  { name: 'HUMAN', patterns: [/\b(human|agent|person|manager|staff|real person|speak to (someone|a person|staff)|connect me)\b/i], weight: 8 },
];

// ─── Quantity Extractors ──────────────────────────────────────────────────────

/**
 * Parse quantity from a string. Returns null if no quantity found.
 * Handles: digits, word numbers, phrases, "X plates/meals/portions of..."
 */
function parseQuantity(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();

  // 1. Check compound phrases first (most specific)
  for (const [phrase, num] of Object.entries(PHRASE_NUMBERS)) {
    if (t.includes(phrase)) return num;
  }

  // 2. Digit extraction: "2", "02", "2x", "x2"
  const digitMatch = t.match(/\b(\d{1,3})\b/);
  if (digitMatch) {
    const n = parseInt(digitMatch[1], 10);
    if (n > 0 && n <= 999) return n;
  }

  // 3. "[number] plates/meals/portions/pieces/orders/servings of..."
  const countingNounMatch = t.match(/\b(\w+)\s+(?:plates?|meals?|portions?|pieces?|orders?|servings?|bowls?|cups?|bottles?|packs?|items?|units?)\b/);
  if (countingNounMatch) {
    const wordNum = WORD_NUMBERS[countingNounMatch[1]];
    if (wordNum !== undefined) return wordNum;
  }

  // 4. Single word number
  const words = t.split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^a-z]/g, '');
    if (WORD_NUMBERS[clean] !== undefined) return WORD_NUMBERS[clean];
  }

  return null;
}

// ─── Levenshtein Distance ─────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

/**
 * Similarity score 0–1 between two strings (case-insensitive).
 */
function similarity(a, b) {
  const s1 = a.toLowerCase(), s2 = b.toLowerCase();
  if (s1 === s2) return 1;
  const dist = levenshtein(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

// ─── Menu Item Fuzzy Match ────────────────────────────────────────────────────
/**
 * Find matching menu items from user input.
 * Returns array of { item, score, confidence: 'high'|'medium'|'low' }
 */
function fuzzyMatchMenuItem(query, menuItems) {
  if (!query || !menuItems?.length) return [];
  const q = query.toLowerCase().trim();

  const results = [];

  for (const item of menuItems) {
    const name = item.name.toLowerCase();
    const keywords = (item.keywords || []).map(k => k.toLowerCase());
    const category = (item.category || '').toLowerCase();

    let score = 0;

    // Exact match
    if (name === q || keywords.includes(q)) { score = 1.0; }
    // Contains query
    else if (name.includes(q) || keywords.some(k => k.includes(q))) { score = 0.9; }
    // Query contains item name
    else if (q.includes(name)) { score = 0.85; }
    // Word-level partial
    else {
      const qWords = q.split(/\s+/);
      const nWords = name.split(/\s+/);
      const wordMatches = qWords.filter(w => nWords.some(n => n.includes(w) || w.includes(n) || similarity(w, n) > 0.8));
      if (wordMatches.length > 0) {
        score = 0.7 * (wordMatches.length / Math.max(qWords.length, nWords.length));
      }
      // Keyword similarity (e.g. "yasa" vs keyword "yassa")
      const keySimScore = keywords.reduce((best, k) => Math.max(best, similarity(q, k)), 0);
      if (keySimScore > 0.75) score = Math.max(score, keySimScore * 0.85);
      // Full string similarity
      const sim = similarity(q, name);
      if (sim > score) score = sim * 0.9;
      // Category match bonus
      if (q.includes(category) || category.includes(q)) score = Math.max(score, 0.6);
    }

    if (score >= 0.4) {
      results.push({
        item,
        score,
        confidence: score >= 0.85 ? 'high' : score >= 0.65 ? 'medium' : 'low',
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 4);
}

// ─── Intent Detection ─────────────────────────────────────────────────────────
/**
 * Detect primary intent(s) from a message.
 * Returns { primary, secondary, confidence, raw }
 */
function detectIntent(text) {
  if (!text) return { primary: 'UNKNOWN', confidence: 0, raw: '' };
  const cleaned = text.trim();
  
  const matches = [];
  for (const intent of INTENTS) {
    for (const pattern of intent.patterns) {
      if (pattern.test(cleaned)) {
        matches.push({ name: intent.name, weight: intent.weight });
        break;
      }
    }
  }

  matches.sort((a, b) => b.weight - a.weight);

  return {
    primary: matches[0]?.name ?? 'UNKNOWN',
    secondary: matches[1]?.name ?? null,
    allMatches: matches.map(m => m.name),
    confidence: matches.length > 0 ? Math.min(1, matches[0].weight / 10) : 0,
    raw: cleaned,
  };
}

// ─── Validate Quantity ────────────────────────────────────────────────────────
/**
 * Smart quantity validation:
 * - Returns { valid: true, qty } if acceptable
 * - Returns { valid: false, reason } if suspicious
 */
function validateQuantity(qty, itemName = 'item') {
  if (!qty || qty <= 0) return { valid: false, reason: 'zero_or_negative' };
  if (qty > 100) return { valid: false, reason: 'suspiciously_large', qty };
  if (qty > 20) return { valid: 'warn', reason: 'large_order', qty };
  return { valid: true, qty };
}

module.exports = {
  detectIntent,
  parseQuantity,
  fuzzyMatchMenuItem,
  similarity,
  validateQuantity,
};
