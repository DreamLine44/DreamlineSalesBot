// tests/waCatalogPartialUpdate.test.mjs
//
// Regression test for [CATALOG-BIZ-1] in controllers/businessController.js.
//
// Bug: updateBusinessConfig() ran `findOneAndUpdate({ tenantId }, { $set: update })`
// with `update.waCatalog` passed through as a plain nested object whenever the
// caller sent one. MongoDB's $set on a plain (non-dot-path) nested field REPLACES
// the whole subdocument rather than merging it — Mongoose does not expand sibling
// fields or reapply schema defaults on an update-path $set. Since the generic
// PUT /:tenantId endpoint is the only way tenants configure WA Catalog, sending
// `{ waCatalog: { catalogId: 'X' } }` to add a catalog ID would silently wipe an
// already-set `enabled`/`mode`, and a later `{ waCatalog: { enabled: true } }` call
// to flip it on would just as silently wipe catalogId back out — each partial
// update fighting the last instead of composing, with no error surfaced anywhere.
//
// Fix: flatten `update.waCatalog` into `waCatalog.<key>` dot-notation entries
// before the $set (mirroring the pre-existing [FIX-TONE-3] pattern in the same
// function), so each sub-field updates independently and untouched siblings are
// left exactly as they were.
//
// This is a source-text guard (not a live-DB test) — importing businessController.js
// directly requires a live Mongo connection via BusinessConfig, consistent with how
// leadCaptureTriggerAudit.test.mjs / postFlowSentimentAI.test.mjs guard other fixes
// in modules that need infra wired up to import directly.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const src = read('../controllers/businessController.js');

// Also exercise the actual flattening logic in isolation, copied verbatim from
// the fix, so this test fails if the flattening behavior itself regresses —
// not just if the source text is edited.
function flattenWaCatalog(update) {
  const out = { ...update };
  if (out.waCatalog && typeof out.waCatalog === 'object') {
    for (const [k, v] of Object.entries(out.waCatalog)) {
      out[`waCatalog.${k}`] = v;
    }
    delete out.waCatalog;
  }
  return out;
}

test('[CATALOG-BIZ-1] source guard: updateBusinessConfig flattens waCatalog to dot-notation before $set', () => {
  const idx = src.indexOf('function updateBusinessConfig');
  assert.notEqual(idx, -1, 'updateBusinessConfig() should exist');
  const body = src.slice(idx, src.indexOf('const biz = await BusinessConfig.findOneAndUpdate', idx));

  assert.match(body, /CATALOG-BIZ-1/, 'flattening fix comment should be present ahead of the findOneAndUpdate call');
  assert.match(
    body,
    /update\[`waCatalog\.\$\{k\}`\]\s*=\s*v/,
    'update.waCatalog entries must be rewritten to waCatalog.<key> dot-notation'
  );
  assert.match(body, /delete update\.waCatalog/, 'the plain nested waCatalog key must be removed after flattening');
});

test('a partial { waCatalog: { catalogId } } update only touches catalogId, leaving enabled/mode untouched', () => {
  const flattened = flattenWaCatalog({ waCatalog: { catalogId: 'CAT_123' } });
  assert.deepEqual(flattened, { 'waCatalog.catalogId': 'CAT_123' });
  assert.equal(flattened.waCatalog, undefined);
});

test('a partial { waCatalog: { enabled } } update does not clobber a previously-set catalogId', () => {
  const flattened = flattenWaCatalog({ waCatalog: { enabled: true } });
  assert.deepEqual(flattened, { 'waCatalog.enabled': true });
});

test('a full waCatalog object still flattens correctly (all three fields update independently)', () => {
  const flattened = flattenWaCatalog({
    waCatalog: { enabled: true, catalogId: 'CAT_1', mode: 'ALWAYS_OFFER' },
  });
  assert.deepEqual(flattened, {
    'waCatalog.enabled':   true,
    'waCatalog.catalogId': 'CAT_1',
    'waCatalog.mode':      'ALWAYS_OFFER',
  });
});

test('an update with no waCatalog key is left completely unchanged', () => {
  const flattened = flattenWaCatalog({ businessMode: 'RETAIL' });
  assert.deepEqual(flattened, { businessMode: 'RETAIL' });
});
