// tests/rejectPaymentCancelButtonLeak.test.mjs
//
// [FIX-EXPOSED-BUTTONS-2] Regression test.
//
// adminCommandService.js's rejectPayment() cash/no-payment branch previously
// built its own raw `{ type: 'buttons', buttons: modeCfg.ui?.welcomeButtons }`
// reply for the "your order has been cancelled by our team" customer notice.
// For any mode that defines both welcomeButtons (the raw 3-button "Order
// Food / Book a Table / ⋯ More" main-nav layout) AND welcomeList (the
// "Choose an option ▼" dropdown) — restaurant being the shipped example —
// this meant a customer whose order was cancelled by an admin saw the full
// main-navigation button set leaked into a cancellation notice, instead of
// the clean dropdown core/shared/uiOptionsHelper.js's buildOptionsReply()
// already exists specifically to guarantee here (see that file's own
// [FIX-EXPOSED-BUTTONS-1] header comment, and postFlowHandler.js's
// customer-initiated SWITCH_YES cancel path, which already did this
// correctly). This was simply a call site that earlier audit missed.
//
// Source-level check (same convention as other adminCommandService.js
// regression tests in this suite that assert call-site wiring without a
// live DB/mongoose session) plus a direct behavioural check of
// buildOptionsReply() itself against the restaurant mode config, proving
// the reply this call site now produces is the list, not raw buttons.

import test    from 'node:test';
import assert  from 'node:assert/strict';
import fs      from 'node:fs';
import path    from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

const adminCmdSrc = read('../services/adminCommandService.js');

test('rejectPayment cash-cancel branch routes the customer notice through buildOptionsReply(), not a raw welcomeButtons array', () => {
  assert.match(adminCmdSrc, /import \{ buildOptionsReply \} from '\.\.\/core\/shared\/uiOptionsHelper\.js'/);
  assert.match(adminCmdSrc, /await dispatchMessage\(order\.customerPhone, buildOptionsReply\(\s*modeCfg,/);
  // Guard against the old raw-buttons leak creeping back in.
  assert.doesNotMatch(adminCmdSrc, /const custBtns = \(modeCfg\.ui\?\.welcomeButtons/);
});

test('buildOptionsReply(), given a mode config with both welcomeList and welcomeButtons (the restaurant shape), returns the "Choose an option" list — never the raw main-nav buttons', async () => {
  const { buildOptionsReply } = await import('../core/shared/uiOptionsHelper.js');
  const { RESTAURANT_CONFIG } = await import('../modules/restaurant/configs/index.js');

  const reply = buildOptionsReply(RESTAURANT_CONFIG, '❌ *Order Cancelled*\n\nYour order was cancelled by our team.');

  assert.equal(reply.type, 'list');
  assert.match(reply.button, /Choose an option/i);
  const rowIds = reply.rows.map(r => r.id);
  assert.ok(rowIds.includes('ORDER'));
  // Must not be the raw 3-button "Order Food / Book a Table / ⋯ More" layout.
  assert.notEqual(reply.type, 'buttons');
});
