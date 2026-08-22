// tests/corsAuthHeaderFix.test.mjs
//
// [FIX-CORS-AUTH-HEADER] Regression test.
//
// authMiddleware.js's tryBearerAuth() ([FEATURE-MULTIADMIN-1] staff-login
// system) reads `Authorization: Bearer <token>` on every request via
// requireApiKey — it is the primary auth path whenever the header is
// present, ahead of the legacy x-api-key check. But app.js's CORS
// `allowedHeaders` never included `Authorization`, so any cross-origin
// browser request from the real dashboard frontend sending that header
// failed the CORS preflight before it was ever sent to the server — the
// backend logic was fully built and tested, but no deployed frontend could
// reach it. Staff login (StaffPage.jsx / AcceptInvitePage.jsx) was silently
// unusable from any browser origin.
//
// Fix: added 'Authorization' to CORS allowedHeaders in app.js.
//
// Run with: node --test src/tests/

import { test } from 'node:test';
import assert    from 'node:assert/strict';
import fs        from 'fs';
import path      from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

test('app.js CORS config includes Authorization in allowedHeaders', () => {
  const idx = appSrc.indexOf('allowedHeaders:');
  assert.ok(idx !== -1, 'expected an allowedHeaders entry in the CORS config');
  const line = appSrc.slice(idx, appSrc.indexOf('\n', idx));
  assert.match(
    line,
    /Authorization/,
    'Authorization must be in CORS allowedHeaders, or every Bearer-session (staff login) ' +
    'request from a browser frontend fails preflight before reaching authMiddleware.js',
  );
});

test('app.js CORS config still includes the pre-existing headers (x-api-key, x-sim-key, Content-Type)', () => {
  const idx = appSrc.indexOf('allowedHeaders:');
  const line = appSrc.slice(idx, appSrc.indexOf('\n', idx));
  for (const header of ['Content-Type', 'x-api-key', 'x-sim-key']) {
    assert.ok(line.includes(header), `${header} must remain in allowedHeaders — this fix is additive only`);
  }
});
