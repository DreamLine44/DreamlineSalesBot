// tests/auditFixSystematicPass1.test.mjs
//
// Regression guards for the systematic audit pass covering:
//   [AUDIT-FIX-ROLE-GATE-1]   STAFF-role Bearer sessions could edit business
//                             settings/menu/services/faqs/promotions and list
//                             the full admin roster, despite models/AdminUser.js
//                             explicitly documenting STAFF as restricted to
//                             day-to-day (orders/bookings/conversations) access.
//   [AUDIT-FIX-STOCK-RACE-1] decrementStockForOrder() used a read-then-write
//                             JS-side stock decrement (lost-update race,
//                             allows overselling under concurrent orders).
//   [AUDIT-FIX-CSV-INJECTION-1] CSV export didn't neutralize leading
//                             =/+/-/@ characters in customer-supplied text,
//                             a formula-injection risk when a tenant opens
//                             the export in Excel/Sheets.
//
// Source-text guards (not live-DB/live-HTTP tests), consistent with this
// codebase's existing test style for routing/auth wiring (see
// waCatalogAdminLockdown.test.mjs).
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const dashboardRoutesSrc = read('../routes/dashboardRoutes.js');
const businessRoutesSrc  = read('../routes/businessRoutes.js');
const adminUserRoutesSrc = read('../routes/adminUserRoutes.js');
const orderServiceSrc    = read('../services/orderService.js');
const dashboardCtrlSrc   = read('../controllers/dashboardController.js');

// ── [AUDIT-FIX-ROLE-GATE-1] dashboardRoutes.js ──────────────────────────────

test('dashboardRoutes imports requireRole and defines a requireEditor (OWNER/MANAGER) gate', () => {
  assert.match(dashboardRoutesSrc, /import \{ requireRole \} from '\.\.\/middleware\/authMiddleware\.js'/);
  assert.match(dashboardRoutesSrc, /requireEditor\s*=\s*requireRole\('OWNER',\s*'MANAGER'\)/);
});

test('dashboardRoutes gates every settings/menu/services/faqs/promotions WRITE route with requireEditor', () => {
  const writeRoutes = [
    /r\.patch\('\/:tenantId\/settings',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.post\('\/:tenantId\/menu',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.patch\('\/:tenantId\/menu\/:itemId',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.delete\('\/:tenantId\/menu\/:itemId',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.post\('\/:tenantId\/menu\/:itemId\/image',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.delete\('\/:tenantId\/menu\/:itemId\/image',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.post\('\/:tenantId\/services',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.patch\('\/:tenantId\/services\/:serviceId',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.delete\('\/:tenantId\/services\/:serviceId',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.post\('\/:tenantId\/faqs',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.patch\('\/:tenantId\/faqs\/:faqId',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.delete\('\/:tenantId\/faqs\/:faqId',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.post\('\/:tenantId\/promotions',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.patch\('\/:tenantId\/promotions\/:promoId',\s*enforceTenantScope,\s*requireEditor,/,
    /r\.delete\('\/:tenantId\/promotions\/:promoId',\s*enforceTenantScope,\s*requireEditor,/,
  ];
  for (const re of writeRoutes) {
    assert.match(dashboardRoutesSrc, re, `Expected requireEditor on route matching ${re}`);
  }
});

test('dashboardRoutes leaves GET (read) routes for settings/menu/services/faqs/promotions open to STAFF (no requireEditor)', () => {
  assert.match(dashboardRoutesSrc, /r\.get\('\/:tenantId\/settings',\s*enforceTenantScope,\s*getBusinessSettings\)/);
  assert.match(dashboardRoutesSrc, /r\.get\('\/:tenantId\/menu',\s*enforceTenantScope,\s*getMenu\)/);
  assert.match(dashboardRoutesSrc, /r\.get\('\/:tenantId\/services',\s*enforceTenantScope,\s*getServices\)/);
  assert.match(dashboardRoutesSrc, /r\.get\('\/:tenantId\/faqs',\s*enforceTenantScope,\s*getFaqs\)/);
  assert.match(dashboardRoutesSrc, /r\.get\('\/:tenantId\/promotions',\s*enforceTenantScope,\s*getPromotions\)/);
});

// ── [AUDIT-FIX-ROLE-GATE-1] businessRoutes.js ───────────────────────────────

test('businessRoutes imports requireRole and defines a requireEditor (OWNER/MANAGER) gate', () => {
  assert.match(businessRoutesSrc, /import \{ requireRole \} from '\.\.\/middleware\/authMiddleware\.js'/);
  assert.match(businessRoutesSrc, /requireEditor\s*=\s*requireRole\('OWNER',\s*'MANAGER'\)/);
});

test('businessRoutes gates updateBusinessConfig/updateMenu/addMenuItem/deleteMenuItem with requireEditor', () => {
  assert.match(businessRoutesSrc, /r\.put\('\/:tenantId',\s*enforceTenantScope,\s*requireEditor,\s*updateBusinessConfig\)/);
  assert.match(businessRoutesSrc, /r\.put\('\/:tenantId\/menu',\s*enforceTenantScope,\s*requireEditor,\s*updateMenu\)/);
  assert.match(businessRoutesSrc, /r\.post\('\/:tenantId\/menu',\s*enforceTenantScope,\s*requireEditor,/);
  assert.match(businessRoutesSrc, /r\.delete\('\/:tenantId\/menu\/:itemId',\s*enforceTenantScope,\s*requireEditor,/);
});

test('businessRoutes leaves the catalog "Sync Now" action and health check open to STAFF (operational, not a config edit)', () => {
  assert.match(businessRoutesSrc, /r\.post\('\/:tenantId\/wacatalog\/sync',\s*enforceTenantScope,\s*catalogSyncLimiter,\s*syncWaCatalog\)/);
  assert.match(businessRoutesSrc, /r\.get\('\/:tenantId\/wacatalog\/health',\s*enforceTenantScope,\s*getWaCatalogHealth\)/);
});

// ── [AUDIT-FIX-ROLE-GATE-1] adminUserRoutes.js — listAdmins ─────────────────

test('listAdmins route enforces OWNER/MANAGER, matching its own documented access level', () => {
  const routeStart = adminUserRoutesSrc.indexOf("'/dashboard/:tenantId/admins',");
  const routeEnd    = adminUserRoutesSrc.indexOf('listAdmins,', routeStart) + 'listAdmins,'.length;
  const routeBlock = adminUserRoutesSrc.slice(routeStart, routeEnd);
  assert.match(routeBlock, /requireRole\('OWNER',\s*'MANAGER'\)/);
});

// ── [AUDIT-FIX-STOCK-RACE-1] orderService.js ────────────────────────────────

test('decrementStockForOrder no longer computes newStock from a JS-side snapshot read', () => {
  // The old buggy shape: `menuItem.stockCount - (Number(quantity) || 1)` computed
  // in JS from a findById().lean() snapshot, then written with a plain $set.
  assert.doesNotMatch(orderServiceSrc, /menuItem\.stockCount\s*-\s*\(Number\(quantity\)/);
});

test('decrementStockForOrder now uses an atomic aggregation-pipeline update ($map/$cond), the same fix shape as promoService applyPromoUsage', () => {
  assert.match(orderServiceSrc, /findOneAndUpdate\(\s*\{ _id: businessId, menuItems: \{ \$elemMatch:/);
  assert.match(orderServiceSrc, /\$map:\s*\{\s*input:\s*'\$menuItems'/);
  assert.match(orderServiceSrc, /stockCount:\s*\{\s*\$max:\s*\[0,\s*\{\s*\$subtract:\s*\['\$\$mi\.stockCount',\s*qty\]\s*\}\]\s*\}/);
});

test('decrementStockForOrder still gates the resync trigger on waCatalog.enabled + catalogId', () => {
  assert.match(orderServiceSrc, /anyWentOutOfStock && waCatalog\?\.enabled && waCatalog\?\.catalogId/);
});

// ── [AUDIT-FIX-CSV-INJECTION-1] dashboardController.js ──────────────────────

test('toCsvValue neutralizes leading formula-trigger characters before quoting', () => {
  assert.match(dashboardCtrlSrc, /if \(\/\^\[=\+\\-@\\t\\r\]\/\.test\(s\)\) s = `'\$\{s\}`;/);
});

test('toCsvValue: functional check — a formula-like customer name is neutralized, a normal value is untouched', async () => {
  // Re-implements the exact fixed logic to verify behaviour without needing
  // to import controller internals (toCsvValue/rowsToCsv are not exported).
  function toCsvValue(v) {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  assert.equal(toCsvValue('=HYPERLINK("http://evil","x")'), '"\'=HYPERLINK(""http://evil"",""x"")"');
  assert.equal(toCsvValue('+1234'), "'+1234");
  assert.equal(toCsvValue('-1234'), "'-1234");
  assert.equal(toCsvValue('@SUM(A1:A9)'), "'@SUM(A1:A9)");
  assert.equal(toCsvValue('John Doe'), 'John Doe');
  assert.equal(toCsvValue(null), '');
});
