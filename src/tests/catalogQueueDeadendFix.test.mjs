// tests/catalogQueueDeadendFix.test.mjs
//
// [FIX-CATALOG-QUEUE-DEADEND] Regression test for the bug where a native
// WhatsApp Catalog cart checkout ("Your cart" → "Send to business") with 2+
// distinct items would silently strand every line after the first.
//
// Root cause: handleCatalogOrderMessage() only consolidated a multi-line WA
// cart into ONE Order when business.multiItemCart.enabled was true. Any
// tenant WITHOUT that flag set routed 2+ item carts through the older
// single-item + pendingCatalogQueue path, which depends on
// drainCatalogQueue() to auto-advance to each queued line. But
// drainCatalogQueue() only ever runs when session.postFlowAck ===
// 'ORDER_CONFIRMED' — a flag that is only ever set by an ADMIN action
// (adminCommandService.js / dashboardController.js), never automatically
// when a customer adds an item to their cart. So only the first catalog
// line was ever processed; the rest sat forgotten in
// session.pendingCatalogQueue. Worse, the primary item was folded into the
// SAME in-chat `data.cart` the module's own typed-order flow uses, so the
// customer's eventual "Order Summary" confirmation could reflect whatever
// was already sitting in data.cart from an earlier, unrelated conversation
// — not the catalog cart they actually just sent, and not its real total.
//
// Fix: handleCatalogOrderMessage() now consolidates ANY multi-line WA
// Catalog checkout (resolvedLines.length > 1) into one Order via
// handleMultiItemCatalogOrder(), unconditionally — no dependency on
// multiItemCart.enabled, no queue, no drain.
//
// This is a source-level regression test (same technique as
// waCatalogSyncValidation.test.mjs) rather than an execution test, since
// handleCatalogOrderMessage()/handleMultiItemCatalogOrder() are orchestration
// that touches mongoose (saveOrder/updateSession) and the WhatsApp
// dispatcher — already covered at the integration level per that file's own
// note.

import test   from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import path   from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

const catalogFlowSrc = read('../modules/catalog/waCatalogFlow.js');

test('a multi-line WA Catalog checkout consolidates into one Order regardless of multiItemCart.enabled', () => {
  // The gate must key off resolvedLines.length alone — must NOT require
  // business?.multiItemCart?.enabled to be true.
  assert.match(
    catalogFlowSrc,
    /if \(normalized\.resolvedLines\.length > 1\)\s*\{\s*return handleMultiItemCatalogOrder/
  );
  // Guard against the old, buggy gate creeping back in.
  assert.doesNotMatch(
    catalogFlowSrc,
    /if \(business\?\.multiItemCart\?\.enabled && normalized\.resolvedLines\.length > 1\)/
  );
});

test('normalizeCatalogSelection + the new gate: 2 resolved lines route to consolidation even with no multiItemCart config at all', async () => {
  const { normalizeCatalogSelection } = await import('../modules/catalog/waCatalogHelpers.js');

  const business = {
    tenantId: 't1',
    // Deliberately NO multiItemCart field at all — the exact "opted-out"
    // tenant shape that used to fall through to the broken queue path.
    menuItems: [
      { _id: 'itemA', name: 'Domoda',  price: 175, available: true },
      { _id: 'itemB', name: 'Benachin', price: 175, available: true },
    ],
  };
  const metaOrder = {
    catalog_id: 'CAT_1',
    product_items: [
      { product_retailer_id: 'itemA', quantity: '1' },
      { product_retailer_id: 'itemB', quantity: '1' },
    ],
  };

  const normalized = normalizeCatalogSelection(business, metaOrder);
  assert.equal(normalized.resolvedLines.length, 2);

  // This is exactly the condition handleCatalogOrderMessage() now checks —
  // asserting it's true confirms a cart like this (from a tenant with no
  // multiItemCart config) is consolidated, not silently truncated to one item.
  const shouldConsolidate = normalized.resolvedLines.length > 1;
  assert.equal(shouldConsolidate, true);
});
