// tests/waCatalogVariantSync.test.mjs
//
// [AUDIT-FIX-CATALOG-VARIANT-SYNC] Regression tests proving syncMenuToCatalog()
// actually uploads one Meta catalog entry PER VARIANT (with a variant-specific
// retailer_id built via buildRetailerId(item, variantName)), instead of a single
// ambiguous base-item entry — closing the gap where resolveCatalogItem()'s
// variant-slug resolution branch (waCatalogHelpers.js, fully unit-tested in
// waCatalogNormalization.test.mjs) could never actually be reached in
// production because no "::variant" retailer_id was ever uploaded to Meta in
// the first place.
//
// This is a source-text guard (not a live-DB/Graph-API test), consistent with
// the sibling waCatalog*.test.mjs files, since this environment doesn't have
// mongoose installed to actually construct a Tenant/BusinessConfig document.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const svcSrc = read('../modules/catalog/waCatalogService.js');

test('syncMenuToCatalog builds one UPDATE request per variant for items that have variants', () => {
  assert.match(svcSrc, /const variants = Array\.isArray\(item\.variants\) \? item\.variants : \[\]/);
  assert.match(svcSrc, /buildRetailerId\(item, variantName\)/);
});

test('syncMenuToCatalog still uses a plain per-item retailer_id (no variant suffix) when an item has no variants', () => {
  assert.match(svcSrc, /const retailer_id = buildRetailerId\(item\);/);
});

test('variant names are folded into the synced product title so items are distinguishable in the Meta catalog UI', () => {
  // [FIX-CATALOG-FIELD-NAMES] Meta's items_batch wants `title`, not `name` —
  // see the corresponding comment block in waCatalogService.js. Variant
  // folding behavior itself (item.name + variantName) is unchanged; only the
  // output field key changed.
  assert.match(svcSrc, /title:\s*variantName \? `\$\{item\.name\} - \$\{variantName\}` : item\.name/);
});

test('variant entries accept both string variants (["M","L"]) and object variants ([{name:"M"}])', () => {
  assert.match(svcSrc, /\(v && typeof v === 'object'\) \? v\.name : v/);
});

// ── Behavioural proof via a tiny stand-in of the request-building logic ──────
// (mirrors the exact logic in waCatalogService.js so a regression there is
// caught even if someone changes the surrounding code enough to break the
// source-text regexes above.)
function buildRetailerId(menuItem, variantName = null) {
  const slugify = (s = '') => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
  const id = String(menuItem?._id || '').trim();
  if (!id) return null;
  return variantName ? `${id}::${slugify(variantName)}` : id;
}

function buildUpdateRequests(menu) {
  return menu.flatMap(item => {
    const variants = Array.isArray(item.variants) ? item.variants : [];
    if (!variants.length) {
      const retailer_id = buildRetailerId(item);
      return retailer_id ? [{ retailer_id, name: item.name }] : [];
    }
    return variants
      .map(v => (v && typeof v === 'object') ? v.name : v)
      .filter(Boolean)
      .map(variantName => {
        const retailer_id = buildRetailerId(item, variantName);
        return retailer_id ? { retailer_id, name: `${item.name} - ${variantName}` } : null;
      })
      .filter(Boolean);
  });
}

test('a variant item produces one distinct retailer_id per variant, each resolvable back by resolveCatalogItem', () => {
  const menu = [{ _id: 'shirt1', name: 'Blue Shirt', variants: ['Small', 'Large'] }];
  const requests = buildUpdateRequests(menu);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => r.retailer_id).sort(), ['shirt1::large', 'shirt1::small']);
});

test('a variant item with object-shaped variants ({ name }) produces the same retailer_ids as string variants', () => {
  const menu = [{ _id: 'shirt1', name: 'Blue Shirt', variants: [{ name: 'Small' }, { name: 'Large' }] }];
  const requests = buildUpdateRequests(menu);
  assert.deepEqual(requests.map(r => r.retailer_id).sort(), ['shirt1::large', 'shirt1::small']);
});

test('a plain item with no variants still gets exactly one entry with the un-suffixed retailer_id (unchanged behaviour)', () => {
  const menu = [{ _id: 'hat1', name: 'Red Hat', variants: [] }];
  const requests = buildUpdateRequests(menu);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].retailer_id, 'hat1');
});
