// ✅ FIX: helpers.js previously exported its own normalizeText which was a
// simpler duplicate of the same export from phraseEngine.js. Having two
// different versions of the same function caused silent inconsistencies
// depending on which one was imported.
// Re-export from phraseEngine so the whole codebase uses one canonical version.
export { normalizeText } from "./phraseEngine.js";
