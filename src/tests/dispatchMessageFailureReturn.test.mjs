// tests/dispatchMessageFailureReturn.test.mjs
//
// Regression test for [AUDIT-FIX-DISPATCH-FALSE-SUCCESS] in
// core/whatsapp/dispatcher.js.
//
// dispatchMessage() (live/non-simulation branch) awaited the fetch() Response
// and logged when `!resp.ok`, but then fell through to `return resp;`
// unconditionally — so a Meta Graph API 4xx/5xx response was still handed
// back to the caller as a TRUTHY value indistinguishable from success.
//
// This is a live-fire bug for WA Catalog specifically: waCatalogService.js's
// sendCatalogMessage() does `const result = await dispatchMessage(...); return
// result || null;`, and every caller of sendCatalogMessage() (waCatalogFlow.js
// sendAndArmCatalog(), used by both offerCatalogOnStartOrder() and
// browseCatalogExplicit()) treats a truthy return as "catalog message
// actually sent" and arms the session accordingly / returns null (nothing
// further to send). A failed Graph API call therefore silently became a dead
// end for the customer — they got NO catalog message and NO fallback to the
// normal ORDER flow — which directly contradicts this codebase's own
// "WA Catalog must never become a single point of failure for a sale"
// [Failure handling] guarantee stated throughout waCatalogFlow.js and
// waCatalogService.js.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SIMULATION_MODE = 'false'; // exercise the live-fetch branch
process.env.ENCRYPTION_KEY  = process.env.ENCRYPTION_KEY || ''; // decryptToken falls back to raw value when unset

const tenant = { whatsapp: { accessToken: 'plaintext-token', phoneNumberId: 'PN123', apiVersion: 'v21.0' } };

test('dispatchMessage returns a falsy value when Meta responds with a 4xx/5xx status', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => '{"error":"Invalid parameter"}',
  });

  try {
    const { dispatchMessage } = await import('../core/whatsapp/dispatcher.js');
    const result = await dispatchMessage('1234567890', { type: 'text', body: 'hi' }, tenant);
    assert.ok(
      !result,
      'dispatchMessage must return a falsy value on a failed Meta API call, ' +
      'so callers like sendCatalogMessage() correctly treat the send as failed ' +
      'and fall back instead of silently dead-ending the customer',
    );
  } finally {
    global.fetch = realFetch;
  }
});

test('dispatchMessage still returns a truthy value when Meta responds with 2xx', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '{}',
  });

  try {
    const { dispatchMessage } = await import('../core/whatsapp/dispatcher.js');
    const result = await dispatchMessage('1234567890', { type: 'text', body: 'hi' }, tenant);
    assert.ok(result, 'a successful Meta send must still return a truthy value');
  } finally {
    global.fetch = realFetch;
  }
});

test('dispatchMessage retries a failed list send as buttons fallback before returning falsy', async () => {
  const realFetch = global.fetch;
  let callCount = 0;
  global.fetch = async (_url, init) => {
    callCount++;
    const body = JSON.parse(init.body);
    if (body?.interactive?.type === 'list') {
      return { ok: false, status: 400, text: async () => '{"error":"list rejected"}' };
    }
    if (body?.interactive?.type === 'button') {
      return { ok: true, status: 200, text: async () => '{}' };
    }
    return { ok: false, status: 400, text: async () => '{}' };
  };

  try {
    const { dispatchMessage } = await import('../core/whatsapp/dispatcher.js');
    const result = await dispatchMessage('1234567890', {
      type: 'list',
      body: "Here's our menu:",
      buttonLabel: 'View Menu',
      rows: [
        { id: '1', title: 'Domoda', description: 'D175' },
        { id: '2', title: 'Benachin', description: 'D175' },
      ],
    }, tenant);
    assert.ok(result, 'list send must fall back to buttons and return truthy on success');
    assert.ok(callCount >= 2, 'expected list attempt then buttons retry');
  } finally {
    global.fetch = realFetch;
  }
});
