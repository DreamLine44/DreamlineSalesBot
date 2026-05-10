// [FIX-E] helpers.js is not imported anywhere in the codebase and has no effect.
// The re-export below is kept for backward-compat in case an external script imports it,
// but all internal code should import normalizeText directly from ./phraseEngine.js.
// Do NOT add new utilities here — use a descriptively-named file instead.
export { normalizeText } from "./phraseEngine.js";
