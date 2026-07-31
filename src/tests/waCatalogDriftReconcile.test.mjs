// tests/waCatalogDriftReconcile.test.mjs
//
// [FIX-CATALOG-DRIFT-RECONCILE] Behavioral regression test.
//
// Reproduces the exact production symptom this fix closes: a tenant whose
// menu has 25 items, all previously marked CONFIRMED in
// waCatalog.syncedRetailerIds/syncedItemHashes (e.g. by a version of this
// code that predated [FIX-CATALOG-OPTIMISTIC-CONFIRM], or by any other
// drift), but Meta's live catalog actually only contains 10 of them. Because
// none of the 25 items' own data changed since that confirmation, the
// ordinary delta-hash diff in syncMenuToCatalog() sees zero changed items and
// — before this fix — would return early without ever re-examining the 15
// missing items, leaving GET /wacatalog/health reporting itemsReady: 25
// forever while Meta's catalog stayed stuck at 10.
//
// Unlike the rest of this file (source-text checks — see the header note in
// waCatalogCrudSync.test.mjs), this test actually calls syncMenuToCatalog()
// with global.fetch mocked to stand in for Meta's Graph API, so it exercises
// real behavior rather than asserting on source text.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SIMULATION_MODE = 'false';
process.env.ENCRYPTION_KEY  = process.env.ENCRYPTION_KEY || '';

function makeMenu(n) {
  return Array.from({ length: n }, (_, i) => ({
    _id: `item${i + 1}`,
    name: `Item ${i + 1}`,
    price: 10 + i,
    currency: 'GMD',
    available: true,
    image: { url: `https://example.com/${i + 1}.jpg` },
  }));
}

test('syncMenuToCatalog re-uploads confirmed-but-actually-missing items on the next sync [FIX-CATALOG-DRIFT-RECONCILE]', async () => {
  const menu = makeMenu(25);
  const allIds = menu.map(i => i._id);
  const liveIdsBeforeFix = new Set(allIds.slice(0, 10)); // Meta only actually has 10

  // Precompute the same hash the service would compute, so changedItems is
  // empty going in — the exact state that let the 15 missing items hide
  // from the ordinary delta-hash diff.
  const { createHash } = await import('crypto');
  function hashItemData(data) {
    return createHash('sha1').update(JSON.stringify(data)).digest('hex');
  }
  const botPhoneDigits = '2207236103';
  const syncedItemHashes = {};
  for (const item of menu) {
    const data = {
      title: item.name,
      price: `${item.price.toFixed(2)} ${item.currency}`,
      availability: 'in stock',
      condition: 'new',
      image_link: item.image.url,
      link: `https://wa.me/${botPhoneDigits}`,
    };
    syncedItemHashes[item._id] = hashItemData(data);
  }

  const business = {
    _id: 'biz1',
    tenantId: 'tenant1',
    menuItems: menu,
    payment: { currency: 'GMD' },
    waCatalog: {
      catalogId: 'CATALOG123',
      syncedRetailerIds: allIds,      // ALL 25 wrongly marked confirmed
      syncedItemHashes,                // hashes match current data — nothing "changed"
      pendingBatchHandles: [],
      lastReconciledAt: null,          // never reconciled — due immediately
    },
  };
  const tenant = { whatsapp: { accessToken: 'plaintext-token', phone: botPhoneDigits, apiVersion: 'v21.0' } };

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push(u);

    if (u.includes('/products?fields=retailer_id')) {
      // Live-catalog reconciliation check — first call (only 10 present).
      // A second call happens later for post-upload re-verification, at
      // which point the "upload" below has made all 25 live.
      const nowLive = calls.filter(c => c.includes('/products?fields=retailer_id')).length === 1
        ? liveIdsBeforeFix
        : new Set(allIds);
      return {
        ok: true,
        json: async () => ({ data: [...nowLive].map(id => ({ retailer_id: id })), paging: null }),
      };
    }
    if (u.includes('/items_batch')) {
      return { ok: true, json: async () => ({ handles: ['handle-drift-1'] }) };
    }
    if (u.includes('check_batch_request_status')) {
      return { ok: true, json: async () => ({ data: [{ status: 'finished', errors_total_count: 0, errors: [] }] }) };
    }
    return { ok: false, status: 404, text: async () => 'unexpected call' };
  };

  try {
    const { syncMenuToCatalog } = await import('../modules/catalog/waCatalogService.js');
    const result = await syncMenuToCatalog(business, tenant);

    assert.equal(result.ok, true, 'sync should succeed once the drift is resolved');
    assert.equal(result.synced, 15, 'exactly the 15 missing-from-Meta items should be re-uploaded, not all 25');

    const batchCall = calls.find(c => c.includes('/items_batch'));
    assert.ok(batchCall, 'expected an items_batch call to actually re-upload the missing items');
  } finally {
    global.fetch = realFetch;
  }
});
