/**
 * scripts/migrate_backfill_payment_enabled.js
 *
 * One-time migration: backfill BusinessConfig.payment.enabled on tenants
 * whose document predates the [FIX-D] schema fix (see models/BusinessConfig.js)
 * and therefore has no `enabled` field stored at all.
 *
 * WHY THIS IS NEEDED:
 *   payment.enabled is the master switch every vertical order flow
 *   (restaurant/bakery/retail/fashion/salon/cosmetics/electronics/delivery)
 *   and waCatalogFlow.js's multi-item cart handler check via `payment?.enabled`
 *   before ever asking a customer for payment proof. It was added to the
 *   schema after some tenants were already created — those older documents
 *   have no `enabled` key in `payment` at all (not `false` — genuinely
 *   absent), which every `payment?.enabled` check reads as falsy. A tenant
 *   with a wavePhone / payment channels configured but no explicit `enabled`
 *   value is almost certainly meant to have payment ON, not silently
 *   defaulted to cash-only.
 *
 * WHAT IT DOES:
 *   1. Finds every BusinessConfig where payment.enabled does not exist.
 *   2. For each one, infers intent from EXISTING payment config:
 *        - has a non-empty wavePhone, OR
 *        - has at least one entry in payment.channels
 *      → sets payment.enabled = true
 *      Otherwise (no payment method configured at all) → sets
 *      payment.enabled = false, matching the schema's own default and
 *      genuinely meaning "this tenant never set up payment."
 *   3. Prints a per-tenant summary of what was set and why — nothing is
 *      silently changed without a printed reason.
 *
 * SAFETY:
 *   - Only touches documents where payment.enabled is currently MISSING
 *     ({ $exists: false }) — a tenant who already has an explicit
 *     true/false value (including one who was deliberately toggled off) is
 *     never touched.
 *   - Idempotent — re-running finds nothing left to migrate.
 *   - Supports --dry-run to preview changes with zero writes.
 *
 * USAGE:
 *   MONGODB_URI=... node scripts/migrate_backfill_payment_enabled.js --dry-run
 *   MONGODB_URI=... node scripts/migrate_backfill_payment_enabled.js
 */

import { config } from 'dotenv';
config({ path: '.env' });

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;
const DRY_RUN = process.argv.includes('--dry-run');

if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI not set');
  process.exit(1);
}

// Minimal, permissive schema — strict:false so this only ever reads/writes
// the exact fields it needs, and never risks dropping unrelated data on
// tenants whose live document has fields not modeled here.
const businessConfigSchema = new mongoose.Schema(
  {
    name: String,
    tenantId: mongoose.Schema.Types.ObjectId,
    payment: {
      enabled: Boolean,
      wavePhone: String,
      channels: [mongoose.Schema.Types.Mixed],
    },
  },
  { strict: false, collection: 'businessconfigs' },
);

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to MongoDB${DRY_RUN ? ' (DRY RUN — no writes will be made)' : ''}`);

  const BusinessConfig = mongoose.model('BusinessConfigMigration', businessConfigSchema);

  const candidates = await BusinessConfig.find({
    'payment.enabled': { $exists: false },
  })
    .select('_id name tenantId payment')
    .lean();

  console.log(`Found ${candidates.length} tenant(s) with no payment.enabled field set`);

  if (!candidates.length) {
    console.log('✓ Nothing to migrate — every tenant already has an explicit payment.enabled value');
    await mongoose.disconnect();
    return;
  }

  let setTrue = 0;
  let setFalse = 0;

  for (const biz of candidates) {
    const hasWave = !!(biz.payment?.wavePhone && String(biz.payment.wavePhone).trim());
    const hasChannels = Array.isArray(biz.payment?.channels) && biz.payment.channels.length > 0;
    const inferEnabled = hasWave || hasChannels;

    const reason = inferEnabled
      ? `wavePhone=${hasWave ? biz.payment.wavePhone : '—'} channels=${biz.payment?.channels?.length || 0}`
      : 'no payment method configured';

    console.log(
      `  ${inferEnabled ? '✓ enabled=true ' : '— enabled=false'}  ` +
      `${biz.name || biz._id} (tenantId ${biz.tenantId || 'n/a'}) — ${reason}`,
    );

    if (!DRY_RUN) {
      await BusinessConfig.updateOne(
        { _id: biz._id },
        { $set: { 'payment.enabled': inferEnabled } },
      );
    }

    if (inferEnabled) setTrue++; else setFalse++;
  }

  console.log(
    `\n${DRY_RUN ? '[DRY RUN] Would migrate' : 'Migration complete'}: ` +
    `${setTrue} set to enabled=true, ${setFalse} set to enabled=false ` +
    `(${candidates.length} total)`,
  );

  if (!DRY_RUN && setTrue > 0) {
    console.log('\nNext steps:');
    console.log('  1. Spot-check a couple of the enabled=true tenants in the admin dashboard');
    console.log('     to confirm payment really should be on for them.');
    console.log('  2. Any tenant that should stay cash-only can be flipped back with:');
    console.log('     PATCH /business/:tenantId  { "payment.enabled": false }');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
