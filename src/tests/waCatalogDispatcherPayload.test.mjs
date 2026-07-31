// tests/waCatalogDispatcherPayload.test.mjs
//
// Regression tests for [CATALOG-DISPATCH-1] in core/whatsapp/dispatcher.js.
//
// One test proves a catalog-enabled send produces the correct Meta payload
// shape for both 'catalog_message' and 'product_list'. The other proves the
// pre-existing text/buttons/list/image message types are BYTE-FOR-BYTE
// unchanged by this addition — the "zero behavioural change for tenants who
// never enable WA Catalog" guarantee, exercised at the transport layer where
// every message type in the app ultimately passes through.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SIMULATION_MODE = 'true'; // dispatchMessage short-circuits before any network call

const { dispatchMessage } = await import('../core/whatsapp/dispatcher.js');

// ── WA Catalog payload shapes ────────────────────────────────────────────────

test('catalog_message builds a valid Meta interactive catalog_message payload', async () => {
  const ui = { type: 'catalog_message', catalogId: 'CATALOG_123', body: 'Browse our products!' };
  const { payload } = await dispatchMessage('1234567890', ui, {});

  assert.equal(payload.type, 'interactive');
  assert.equal(payload.interactive.type, 'catalog_message');
  assert.equal(payload.interactive.body.text, 'Browse our products!');
  assert.equal(payload.interactive.action.name, 'catalog_message');
});

test('[FIX-CATALOG-MSG-PARAM] catalog_message never puts catalog_id on the wire (not a valid field for this message type)', async () => {
  const ui = { type: 'catalog_message', catalogId: 'CATALOG_123', body: 'Browse our products!' };
  const { payload } = await dispatchMessage('1234567890', ui, {});

  assert.equal('parameters' in payload.interactive.action, false);
  assert.equal(JSON.stringify(payload).includes('CATALOG_123'), false);
});

test('[FIX-CATALOG-MSG-PARAM] catalog_message includes thumbnail_product_retailer_id when provided, and only that key', async () => {
  const ui = {
    type: 'catalog_message', catalogId: 'CATALOG_123', body: 'Browse our products!',
    thumbnailProductRetailerId: 'menuitem123',
  };
  const { payload } = await dispatchMessage('1234567890', ui, {});

  assert.deepEqual(payload.interactive.action, {
    name: 'catalog_message',
    parameters: { thumbnail_product_retailer_id: 'menuitem123' },
  });
});

test('catalog_message with no catalogId is refused (returns null payload, never sent malformed)', async () => {
  const ui = { type: 'catalog_message', body: 'Browse our products!' };
  const { payload } = await dispatchMessage('1234567890', ui, {});
  assert.equal(payload, null);
});

test('product_list builds sections with product_retailer_id entries, capped at Meta limits', async () => {
  const productRetailerIds = Array.from({ length: 45 }, (_, i) => `sku-${i + 1}`);
  const ui = {
    type: 'product_list',
    catalogId: 'CATALOG_123',
    body: 'Here are some picks:',
    header: 'Featured',
    sections: [{ title: 'Popular Items', productRetailerIds }],
  };
  const { payload } = await dispatchMessage('1234567890', ui, {});

  assert.equal(payload.interactive.type, 'product_list');
  assert.equal(payload.interactive.action.catalog_id, 'CATALOG_123');
  assert.equal(payload.interactive.header.text, 'Featured');
  // Meta caps product_list at 30 items per section.
  assert.equal(payload.interactive.action.sections[0].product_items.length, 30);
  assert.equal(payload.interactive.action.sections[0].product_items[0].product_retailer_id, 'sku-1');
});

test('product_list with no sections/catalogId is refused, never sent malformed', async () => {
  const { payload: p1 } = await dispatchMessage('1234567890', { type: 'product_list', catalogId: 'X' }, {});
  assert.equal(p1, null);
  const { payload: p2 } = await dispatchMessage('1234567890', { type: 'product_list', sections: [{ productRetailerIds: ['a'] }] }, {});
  assert.equal(p2, null);
});

// ── Non-catalog tenants: byte-for-byte unchanged ────────────────────────────

test('text/buttons/list/image message shapes are unchanged by the WA Catalog addition', async () => {
  const { payload: textPayload } = await dispatchMessage('1', { type: 'text', body: 'hello' }, {});
  assert.deepEqual(textPayload, {
    messaging_product: 'whatsapp', recipient_type: 'individual',
    to: '1', type: 'text', text: { body: 'hello' },
  });

  const { payload: btnPayload } = await dispatchMessage('1', {
    type: 'buttons', body: 'Pick one', buttons: [{ id: 'A', title: 'A' }],
  }, {});
  assert.equal(btnPayload.interactive.type, 'button');
  assert.equal(btnPayload.interactive.action.buttons[0].reply.id, 'A');

  const { payload: listPayload } = await dispatchMessage('1', {
    type: 'list', body: 'Choose', button: 'View', rows: [{ id: '1', title: 'Item 1' }],
  }, {});
  assert.equal(listPayload.interactive.type, 'list');
  assert.equal(listPayload.interactive.action.sections[0].rows[0].id, '1');

  const { payload: imgPayload } = await dispatchMessage('1', { type: 'image', url: 'https://x/y.jpg' }, {});
  assert.equal(imgPayload.type, 'image');
  assert.equal(imgPayload.image.link, 'https://x/y.jpg');
});
