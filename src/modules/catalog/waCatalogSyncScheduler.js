/**
 * modules/catalog/waCatalogSyncScheduler.js
 *
 * [CATALOG-AUTOSYNC-1] Debounced, automatic follow-up to the manual
 * POST /:tenantId/wacatalog/sync route (see [CATALOG-SYNC-ROUTE-1] in
 * businessController.js). Menu CRUD handlers (addMenuItem / updateMenuItem /
 * deleteMenuItem in dashboardController.js) call scheduleWaCatalogSync(tenantId)
 * on every successful write instead of syncing inline — inline syncing would
 * mean every single menu edit fires its own Graph API items_batch call, which
 * is both slow (blocks the HTTP response on an external network call) and a
 * fast way to hit Meta's rate limits when an admin is making several edits in
 * a row (e.g. fixing a typo, then price, then availability on the same item).
 *
 * Instead this keeps one pending timer per tenantId. Each new call resets that
 * tenant's timer, so a burst of edits collapses into exactly one sync, fired
 * DEBOUNCE_MS after the *last* edit in the burst — same idea as debouncing a
 * search-as-you-type input. Other tenants are unaffected; timers are keyed
 * per-tenantId so tenant A's edit burst never delays or coalesces with
 * tenant B's.
 *
 * Fully best-effort and silent: this is a background convenience, not a
 * request the admin is waiting on (they already got their 200/201 from the
 * CRUD call). Never throws outward, never blocks the caller — scheduling is
 * just a setTimeout() reset, and the actual sync runs later, off the request.
 */

import logger from '../../config/logger.js';

const DEBOUNCE_MS = Number(process.env.WA_CATALOG_AUTOSYNC_DEBOUNCE_MS) || 8000;

// tenantId (string) -> Node Timeout
const pendingTimers = new Map();

/**
 * scheduleWaCatalogSync(tenantId)
 * Call this from any menu-mutating handler after a successful DB write.
 * Safe to call unconditionally (i.e. even for tenants who don't have WA
 * Catalog enabled) — performSync() below checks waCatalog.enabled/catalogId
 * itself and is a no-op if either is missing, so callers don't need an extra
 * BusinessConfig read just to decide whether to schedule.
 */
export function scheduleWaCatalogSync(tenantId) {
  if (!tenantId) return;
  const key = String(tenantId);

  const existing = pendingTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingTimers.delete(key);
    performSync(key).catch(err => {
      // performSync() already catches/logs internally, but this is a final
      // safety net — an uncaught rejection inside a bare setTimeout callback
      // would otherwise crash the process.
      logger.error('[WACatalog] autosync scheduler unexpected error', { tenantId: key, err: err.message });
    });
  }, DEBOUNCE_MS);

  // Don't let a pending catalog sync keep the Node process alive on its own
  // (e.g. during graceful shutdown / test runs).
  if (typeof timer.unref === 'function') timer.unref();

  pendingTimers.set(key, timer);
}

/**
 * performSync(tenantId)
 * The deferred work a debounced call eventually runs. Mirrors the guard
 * logic in businessController.syncWaCatalog(), but logs instead of
 * responding to an HTTP caller, since there isn't one — this fires
 * asynchronously, well after the request that triggered it has returned.
 */
async function performSync(tenantId) {
  const { default: BusinessConfig } = await import('../../models/BusinessConfig.js');
  const business = await BusinessConfig.findOne({ tenantId }).lean();
  if (!business) return; // tenant/business deleted between edit and debounce firing

  if (!business.waCatalog?.enabled || !business.waCatalog?.catalogId) {
    // Not opted into WA Catalog — silently skip, exactly as the manual route
    // would 400 on this, except there's no caller here to hand a 400 to.
    return;
  }

  const { default: Tenant } = await import('../../models/Tenant.js');
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) return;

  const { syncMenuToCatalog } = await import('./waCatalogService.js');
  const result = await syncMenuToCatalog(business, tenant);

  if (!result.ok) {
    logger.warn('[WACatalog] autosync failed', { tenantId, reason: result.reason, status: result.status });
  } else {
    logger.info('[WACatalog] autosync completed', { tenantId, synced: result.synced, deleted: result.deleted || 0 });
  }
}

/**
 * clearAllScheduledSyncs()
 * Test/shutdown helper — cancels every pending timer without running them.
 * Not used by production request handlers.
 */
export function clearAllScheduledSyncs() {
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
}

/**
 * hasScheduledSync(tenantId)
 * Test helper — lets tests assert a debounce timer was (or wasn't) armed
 * without waiting out the real debounce window.
 */
export function hasScheduledSync(tenantId) {
  return pendingTimers.has(String(tenantId));
}
