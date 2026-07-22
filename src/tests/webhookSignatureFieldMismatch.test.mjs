// tests/webhookSignatureFieldMismatch.test.mjs
//
// [FIX-SIG-2] Regression test.
//
// Root cause: the Tenant schema has TWO fields that are each independently
// documented, settable via the admin API, and encrypted the same way as "the"
// per-tenant Meta App Secret used for webhook HMAC verification:
//   - whatsapp.webhookSecret  (the field createTenant/updateTenant's setup
//     form actually writes to — see controllers/tenantController.js)
//   - meta.appSecret          (added later by the multi-tenant credential
//     upgrade)
//
// _verifyTenantWebhookSignature() used to read ONLY meta.appSecret. Any tenant
// whose real secret was stored in whatsapp.webhookSecret (the field their
// setup form populates) had every genuine webhook delivery fail HMAC and get
// dropped — consistently, for every message from that chat/customer — even
// though the tenant, the WhatsApp connection, and every other feature were
// configured correctly. From the customer's side this looked like tapping
// "View Menu" (or anything else) silently doing nothing, because the
// triggering message never got past signature verification.
//
// Run with: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { _verifyTenantWebhookSignature } from '../controllers/webhookController.js';

function reqWithBody(bodyObj, secretUsedToSign) {
  const rawBody = Buffer.from(JSON.stringify(bodyObj));
  const sig = 'sha256=' + crypto.createHmac('sha256', secretUsedToSign).update(rawBody).digest('hex');
  return {
    headers: { 'x-hub-signature-256': sig },
    rawBody,
    ip: '127.0.0.1',
  };
}

const SAMPLE_EVENT = {
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.TEST', from: '15551234567', type: 'interactive' }] } }] }],
};

test('[FIX-SIG-2] verifies against whatsapp.webhookSecret when meta.appSecret is unset', () => {
  // ENCRYPTION_KEY unset in this test environment ⇒ decryptToken() is a
  // pass-through on plaintext values, matching how a dev/staging tenant with
  // no ENCRYPTION_KEY configured behaves. This isolates the field-selection
  // bug from the encryption layer.
  delete process.env.ENCRYPTION_KEY;
  delete process.env.META_APP_SECRET;

  const realSecret = 'the-tenants-real-meta-app-secret';
  const tenant = {
    _id: 'tenant123',
    meta: { appSecret: null },                    // never populated for this tenant
    whatsapp: { webhookSecret: realSecret },       // populated via the normal setup form
  };

  const req = reqWithBody(SAMPLE_EVENT, realSecret);

  const ok = _verifyTenantWebhookSignature(req, tenant, 'wamid.TEST');
  assert.equal(ok, true, 'a signature valid for whatsapp.webhookSecret must verify, ' +
    'not be dropped as a "signature mismatch"');
});

test('[FIX-SIG-2] still verifies against meta.appSecret when that is the populated field', () => {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.META_APP_SECRET;

  const realSecret = 'a-different-real-secret';
  const tenant = {
    _id: 'tenant456',
    meta: { appSecret: realSecret },
    whatsapp: { webhookSecret: null },
  };

  const req = reqWithBody(SAMPLE_EVENT, realSecret);

  const ok = _verifyTenantWebhookSignature(req, tenant, 'wamid.TEST');
  assert.equal(ok, true, 'meta.appSecret must remain a valid verification source');
});

test('[FIX-SIG-2] a signature that matches neither field is still correctly rejected', () => {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.META_APP_SECRET;

  const tenant = {
    _id: 'tenant789',
    meta: { appSecret: 'secret-a' },
    whatsapp: { webhookSecret: 'secret-b' },
  };

  const req = reqWithBody(SAMPLE_EVENT, 'some-attacker-guess');

  const ok = _verifyTenantWebhookSignature(req, tenant, 'wamid.TEST');
  assert.equal(ok, false, 'genuinely wrong signatures must still be rejected — this fix ' +
    'only widens which stored secret is tried, it does not weaken verification');
});
