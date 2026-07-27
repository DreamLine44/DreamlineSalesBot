// tests/webhookSecretFingerprint.test.mjs
//
// [FIX-SIG-FINGERPRINT] Regression test.
//
// Root cause this closes: a webhook signature mismatch (see
// webhookSignatureFieldMismatch.test.mjs for the two-field bug, already
// fixed) can ALSO happen when a secret is stored in the right field,
// decrypts fine, and is simply the WRONG value — copy-pasted from the wrong
// Meta App, truncated, or the App ID pasted where the App Secret belongs.
// Every prior log line could only say "a secret exists," never "whether
// it's the RIGHT secret," leaving operators to guess. fingerprintSecret()
// gives a stable, non-reversible way to compare a stored secret against the
// value shown in the Meta App Dashboard without ever transmitting/logging
// the plaintext secret twice.
//
// Run with: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintSecret } from '../controllers/tenantController.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function readSource(relPath) {
  return fs.readFileSync(path.join(__dirname, relPath), 'utf8');
}

test('fingerprintSecret: same secret always produces the same fingerprint', () => {
  const a = fingerprintSecret('my-real-app-secret');
  const b = fingerprintSecret('my-real-app-secret');
  assert.equal(a, b);
  assert.equal(typeof a, 'string');
  assert.equal(a.length, 12, 'fingerprint should be a 12-char hex prefix, short enough to eyeball-compare');
});

test('fingerprintSecret: different secrets produce different fingerprints', () => {
  const a = fingerprintSecret('my-real-app-secret');
  const b = fingerprintSecret('a-different-secret');
  assert.notEqual(a, b);
});

test('fingerprintSecret: trims whitespace so a trailing-newline paste still matches the clean value', () => {
  const clean  = fingerprintSecret('my-real-app-secret');
  const padded = fingerprintSecret('my-real-app-secret\n');
  assert.equal(clean, padded, 'a secret pasted with trailing whitespace must fingerprint identically to the clean value');
});

test('fingerprintSecret: never throws and returns null for empty/missing input', () => {
  assert.equal(fingerprintSecret(''), null);
  assert.equal(fingerprintSecret(null), null);
  assert.equal(fingerprintSecret(undefined), null);
});

test('fingerprintSecret: output never contains or resembles the original plaintext', () => {
  const secret = 'sup3r-s3cr3t-app-value';
  const fp = fingerprintSecret(secret);
  assert.ok(!fp.includes(secret), 'fingerprint must not leak the plaintext secret');
});

test('webhookController.js: signature-mismatch log includes secret fingerprints for diagnosis', () => {
  const src = readSource('../controllers/webhookController.js');
  assert.ok(
    src.includes('tenantSecretFingerprint: fingerprintSecret(tenantSecret)') &&
    src.includes('webhookSecretFingerprint: fingerprintSecret(waSecret)') &&
    src.includes('globalSecretFingerprint: fingerprintSecret(globalSecret)'),
    'The signature-mismatch warn log should include fingerprints of every candidate secret tried, ' +
    'so an operator can compare against POST /admin/webhook-secret-fingerprint instead of guessing ' +
    'whether the stored secret is correct.'
  );
});

test('webhookController.js: a genuinely lost message (no matching duplicate) logs at error level', () => {
  const src = readSource('../controllers/webhookController.js');
  const block = src.match(/NO successful duplicate found[\s\S]{0,400}/);
  assert.ok(block, 'Could not find the "no successful duplicate found" branch');
  const errorCallBefore = src.slice(0, src.indexOf('NO successful duplicate found')).lastIndexOf('logger.error(');
  const warnCallBefore  = src.slice(0, src.indexOf('NO successful duplicate found')).lastIndexOf('logger.warn(');
  assert.ok(
    errorCallBefore > warnCallBefore,
    'A signature mismatch with no matching duplicate means a real customer message was dropped with ' +
    'no recovery — this should log at error level, not warn, so it is not lost among routine duplicate-noise lines.'
  );
});

test('adminRoutes.js: exposes POST /webhook-secret-fingerprint and never echoes the posted secret back', () => {
  const src = readSource('../routes/adminRoutes.js');
  assert.ok(
    src.includes("r.post('/webhook-secret-fingerprint'"),
    'adminRoutes.js should expose POST /webhook-secret-fingerprint for comparing a pasted ' +
    'Meta App Dashboard secret against the fingerprint recorded when a tenant secret was saved.'
  );
  const routeBlock = src.match(/r\.post\('\/webhook-secret-fingerprint'[\s\S]*?\n\}\);/);
  assert.ok(routeBlock, 'Could not find the webhook-secret-fingerprint route body');
  assert.ok(
    !/res\.json\(\{[^}]*secret[^}]*\}\)/.test(routeBlock[0].replace('fingerprint', '')),
    'The endpoint must never echo the plaintext secret back in the response — only its fingerprint.'
  );
});

test('tenantController.js: saving meta.appSecret or whatsapp.webhookSecret logs a fingerprint, never the plaintext', () => {
  const src = readSource('../controllers/tenantController.js');
  assert.ok(
    src.includes("logger.info('[TenantCtrl] whatsapp.webhookSecret saved'") &&
    src.includes("logger.info('[TenantCtrl] meta.appSecret saved'"),
    'Saving a webhook-signing secret should log a fingerprint at save time, giving operators a ' +
    'known-good reference point for later signature-mismatch debugging.'
  );
});
