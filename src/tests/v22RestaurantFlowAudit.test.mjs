// tests/v22RestaurantFlowAudit.test.mjs
//
// Regression tests for the v22 systematic audit of the restaurant flow systems
// (orderFlow.js, bookingFlow.js, moduleRegistry.js REPEAT_ORDER/ORDER wiring).
//
// Bugs found and fixed:
//
// [AUDIT-FIX-REPEAT-1] core/shared/moduleRegistry.js's REPEAT_ORDER action wrote
// `data.item = { name: lastItem }` into the session with no `price` field.
// getLastOrderItem() only ever returns the stored item NAME (Order.item is a
// plain string), so the stub item had no price at all. orderFlow.js's QUANTITY
// step computes `price = item?.price || 0`, so every repeated order silently
// totalled D0 — and because the CONFIRM step only shows/collects payment when
// `data.totalPrice` is truthy, a totalPrice of 0 ALSO skipped the payment step
// entirely for tenants with payment enabled (treated as a free cash order with
// no admin payment-verification prompt). Fix: re-resolve the full menu item
// (with price) from business.menuItems by name before writing it into session
// data, falling back to a name-only stub (with an explicit customer-facing
// price-uncertainty notice) only when the item can no longer be found on the
// current menu.
//
// [AUDIT-FIX-ADDON-1] modules/restaurant/flows/orderFlow.js's _selectItem()
// helper always advertised addOns[0].name in the "pairs well with this" teaser
// shown right after picking an item, but the QUANTITY step's actual upsell
// prompt picked a DIFFERENT, RANDOM add-on from the same list. A customer could
// be told "*Soft Drink* pairs well with this" and then be asked "Would you like
// to add *Dessert*?" one message later — the promised add-on and the offered
// add-on didn't match whenever a business had more than one add-on configured.
// Fix: the add-on is now chosen ONCE in _selectItem, stored as
// `data.pendingAddOn`, and the QUANTITY step (which already preferred
// `data.pendingAddOn` over re-rolling) uses that same pinned choice — so the
// name in the teaser is always the one actually offered at checkout.
//
// These are source-text guards, consistent with how the existing
// v18FlowSystemAudit.test.mjs / v19FlowsAudit.test.mjs suites work in this
// codebase — orderFlow.js and moduleRegistry.js pull in Mongoose models and
// session/dispatch services that are not safe to exercise end-to-end without a
// live Mongo connection and Express app context.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('moduleRegistry.js: REPEAT_ORDER resolves the full menu item (with price) instead of a name-only stub', () => {
  const src = read('../core/shared/moduleRegistry.js');
  const start = src.indexOf("registerAction('REPEAT_ORDER'");
  assert.ok(start !== -1, 'REPEAT_ORDER action not found');
  const body = src.slice(start, start + 2200);

  // Must look the item back up on the current menu so price/image/etc. survive.
  assert.match(body, /business\?\.menuItems/, 'expected REPEAT_ORDER to re-resolve the item from business.menuItems');
  assert.match(body, /fullItem/, 'expected a resolved fullItem variable');

  // Must NOT unconditionally write a name-only stub as the session item anymore.
  assert.doesNotMatch(
    body,
    /data:\s*{\s*item:\s*{\s*name:\s*lastItem\s*}\s*}/,
    'REPEAT_ORDER must not write a bare {name: lastItem} stub with no price'
  );

  // The write must prefer the resolved item, falling back to the stub only when unresolved.
  assert.match(body, /item:\s*fullItem\s*\|\|\s*{\s*name:\s*lastItem\s*}/, 'expected fullItem to be preferred over the name-only fallback');
});

test('moduleRegistry.js: REPEAT_ORDER warns the customer when the item price could not be confirmed', () => {
  const src = read('../core/shared/moduleRegistry.js');
  const start = src.indexOf("registerAction('REPEAT_ORDER'");
  const body = src.slice(start, start + 2200);
  assert.match(body, /!fullItem/, 'expected a fallback branch guarded on the item not being found');
  assert.match(body, /price/i, 'expected some price-related customer messaging in the fallback branch');
});

test('restaurant/flows/orderFlow.js: _selectItem pins one add-on and reuses it for both the teaser and the upsell prompt', () => {
  const src = read('../modules/restaurant/flows/orderFlow.js');
  const start = src.indexOf('async function _selectItem');
  assert.ok(start !== -1, '_selectItem helper not found');
  const body = src.slice(start, start + 1600);

  // The add-on must be chosen once and stored on session data as pendingAddOn.
  assert.match(body, /pendingAddOn/, 'expected _selectItem to compute and store pendingAddOn');
  assert.match(
    body,
    /data:\s*{\s*\.\.\.data,\s*item,\s*pendingAddOn\s*}/,
    'expected pendingAddOn to be persisted alongside item in the same updateSession call'
  );

  // The teaser text must reference the pinned choice, not addOns[0] directly.
  assert.doesNotMatch(
    body,
    /addOns\[0\]\.name/,
    '_selectItem must not hardcode addOns[0] in the teaser — that can mismatch the later random upsell pick'
  );
  assert.match(
    body,
    /pendingAddOn\.name.*pairs well with this/s,
    'expected the teaser text to reference the pinned pendingAddOn, not a fixed index'
  );
});

test('restaurant/flows/orderFlow.js: QUANTITY step still honours a pre-pinned pendingAddOn instead of always re-rolling', () => {
  const src = read('../modules/restaurant/flows/orderFlow.js');
  const start = src.indexOf("case 'QUANTITY'");
  assert.ok(start !== -1, 'QUANTITY case not found');
  const body = src.slice(start, start + 1800);
  assert.match(
    body,
    /data\.pendingAddOn\s*\|\|\s*addOns\[/,
    'QUANTITY must prefer the already-pinned data.pendingAddOn over rolling a fresh random add-on'
  );
});
