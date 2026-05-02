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
const detectNumber = (msg) => {
  const num = parseInt(msg);
  return isNaN(num) ? null : num;
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