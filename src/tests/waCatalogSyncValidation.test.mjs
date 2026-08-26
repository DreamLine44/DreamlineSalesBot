// tests/waCatalogSyncValidation.test.mjs
//
// Regression tests for two v1-merge audit fixes:
//
//   [CATALOG-SYNC-VALIDATE-1] modules/catalog/waCatalogHelpers.js
//     isSyncableForCatalog() — a menu item missing an image or with an
//     invalid/zero price must never be pushed to Meta's Commerce Catalog,
//     since that renders as a broken listing (no photo, "$0.00"/no price)
//     directly in front of customers. syncMenuToCatalog() (waCatalogService.js)
//     filters the menu through this check before building sync entries, and
//     the existing DELETE-diff machinery automatically removes a
//     previously-synced item that has since regressed into invalid.
//
//   [FIX-CATALOG-CART-2] models/Order.js
//     Order.items[].menuItemId was produced by every cart-line builder
//     (waCatalogHelpers.buildCatalogCartItems(), and the CATALOG-STOCK-1
//     menuItemId every per-vertical orderFlow.js passes) but was missing
//     from the items[] subdocument schema — Mongoose strict mode silently
//     dropped it on every save. Same recurring "field missing from schema"
//     bug class as variants/customerName/notes/addOns/staff earlier in this
//     codebase's history.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(__dirname, rel), 'utf8');

const { isSyncableForCatalog } = await import('../modules/catalog/waCatalogHelpers.js');

// ── isSyncableForCatalog ─────────────────────────────────────────────────

test('isSyncableForCatalog is ok for an item with a positive price and an image', () => {
  const result = isSyncableForCatalog({ name: 'Widget', price: 10, image: { url: 'https://x/y.jpg' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
});

test('isSyncableForCatalog flags a missing image', () => {
  const result = isSyncableForCatalog({ name: 'Widget', price: 10, image: null });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('missing_image'));
});

test('isSyncableForCatalog flags a zero price', () => {
  const result = isSyncableForCatalog({ name: 'Widget', price: 0, image: { url: 'https://x/y.jpg' } });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('invalid_or_zero_price'));
});

test('isSyncableForCatalog flags a negative or non-numeric price', () => {
  assert.equal(isSyncableForCatalog({ price: -5, image: { url: 'u' } }).ok, false);
  assert.equal(isSyncableForCatalog({ price: 'free', image: { url: 'u' } }).ok, false);
  assert.equal(isSyncableForCatalog({ price: undefined, image: { url: 'u' } }).ok, false);
});

test('isSyncableForCatalog can report both reasons at once', () => {
  const result = isSyncableForCatalog({ name: 'Broken', price: 0, image: null });
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 2);
});

// ── syncMenuToCatalog wiring (source-level, matching this codebase's own
//    convention for asserting call-site wiring without a live DB — see
//    waCatalogCrudSync.test.mjs) ───────────────────────────────────────────

const svcSrc = read('../modules/catalog/waCatalogService.js');

test('syncMenuToCatalog filters the menu through isSyncableForCatalog before building sync entries', () => {
  assert.match(svcSrc, /import \{ buildRetailerId, buildCategorizedSections, isSyncableForCatalog \} from '\.\/waCatalogHelpers\.js'/);
  assert.match(svcSrc, /const syncableMenu = menu\.filter\(item => \{/);
  assert.match(svcSrc, /const allCurrentItems = syncableMenu\.flatMap\(item => \{/);
});

test('syncMenuToCatalog logs (not throws) when skipping invalid items', () => {
  assert.match(svcSrc, /logger\.warn\('\[WACatalog\] syncMenuToCatalog skipping items that would render broken in Meta catalog'/);
});

test('syncMenuToCatalog surfaces invalidSkipped count in its result', () => {
  assert.match(svcSrc, /invalidSkipped: invalidSkipped\.length/);
});

// ── Order.items[].menuItemId schema fix ─────────────────────────────────

const orderModelSrc = read('../models/Order.js');

test('Order.items[] subdocument schema declares menuItemId (previously silently dropped by strict mode)', () => {
  assert.match(orderModelSrc, /menuItemId:\s*\{\s*type:\s*mongoose\.Schema\.Types\.ObjectId,\s*default:\s*null\s*\}/);
});

// ── [FIX-CATALOG-CART-CONFIRM] consolidated catalog cart routes through the
//    module's own CONFIRM step instead of auto-saving ─────────────────────
//
// handleMultiItemCatalogOrder() no longer calls saveOrder()/parks at
// AWAIT_ADMIN_CONFIRM/sends an APPROVE_/REJECT_ card itself — that duplicated
// (and drifted from) logic that already exists, correctly, in every
// per-vertical orderFlow.js's own CONFIRM case. Payment/cash parity
// (AWAIT_ADMIN_CONFIRM + APPROVE_/REJECT_ card) is already covered by each
// module's own tests (e.g. restaurant/flows/orderFlow.js's [FIX-3]/
// [FIX-AWAIT] tests) since a WA Catalog cart now reaches that exact same
// CONFIRM case. What this file now needs to guard is that the hand-off
// itself is correct: merge the resolved catalog lines into session.data.cart
// and land on step 'CONFIRM' so that shared machinery runs.

const catalogFlowSrc = read('../modules/catalog/waCatalogFlow.js');

test('handleMultiItemCatalogOrder merges resolved catalog lines into session.data.cart via mergeCartLines (dedupes repeated items) instead of building an Order directly', () => {
  assert.match(catalogFlowSrc, /mergeCartLines, enforceCartLimit \} = await import\('\.\.\/\.\.\/core\/shared\/cartEngine\.js'\)/);
  assert.match(catalogFlowSrc, /const merged = mergeCartLines\(priorCart, newLines\)/);
  assert.match(catalogFlowSrc, /const priorCart = Array\.isArray\(session\?\.data\?\.cart\)/);
});

test('handleMultiItemCatalogOrder sets step to CONFIRM and delegates to flowEngine.advance() rather than calling saveOrder itself', () => {
  assert.match(catalogFlowSrc, /step:\s*'CONFIRM'/);
  assert.match(catalogFlowSrc, /data:\s*\{\s*cart:\s*cappedCart,\s*orderViaCatalog:\s*true\s*\}/);
  assert.match(catalogFlowSrc, /const reply = await advance\(\{ session: freshSession, message: '', business, tenant, isInteractive: false \}\)/);
  // Must NOT re-implement saveOrder/admin-alert logic in this function anymore.
  assert.doesNotMatch(catalogFlowSrc, /step:\s*usePayment \? 'PAYMENT_PROOF' : 'AWAIT_ADMIN_CONFIRM'/);
});
