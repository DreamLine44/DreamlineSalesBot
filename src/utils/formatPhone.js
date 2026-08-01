/**
 * formatPhone.js
 * [AUDIT-FIX-ORDER-POLISH-5] A raw digit string ("Customer: 2203532423")
 * reads as a wall of numbers next to the rest of a formatted order message.
 * This wraps it with a phone emoji so it's visually distinct and easy to
 * scan at a glance, without needing full E.164 parsing/formatting (WhatsApp
 * numbers here are already in a consistent stored format — this is a
 * display concern only, not a validation/normalization one).
 */
export function formatPhoneDisplay(phone) {
  if (!phone) return '';
  return `📞 ${phone}`;
}
