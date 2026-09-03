// tests/buttonTitleWiringAudit.test.mjs
//
// Regression tests for two wiring bugs found in a systematic audit of every
// hardcoded `title:` literal against Meta's real WhatsApp Cloud API limits
// (quick-reply button titles: 20 chars; list row/section titles: 24 chars —
// see core/whatsapp/dispatcher.js's `.slice(0, 20)` / `.slice(0, 24)` guards).
//
// Bug 1 — silent truncation: several titles exceeded their type's real limit
// and were being silently cut by the dispatcher before ever reaching Meta —
// invisible in code review because nothing throws or logs, the customer just
// sees clipped text ("✅ Collected — Thanks!" -> "✅ Collected — Thanks",
// "Collection / Delivery Window" -> "Collection / Delivery W", mid-word).
//
// Bug 2 — label/action mismatch (worse than truncation): two call sites built
// a button whose `id` falls back to 'SUPPORT' (human-escalation) when a
// shortId is unavailable, but kept the "✅ Collected — Thanks!" title on that
// fallback. A customer tapping what looks like an order-collection
// confirmation would silently open a support ticket instead — the title
// promised one action while the id wired to a completely different one.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// Mirrors dispatcher.js's real per-type limits.
const BUTTON_LIMIT = 20; // interactive 'button' reply title
const LIST_LIMIT    = 24; // interactive 'list' row/section title

const filesWithButtonTitles = [
  '../controllers/dashboardController.js',
  '../services/admin/adminCommandService.js',
  '../routes/adminRoutes.js',
  '../services/shared/postFlowHandler.js',
  '../services/order/activeOrderResolver.js',
  '../modules/cosmetics/flows/orderFlow.js',
];

test('no button title exceeds Meta\'s 20-character reply-button limit (would be silently truncated)', () => {
  const overLimit = [];
  const buttonsBlockRe = /type:\s*'buttons'/g;
  for (const rel of filesWithButtonTitles) {
    const src = read(rel);
    for (const marker of src.matchAll(buttonsBlockRe)) {
      const window = src.slice(marker.index, marker.index + 700);
      for (const m of window.matchAll(/title:\s*'([^']*)'/g)) {
        const title = m[1];
        if (title.includes('{') || title.includes('$')) continue; // dynamic/templated, skip
        if (title.length > BUTTON_LIMIT) {
          overLimit.push(`${rel}: "${title}" (${title.length} chars)`);
        }
      }
    }
  }
  assert.deepEqual(overLimit, [],
    `Found button titles that exceed the 20-char limit and would be silently ` +
    `truncated by dispatcher.js before reaching the customer:\n` + overLimit.join('\n'));
});

test('adminCommandService declineBooking "try another date" button fits the 20-char button-title limit', () => {
  const src = read('../services/admin/adminCommandService.js');
  assert.match(src, /title:\s*'📅 Pick Another Date'/,
    'should use the shortened form that fits Meta\'s 20-char button-title limit');
  assert.doesNotMatch(src, /title:\s*'📅 Try Different Date'/,
    'the old title is 21 chars once measured correctly (📅 is a non-BMP emoji — a ' +
    'surrogate pair, so it counts as 2 in JS .length even though naive/Python-style ' +
    'codepoint counting sees 1) and would be silently truncated to "📅 Try Different Dat"');
});

test('bakery pickup-time list section title fits the 24-char list-title limit', () => {
  const src = read('../modules/bakery/flows/orderFlow.js');
  assert.match(src, /title:\s*'Pickup \/ Delivery Time'/,
    'section title should be the shortened form that fits Meta\'s 24-char list-title limit');
  assert.doesNotMatch(src, /title:\s*'Collection \/ Delivery Window'/,
    'the old 28-char section title (silently truncated to "Collection / Delivery W", ' +
    'cut off mid-word) should be gone');
});

test('cosmetics "no special requests" button fits the 20-char button-title limit', () => {
  const src = read('../modules/cosmetics/flows/orderFlow.js');
  const matches = [...src.matchAll(/id:\s*'GIFT_NONE',\s*title:\s*'([^']*)'/g)];
  assert.ok(matches.length >= 2, 'expected at least 2 GIFT_NONE buttons in the cosmetics order flow');
  for (const m of matches) {
    assert.ok(m[1].length <= BUTTON_LIMIT,
      `GIFT_NONE title "${m[1]}" (${m[1].length} chars) exceeds the 20-char button limit`);
  }
});

// [FIX-BTN-LABEL-MISMATCH] postFlowHandler.js's ORDER_READY ack branch: when
// flowData.shortId is missing, the id must fall back to SUPPORT *and* the
// title must say so — not keep claiming "Collected — Thanks!".
test('postFlowHandler ORDER_READY ack: SUPPORT fallback button is labeled as help, not as a collection confirmation', () => {
  const src = read('../services/shared/postFlowHandler.js');
  const idx = src.indexOf('const collectedBtnId = flowData.shortId');
  assert.ok(idx !== -1, 'collectedBtnId branch not found in postFlowHandler.js');
  const block = src.slice(idx, idx + 1000);

  assert.match(block, /id:\s*'SUPPORT',\s*title:\s*'❓ Need Help'/,
    'the SUPPORT-id fallback button must be labeled "Need Help", not "Collected — Thanks!" — ' +
    'a customer should never see a collection-confirmation label on a button that actually ' +
    'routes to human support');
  assert.doesNotMatch(block, /id:\s*'SUPPORT',\s*title:\s*'✅ Collected/,
    'the old mismatched label (SUPPORT id + "Collected — Thanks!" title) should be gone');
});

// [FIX-BTN-LABEL-MISMATCH] activeOrderResolver.js's 'ready' status card has the
// same class of fallback (id defaults to SUPPORT when shortId is missing).
test('activeOrderResolver ready-status card: SUPPORT fallback button is labeled as help, not as a collection confirmation', () => {
  const src = read('../services/order/activeOrderResolver.js');
  const idx = src.indexOf("if (status === 'ready')");
  assert.ok(idx !== -1, "status === 'ready' branch not found in activeOrderResolver.js");
  const block = src.slice(idx, idx + 1500);

  assert.match(block, /id:\s*'SUPPORT',\s*title:\s*'❓ Need Help'/,
    'the SUPPORT-id fallback button must be labeled "Need Help", not "Collected — Thanks" — ' +
    'otherwise a missing shortId silently turns a collection-confirmation tap into a support ' +
    'escalation with no indication to the customer that anything different happened');
});
