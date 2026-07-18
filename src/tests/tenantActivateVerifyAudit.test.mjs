// tests/tenantActivateVerifyAudit.test.mjs
//
// Regression test for [AUDIT-FIX-ACTIVATE-VERIFY].
//
// Bug found and fixed: controllers/tenantController.js's updateTenant()
// ONE-SHOT activate:true path called verifyCredentialsWithMeta() and logged
// the result, but then set `status: 'ACTIVE'` UNCONDITIONALLY regardless of
// whether metaVerification.verified was true or false — only
// whatsapp.connected reflected the real outcome. webhookController.js's
// receiveWebhook() gates message processing purely on status:'ACTIVE' (not
// whatsapp.connected — see the `status: 'ACTIVE'` filter in its Tenant
// lookup), so a tenant whose credentials Meta explicitly rejected (bad
// token, wrong phoneNumberId, etc.) was activated anyway: the bot would
// start trying to serve real customer messages using credentials already
// known to be broken, and the response message ("Tenant credentials set and
// activated. Bot is live.") was shown to the admin even though verification
// had failed.
//
// This is a source-text guard (consistent with this codebase's convention
// for controller logic that requires a live Mongo connection to exercise
// end-to-end) rather than a live invocation of updateTenant().
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('tenantController.js: updateTenant only sets status:ACTIVE when Meta actually verified the credentials', () => {
  const src = read('../controllers/tenantController.js');
  const start = src.indexOf('if (wantsActivate) {');
  assert.ok(start !== -1, 'wantsActivate block not found');
  const body = src.slice(start, start + 3500);

  assert.match(
    body,
    /if\s*\(!metaVerification\.verified\)\s*{/,
    'expected an early-return guard when Meta verification failed'
  );

  // The unconditional activation must not immediately follow the
  // verification call anymore — it must be gated behind the verified check.
  const guardIdx  = body.search(/if\s*\(!metaVerification\.verified\)\s*{/);
  const statusIdx = body.indexOf("updates['status']             = 'ACTIVE';");
  assert.ok(statusIdx > guardIdx, 'status:ACTIVE assignment must come after the verified guard, not before it');
});

test('tenantController.js: a failed activation attempt does not respond with the "Bot is live" success message', () => {
  const src = read('../controllers/tenantController.js');
  const start = src.indexOf('if (wantsActivate) {');
  const body = src.slice(start, start + 3000);

  assert.match(
    body,
    /res\.status\(502\)\.json\(\{[\s\S]*?ok:\s*false/,
    'expected a 502 failure response distinct from the success path when verification fails'
  );
});
