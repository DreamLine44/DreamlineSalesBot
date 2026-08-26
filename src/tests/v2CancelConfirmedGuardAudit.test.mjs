// tests/v2CancelConfirmedGuardAudit.test.mjs
//
// CANCEL / CANCEL_ALL now cancel all *visible* active activities (within 24h),
// including confirmed/ready orders — stale orders age out automatically.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('moduleRouter.js: CANCEL uses cancelMostRecentActiveOrder lifecycle helper', () => {
  const src = read('../core/conversations/moduleRouter.js');
  const body = src.slice(src.indexOf("case 'CANCEL':"), src.indexOf("case 'CANCEL_ALL':"));
  assert.match(body, /cancelMostRecentActiveOrder/);
});

test('moduleRouter.js: CANCEL_ALL uses cancelAllActiveForCustomer lifecycle helper', () => {
  const src = read('../core/conversations/moduleRouter.js');
  const body = src.slice(src.indexOf("case 'CANCEL_ALL':"), src.indexOf("case 'SUPPORT':"));
  assert.match(body, /cancelAllActiveForCustomer/);
});
