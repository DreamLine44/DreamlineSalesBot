/**
 * parsePartySize.js — natural guest-count extraction for restaurant booking.
 * Builds on parseQuantity; callers enforce max party size and business rules.
 */

import { parseQuantity } from './parseQuantity.js';

const CORRECTION_PREFIX_RE = /^(?:actually|make it|change(?: it)? to|i meant|instead|no,?)\s+/i;

function stripCorrectionPrefix(input) {
  let s = String(input || '').trim();
  while (CORRECTION_PREFIX_RE.test(s)) {
    s = s.replace(CORRECTION_PREFIX_RE, '').trim();
  }
  return s;
}

/**
 * parsePartySizeFromText — positive integer guest count or null.
 * Handles digits, words, relational phrases, and mid-flow corrections.
 */
export function parsePartySizeFromText(input) {
  const s = stripCorrectionPrefix(input);
  if (!s) return null;

  const lower = s.toLowerCase();

  if (/^(just me|only me|me alone|it's just me|it is just me)$/i.test(lower)) return 1;

  if (/\bme and my (wife|husband|partner|spouse)\b/i.test(lower)) return 2;
  if (/\bme and (?:a |one )?friend\b/i.test(lower)) return 2;
  if (/\bme and one\b/i.test(lower)) return 2;

  const meAndFriends = lower.match(/\bme and (\d+|one|two|three|four|five|six|seven|eight|nine|ten|\w+)\s+friends?\b/);
  if (meAndFriends) {
    const n = parseQuantity(meAndFriends[1]);
    if (n) return 1 + n;
  }

  const tableFor = lower.match(/\b(?:table|party|reserve(?:d)?)\s+(?:for|of)\s+(\d+|\w+)\b/);
  if (tableFor) {
    const n = parseQuantity(tableFor[1]);
    if (n) return n;
  }

  const groupOf = lower.match(/\b(?:group|party|table)\s+of\s+(\d+|\w+)\b/);
  if (groupOf) {
    const n = parseQuantity(groupOf[1]);
    if (n) return n;
  }

  const weAre = lower.match(/\b(?:we(?:'re| are| will be|'ll be)|there (?:are|will be)|it(?:'s| is))\s+(?:about\s+|around\s+|approximately\s+)?(\d+|\w+)\b/);
  if (weAre) {
    const n = parseQuantity(weAre[1]);
    if (n) return n;
  }

  const ofUs = lower.match(/\b(\d+|\w+)\s+of\s+us\b/);
  if (ofUs) {
    const n = parseQuantity(ofUs[1]);
    if (n) return n;
  }

  const guestsPhrase = lower.match(/\b(\d+|\w+)\s*(?:people|guests|persons|pax|diners)\b/);
  if (guestsPhrase) {
    const n = parseQuantity(guestsPhrase[1]);
    if (n) return n;
  }

  const forN = lower.match(/\bfor\s+(\d+|\w+)\b/);
  if (forN) {
    const n = parseQuantity(forN[1]);
    if (n) return n;
  }

  const approx = lower.match(/\b(?:about|around|approximately)\s+(\d+|\w+)\b/);
  if (approx) {
    const n = parseQuantity(approx[1]);
    if (n) return n;
  }

  // Bare quantity — avoid treating clock times ("7pm", "at 8") as guest counts.
  const timeish = /\b(?:at|around|about)\s*\d|\d\s*(?:am|pm)\b|(?:noon|midnight)\b/i.test(lower);
  const guestish = /\b(?:guest|people|person|pax|table|party|group|diners|dining|covers)\b|\bof us\b/i.test(lower);
  if (!timeish || guestish) {
    const q = parseQuantity(s);
    if (q) return q;
  }

  return null;
}
