/**
 * scripts/migrate_reset_optimistic_catalog_confirm.js
 *
 * [FIX-CATALOG-OPTIMISTIC-CONFIRM] One-time cleanup migration — REQUIRED
 * alongside the code deploy, not optional.
 *
 * WHY:
 *   Before this fix, syncMenuToCatalog() wrote EVERY current item's
 *   retailer_id/hash into waCatalog.syncedRetailerIds / syncedItemHashes the
 *   instant Meta's items_batch POST returned 200 — but 200 only means the
 *   batch was ACCEPTED, not that every item passed Meta's validation. A tenant
 *   whose batch had e.g. 15 of 25 items rejected still got all 25 marked
 *   "synced," permanently, since the next sync's delta-hash diff sees no
 *   change for those 15 and never re-attempts them.
 *
 *   The code fix (see waCatalogService.js) stops this going forward — but it
 *   does nothing for tenants who ALREADY have this false-positive data sitting
 *   in Mongo. Deploying the new code without running this migration means
 *   buildCategorizedSections()'s new confirmed-only filter (waCatalogHelpers.js)
 *   will keep trusting the same wrong syncedRetailerIds list, and customer
 *   sends will keep hitting GRAPH_ERROR 400 #131009 exactly as before.
 *
 * WHAT IT DOES:
 *   For every tenant with waCatalog.enabled and a catalogId configured:
 *     1. Calls Meta's Graph API to get the catalog's live product_count.
 *     2. Compares it against the LOCAL syncedRetailerIds count.
 *     3. If they don't match (the false-positive signature), resets
 *        syncedRetailerIds / syncedItemHashes / pendingBatchHandles to empty
 *        so the next syncMenuToCatalog() run treats every item as "changed"
 *        and re-uploads + re-verifies all of them from scratch under the
 *        new confirm-only logic.
 *   Tenants whose local count already matches Meta's live count are left
 *   untouched — they were never affected by the bug.
 *
 * SAFETY:
 *   - Dry-run by default: prints what WOULD change, writes nothing.
 *   - Pass --apply to actually perform the reset.
 *   - Never touches menuItems or any other tenant data — only the three
 *     waCatalog.* sync-bookkeeping fields listed above.
 *   - Idempotent — safe to re-run; a tenant fixed on run 1 is a no-op on run 2.
 *   - Read-only Graph API calls (GET on the catalog node) — never deletes or
 *     modifies anything in Meta's Commerce Manager.
 *
 * USAGE:
 *   Dry run (default, no writes):
 *     MONGODB_URI=... node -r dotenv/config src/scripts/migrate_reset_optimistic_catalog_confirm.js
 *
 *   Apply for real:
 *     MONGODB_URI=... node -r dotenv/config src/scripts/migrate_reset_optimistic_catalog_confirm.js --apply
 *
 *   Single tenant only (recommended first pass in production):
 *     ... migrate_reset_optimistic_catalog_confirm.js --apply --tenant=<tenantId>
 */

import { config } from 'dotenv';
config({ path: '.env' });

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const APPLY = process.argv.includes('--apply');
const TENANT_ARG = process.argv.find(a => a.startsWith('--tenant='));
const ONLY_TENANT = TENANT_ARG ? TENANT_ARG.split('=')[1] : null;

if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI not set');
  process.exit(1);
}

const businessSchema = new mongoose.Schema({}, { strict: false, collection: 'businessconfigs' });

async function getLiveProductCount(catalogId, token) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${catalogId}?fields=product_count&access_token=${encodeURIComponent(token)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Graph API ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  return typeof json.product_count === 'number' ? json.product_count : null;
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to MongoDB${APPLY ? '' : ' (DRY RUN — pass --apply to write changes)'}`);

  const BusinessConfig = mongoose.model('BusinessConfigCatalogReset', businessSchema);

  const query = {
    'waCatalog.enabled': true,
    'waCatalog.catalogId': { $exists: true, $ne: null },
    ...(ONLY_TENANT ? { tenantId: ONLY_TENANT } : {}),
  };

  const tenants = await BusinessConfig.find(query)
    .select('_id tenantId name waCatalog.catalogId waCatalog.syncedRetailerIds credentials.whatsappToken metaAccessToken')
    .lean();

  console.log(`Found ${tenants.length} tenant(s) with WA Catalog enabled\n`);

  let affected = 0;
  let checked = 0;
  let skippedNoToken = 0;

  for (const t of tenants) {
    const catalogId = t.waCatalog?.catalogId;
    const localCount = (t.waCatalog?.syncedRetailerIds || []).length;
    // Token field name varies by how each tenant's credentials were stored —
    // adjust this line to match wherever the WhatsApp/system-user token
    // actually lives on your BusinessConfig if this doesn't resolve it.
    const token = t.credentials?.whatsappToken || t.metaAccessToken || process.env.META_SYSTEM_USER_TOKEN;

    if (!token) {
      console.log(`  ⚠ ${t.name || t.tenantId} — no access token resolvable, skipping (check manually)`);
      skippedNoToken++;
      continue;
    }

    let liveCount;
    try {
      liveCount = await getLiveProductCount(catalogId, token);
    } catch (err) {
      console.log(`  ⚠ ${t.name || t.tenantId} — Graph API check failed: ${err.message}`);
      continue;
    }
    checked++;

    if (liveCount === null) {
      console.log(`  ⚠ ${t.name || t.tenantId} — couldn't read product_count, skipping`);
      continue;
    }

    if (liveCount === localCount) {
      console.log(`  ✓ ${t.name || t.tenantId} — local ${localCount} matches Meta ${liveCount}, no action`);
      continue;
    }

    affected++;
    console.log(`  ✗ ${t.name || t.tenantId} — local claims ${localCount} synced, Meta actually has ${liveCount}. ${APPLY ? 'RESETTING.' : '(dry run — would reset)'}`);

    if (APPLY) {
      await BusinessConfig.updateOne(
        { _id: t._id },
        { $set: {
          'waCatalog.syncedRetailerIds': [],
          'waCatalog.syncedItemHashes': {},
          'waCatalog.pendingBatchHandles': [],
        } },
      );
    }
  }

  console.log(`\n${APPLY ? 'Reset' : 'Would reset'} ${affected} of ${checked} checked tenant(s) (${skippedNoToken} skipped — no token).`);
  if (!APPLY && affected) {
    console.log('Re-run with --apply to perform the reset, then trigger a fresh sync for each affected tenant.');
  }
  if (APPLY && affected) {
    console.log('Next step: trigger a fresh syncMenuToCatalog() run (POST /:tenantId/wacatalog/sync) for each reset tenant.');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
