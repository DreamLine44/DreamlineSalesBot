/**
 * scripts/migrate_remove_raw_api_keys.js
 *
 * ONE-TIME MIGRATION — run once after deploying the FIX-RAWKEY changes.
 *
 * What it does:
 *   Removes the plaintext `apiKey` field from every Tenant document.
 *   After this migration, auth lookups use only `apiKeyHash` (SHA-256).
 *
 * Safety:
 *   - Read-only dry-run by default. Pass --apply to commit changes.
 *   - Skips tenants that already have no apiKey (idempotent).
 *   - Logs every tenant affected.
 *
 * Usage:
 *   node scripts/migrate_remove_raw_api_keys.js          # dry-run
 *   node scripts/migrate_remove_raw_api_keys.js --apply  # live run
 *
 * Prerequisites:
 *   MONGODB_URI must be set in your environment (same as production).
 */

import '../config/env.js';
import mongoose from 'mongoose';
import Tenant   from '../models/Tenant.js';
import logger   from '../config/logger.js';

const DRY_RUN = !process.argv.includes('--apply');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  logger.info(`[Migration] Connected to MongoDB — mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  // Find every tenant that still has a plaintext apiKey stored
  const affected = await Tenant.find(
    { apiKey: { $exists: true } },
    { _id: 1, name: 1, apiKey: 1, apiKeyHash: 1 },
  ).lean();

  logger.info(`[Migration] Tenants with plaintext apiKey: ${affected.length}`);

  if (affected.length === 0) {
    logger.info('[Migration] Nothing to do — all tenants already migrated.');
    await mongoose.disconnect();
    return;
  }

  for (const t of affected) {
    // Guard: if apiKeyHash is missing (should not happen) we cannot safely remove apiKey.
    // The auth middleware would lock out this tenant. Skip with a warning.
    if (!t.apiKeyHash) {
      logger.warn(`[Migration] SKIP tenant ${t._id} (${t.name}) — apiKeyHash missing, manual review required`);
      continue;
    }

    if (DRY_RUN) {
      logger.info(`[Migration] [DRY RUN] Would $unset apiKey on tenant ${t._id} (${t.name})`);
    } else {
      await Tenant.updateOne({ _id: t._id }, { $unset: { apiKey: '' } });
      logger.info(`[Migration] $unset apiKey on tenant ${t._id} (${t.name})`);
    }
  }

  if (DRY_RUN) {
    logger.info('[Migration] Dry run complete. Re-run with --apply to commit changes.');
  } else {
    logger.info('[Migration] Migration complete. All plaintext apiKey fields removed.');
  }

  await mongoose.disconnect();
}

run().catch(err => {
  logger.error('[Migration] Fatal', { err: err.message });
  process.exit(1);
});
