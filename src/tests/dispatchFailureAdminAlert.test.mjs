// tests/dispatchFailureAdminAlert.test.mjs
//
// Regression test for [AUDIT-FIX-DISPATCH-ALERT] in core/whatsapp/dispatcher.js.
//
// dispatchMessage() has three (really four, counting the network-error catch)
// failure branches — missing/placeholder WhatsApp credentials, a rejected
// Meta API call, and a network/timeout error — that previously only ever
// logged server-side. A customer-facing send could vanish completely with
// nothing but a log line as evidence, unless someone was actively tailing
// logs. This wires all four into the existing AdminNotification fan-out
// (see models/AdminNotification.js, routes/adminRoutes.js) so they surface
// as TO_ADMIN dashboard alerts for the super admin instead.
//
// _notifyAdminOfDispatchFailure() calls AdminNotification.create(), a live
// Mongo write, so — consistent with this codebase's existing convention for
// equivalent logic that can't be exercised without a DB connection (see
// auditFixListButtonLabel, v4RetailVariantPickerAudit, v18FlowSystemAudit) —
// this is a source-text guard test rather than an executed-write test.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('dispatcher.js: all four dispatch failure branches call _notifyAdminOfDispatchFailure', () => {
  const src = read('../core/whatsapp/dispatcher.js');
  const defIdx = src.indexOf('async function _notifyAdminOfDispatchFailure');
  assert.ok(defIdx > -1, '_notifyAdminOfDispatchFailure definition not found');
  const afterDef = src.slice(defIdx + 'async function _notifyAdminOfDispatchFailure'.length);
  const callSites = afterDef.split('_notifyAdminOfDispatchFailure(tenant,').length - 1;
  // 4 call sites: missing_credentials, placeholder_phone_id, meta_api_error, network_error.
  assert.equal(
    callSites, 4,
    'expected exactly 4 call sites (missing credentials, placeholder phone id, ' +
    'Meta API rejection, network/timeout error) — found ' + callSites,
  );
  for (const reason of ['missing_credentials', 'placeholder_phone_id', 'meta_api_error', 'network_error']) {
    assert.ok(src.includes(`'${reason}'`), `missing dispatch-failure reason: ${reason}`);
  }
});

test('dispatcher.js: admin alerts are deduped so an ongoing outage does not flood the dashboard', () => {
  const src = read('../core/whatsapp/dispatcher.js');
  assert.ok(
    src.includes('DISPATCH_ALERT_DEDUPE_MS') && src.includes('_recentDispatchAlerts'),
    'expected a dedup window keyed per (tenantId, reason) so repeated failures during ' +
    'the same outage produce one alert, not one per failed message',
  );
});

test('dispatcher.js: alerts use TO_ADMIN (super admin), not TO_TENANT, and never ping the same broken WhatsApp channel', () => {
  const src = read('../core/whatsapp/dispatcher.js');
  const fnIdx = src.indexOf('async function _notifyAdminOfDispatchFailure');
  assert.ok(fnIdx > -1, '_notifyAdminOfDispatchFailure not found');
  const slice = src.slice(fnIdx, fnIdx + 1200);
  assert.ok(slice.includes("direction: 'TO_ADMIN'"), 'dispatch-failure alerts should be TO_ADMIN (super admin), not TO_TENANT');
  assert.ok(!slice.includes('dispatchText') && !slice.includes('dispatchMessage'),
    'must not attempt to re-notify via the same (potentially broken) WhatsApp channel that just failed');
});

test('dispatcher.js: credential-related failures are urgent; transient network errors are not', () => {
  const src = read('../core/whatsapp/dispatcher.js');
  const missingCredIdx = src.indexOf('missing_credentials');
  const placeholderIdx = src.indexOf('placeholder_phone_id');
  const networkIdx     = src.indexOf('network_error');
  assert.ok(missingCredIdx > -1 && placeholderIdx > -1 && networkIdx > -1);
  assert.ok(
    src.slice(missingCredIdx, missingCredIdx + 400).includes("severity: 'urgent'") ||
    src.slice(missingCredIdx, missingCredIdx + 600).includes("'urgent'"),
    'missing credentials should alert as urgent — every send will keep failing until fixed',
  );
  assert.ok(
    src.slice(placeholderIdx, placeholderIdx + 600).includes("'urgent'"),
    'a placeholder SIM_ phone id should alert as urgent — onboarding was never completed',
  );
  assert.ok(
    src.slice(networkIdx, networkIdx + 600).includes("severity: 'warning'"),
    'a single network/timeout error should alert as warning, not urgent — likely transient',
  );
});

test('dispatcher.js: admin alerting is fire-and-forget and never throws back into the dispatch path', () => {
  const src = read('../core/whatsapp/dispatcher.js');
  const fnIdx = src.indexOf('async function _notifyAdminOfDispatchFailure');
  assert.ok(fnIdx > -1);
  const slice = src.slice(fnIdx, fnIdx + 1500);
  assert.ok(slice.includes('try {') && slice.includes('catch (err)'),
    '_notifyAdminOfDispatchFailure must swallow its own errors so alerting failures never affect message dispatch');
  // Every call site should be .catch()'d rather than awaited bare, so a failed
  // alert write can never delay or break the caller's dispatchMessage() flow.
  const callSitePattern = /_notifyAdminOfDispatchFailure\(tenant,[^;]*\}\)\.catch\(\(\) => \{\}\);/gs;
  const matches = src.match(callSitePattern) || [];
  assert.equal(matches.length, 4, 'every call site should end in .catch(() => {}) — fire-and-forget');
});
