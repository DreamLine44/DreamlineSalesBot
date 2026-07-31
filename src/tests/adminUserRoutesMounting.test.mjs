// tests/adminUserRoutesMounting.test.mjs
//
// [FIX-ORPHAN-ROUTE-1] Regression test.
//
// adminUserRoutes.js (login, accept-invite, staff management) was fully
// built and wired to adminUserController.js but was never imported/mounted
// in app.js, leaving every route in it — including /dashboard/auth/login,
// the endpoint a tenant needs just to obtain a session — unreachable.
// No test guarded this, so it regressed silently once. This test reads
// app.js's own source to confirm the fix (a) exists and (b) is registered
// before the /dashboard requireApiKey mount, since mounting it after would
// make login/accept-invite permanently 401 (they're intentionally
// unauthenticated — that's how a session token is obtained in the first
// place).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

test('app.js imports adminUserRoutes', () => {
  assert.match(
    appSrc,
    /import\s+adminUserRoutes\s+from\s+['"]\.\/routes\/adminUserRoutes\.js['"]/,
    'adminUserRoutes must be imported in app.js or every route in it is dead code'
  );
});

test('app.js mounts adminUserRoutes before the /dashboard requireApiKey mount', () => {
  const mountIdx     = appSrc.search(/app\.use\(['"]\/['"],\s*adminUserRoutes\)/);
  const dashboardIdx = appSrc.indexOf("app.use('/dashboard'");

  assert.ok(mountIdx !== -1, "adminUserRoutes must be mounted (app.use('/', adminUserRoutes))");
  assert.ok(dashboardIdx !== -1, 'expected to find the /dashboard mount in app.js');
  assert.ok(
    mountIdx < dashboardIdx,
    'adminUserRoutes must be mounted BEFORE the /dashboard requireApiKey mount — ' +
    'otherwise /dashboard/auth/login and /dashboard/auth/accept-invite would ' +
    'require an api key they cannot possibly have yet, permanently 401ing.'
  );
});
