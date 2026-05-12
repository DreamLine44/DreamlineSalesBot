// ================= NORMALIZATION =================
export const normalizeText = (text = "") => {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ");
};


// ================= STOP WORDS =================
const stopWords = [
  "i","want","would","like","to","get","me","please",
  "can","you","give","need","some","a","an","the",
  "for","and","of"
];


// ================= SYNONYMS =================
const synonyms = {
  food: ["meal","dish","snack","something"],
  burger: ["hamburger","beefburger","beef burger"],
  pizza: ["cheesepizza","cheese pizza","pepperoni"],
  booking: ["reserve","reservation","appointment","book"]
};


// ================= REVERSE MAP =================
const synonymMap = {};
Object.keys(synonyms).forEach(key => {
  synonyms[key].forEach(word => {
    synonymMap[word] = key;
  });
});


// ================= CLEAN WORD =================
const cleanWord = (word) => {
  return word.replace(/(.)\1+/g, "$1"); // piiizza → pizza
};


// ================= TOKEN CLEAN =================
const cleanTokens = (text) => {
  return text
    .split(" ")
    .map(cleanWord)
    .filter(Boolean);
};


// ================= APPLY SYNONYMS =================
const applySynonyms = (tokens) => {
  return tokens.map(word => synonymMap[word] || word);
};


// ================= REMOVE NOISE =================
const removeNoise = (tokens) => {
  return tokens.filter(word => !stopWords.includes(word));
};


// ================= EXTRACT MEANING =================
export const extractMeaning = (text) => {

  const patterns = [
    /(?:i\s*(?:want|would like|need|feel like)\s*)(.+)/,
    /(?:can\s*i\s*(?:get|have)\s*)(.+)/,
    /(?:please\s*)(.+)/,
    /(?:order\s*)(.+)/,
    /(.+)/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return text;
};


// ================= NUMBER DETECTION =================
// Word-number lookup for detectNumber (single words only — keeps phraseEngine lightweight)
const _PHRASE_ENGINE_WORD_NUMS = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15,
  sixteen:16, seventeen:17, eighteen:18, nineteen:19,
  twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90,
  hundred:100, thousand:1000,
  // common typos
  wan:1, wun:1, tow:2, tu:2, too:2, fore:4, fiv:5, fife:5, sik:6, sevn:7, eght:8, nein:9,
  tweny:20, thirthy:30, fourty:40, fifthy:50, sixy:60, sevnty:70, eighthy:80,
  ninty:90, ninity:90, niety:90,
  a:1, an:1,
};

const detectNumber = (msg) => {
  // 1. Plain digit
  const num = parseInt(msg);
  if (!isNaN(num) && String(parseInt(msg)) === msg.trim()) return num;
  // 2. Single word-number
  const wordNum = _PHRASE_ENGINE_WORD_NUMS[String(msg).trim().toLowerCase()];
  if (wordNum !== undefined) return wordNum;
  // 3. Digit embedded in short message
  const m = String(msg).match(/\b(\d+)\b/);
  if (m) return parseInt(m[1], 10);
  return null;
};


// ================= TOKEN RANKING (IMPROVED) =================
const rankTokens = (tokens) => {
  return tokens
    .map(word => {

      let score = 1;

      // 🔥 length importance
      if (word.length >= 4) score += 1;
      if (word.length >= 6) score += 2;

      // 🔥 known keyword boost
      if (synonyms[word] || synonymMap[word]) score += 3;

      return { word, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(w => w.word);
};


// ================= INTENT HINT =================
const detectHint = (tokens) => {

  if (tokens.some(t =>
    ["food","burger","pizza"].includes(t)
  )) return "ORDER";

  if (tokens.some(t =>
    ["booking","reserve","appointment"].includes(t)
  )) return "BOOKING";

  return null;
};


// ================= CONFIDENCE SCORE =================
const computeConfidence = (tokens) => {
  if (!tokens.length) return 0;

  const main = tokens[0];

  if (main.length >= 5) return 0.8;
  if (main.length >= 3) return 0.6;

  return 0.3;
};


// ================= MAIN PROCESS =================
export const processMessage = (msg) => {

  // 🔥 1. NUMBER INPUT (HIGHEST PRIORITY)
  const number = detectNumber(msg);

  if (number !== null) {
    return {
      original: msg,
      cleaned: msg,
      tokens: [],
      primary: null,
      number,
      hint: null,
      confidence: 1
    };
  }

  // 🔥 2. NORMAL TEXT FLOW
  let text = normalizeText(msg);

  text = extractMeaning(text);

  let tokens = cleanTokens(text);

  tokens = applySynonyms(tokens);

  tokens = removeNoise(tokens);

  const ranked = rankTokens(tokens);

  const hint = detectHint(ranked);

  const confidence = computeConfidence(ranked);

  return {
    original: msg,
    cleaned: text,
    tokens: ranked,
    primary: ranked[0] || null,
    number: null,
    hint,
    confidence
  };
};