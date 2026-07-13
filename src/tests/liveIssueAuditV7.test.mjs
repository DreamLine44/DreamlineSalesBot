// tests/liveIssueAuditV7.test.mjs
//
// Regression tests for bugs root-caused from live screenshots of a stuck
// "Order Food" tap and a failing WA Catalog sync.
//
// [AUDIT-FIX-ORDER-ESCAPE] webhookController.js
//
// Repro from screenshots: customer already mid-ORDER-flow (stuck at
// SELECT_ITEM from an earlier abandoned attempt) taps the top-level "🍔 Order
// Food" list row (id 'ORDER') from the persistent welcome Menu message. The
// global escape block (CANCEL/SHOW_MENU/SUPPORT) had no entry for 'ORDER',
// 'BOOK', or 'WALKIN', so the tap fell straight through to advance(), which
// forwarded the literal id 'ORDER' to the SELECT_ITEM handler as free text —
// it fuzzy-matched against the menu, found nothing, and replied exactly what
// the screenshot showed: `I couldn't find "ORDER" on our menu.` The flow was
// never reset; the customer was stuck until SESSION_TTL_MINUTES expiry.
//
// Fix: 'ORDER'/'BOOK'/'WALKIN' interactive taps are now a global escape,
// routed through their START_ORDER/START_BOOKING/WALKIN actions (the same
// ones the pre-flow welcome buttons already use), which fully reset session
// state via startFlow() before re-running the flow's INIT path.
//
// [AUDIT-FIX-SYNC-DETAIL] waCatalogService.js / businessController.js / BusinessConfig.js
//
// Repro from screenshots: WA Catalog "Sync Now" failed with a bare
// `GRAPH_ERROR (400)` and the dashboard's HTTP response surfaced only a
// generic "Request failed with status code 502" — Meta's actual error
// message (why the batch was rejected) was logged server-side but never
// persisted or returned, forcing a trip into Railway's raw HTTP/deploy logs
// to see anything more specific. Fixed by parsing Meta's JSON error body for
// `error.message` and threading it through recordSyncError → BusinessConfig
// → the sync response and GET /wacatalog/health, with a schema field added
// so Mongoose's strict mode doesn't silently drop it on write (same bug
// class as the Order.status enum fix, [FIX-4]).
//
// Following this codebase's established pattern (see
// v2CancelConfirmedGuardAudit.test.mjs): webhookController.js's per-message
// handler isn't designed for isolated unit import without a live webhook/DB
// context, so the ORDER-escape checks are source-text guards.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('webhookController.js: ORDER/BOOK/WALKIN taps are a global escape from an active flow', () => {
  const src = read('../controllers/webhookController.js');
  const start = src.indexOf('AUDIT-FIX-ORDER-ESCAPE');
  assert.ok(start !== -1, '[AUDIT-FIX-ORDER-ESCAPE] block not found');
  const body = src.slice(start, start + 2500);

  assert.match(
    body,
    /FLOW_START_ACTIONS\s*=\s*\{\s*ORDER:\s*'START_ORDER',\s*BOOK:\s*'START_BOOKING',\s*WALKIN:\s*'WALKIN'\s*\}/,
    'expected a FLOW_START_ACTIONS map covering ORDER, BOOK, and WALKIN'
  );
  assert.match(
    body,
    /if\s*\(\s*isInteractive\s*&&\s*FLOW_START_ACTIONS\[upperMsg\]\s*\)/,
    'expected the escape to be scoped to isInteractive taps only'
  );
});

test('webhookController.js: the ORDER-escape block runs before the final advance() fallthrough', () => {
  const src = read('../controllers/webhookController.js');
  const escapeIdx  = src.indexOf('AUDIT-FIX-ORDER-ESCAPE');
  const advanceIdx = src.indexOf('const reply = await advance({\n      session: freshSession,');
  assert.ok(escapeIdx !== -1, 'escape block not found');
  assert.ok(advanceIdx !== -1, 'final advance() fallthrough not found');
  assert.ok(escapeIdx < advanceIdx, 'ORDER-escape must run before the raw-text advance() fallthrough that produced "I couldn\'t find ORDER on our menu"');
});

test('waCatalogService.js: a Graph API error extracts and returns Meta\'s actual error message as `detail`', () => {
  const src = read('../modules/catalog/waCatalogService.js');
  const start = src.indexOf("if (!resp.ok) {");
  assert.ok(start !== -1, 'Graph error handling block not found');
  const body = src.slice(start, start + 1600);
  assert.match(body, /parsed\?\.error\?\.message/, 'expected the fix to read error.message out of Meta\'s JSON error body');
  assert.match(body, /recordSyncError\(business\._id, `GRAPH_ERROR \(\$\{resp\.status\}\)`, detail\)/, 'expected detail to be passed through to recordSyncError');
  assert.match(body, /return \{ ok: false, reason: 'GRAPH_ERROR', status: resp\.status, detail \};/, 'expected detail on the returned failure object');
});

test('waCatalogService.js: recordSyncError accepts and persists a detail field', () => {
  const src = read('../modules/catalog/waCatalogService.js');
  const start = src.indexOf('async function recordSyncError(');
  assert.ok(start !== -1, 'recordSyncError not found');
  const body = src.slice(start, start + 500);

  assert.match(body, /recordSyncError\(businessId, reason, detail = null\)/, 'expected recordSyncError to accept a detail parameter');
  assert.match(body, /lastSyncError':\s*\{\s*reason,\s*detail,\s*at:\s*new Date\(\)\s*\}/, 'expected detail to be written to waCatalog.lastSyncError');
});

test('models/BusinessConfig.js: lastSyncError schema declares `detail` (Mongoose strict mode would otherwise silently drop it)', () => {
  const src = read('../models/BusinessConfig.js');
  const start = src.indexOf('lastSyncError: {');
  assert.ok(start !== -1, 'lastSyncError schema not found');
  const body = src.slice(start, start + 700);

  assert.match(body, /detail:\s*\{\s*type:\s*String,\s*default:\s*null\s*\}/, 'expected a declared `detail` field on the lastSyncError sub-schema');
});

test('businessController.js: syncWaCatalog forwards `detail` in the failure response', () => {
  const src = read('../controllers/businessController.js');
  const start = src.indexOf('export async function syncWaCatalog');
  assert.ok(start !== -1, 'syncWaCatalog not found');
  const body = src.slice(start, start + 1800);

  assert.match(body, /detail:\s*result\.detail\s*\|\|\s*null/, 'expected the sync failure response to include detail from the service-layer result');
});
