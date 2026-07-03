/**
 * scripts/migrate_unset_null_email.js
 *
 * [FIX-EMAIL-SPARSE] One-time cleanup migration.
 *
 * WHY:
 *   Tenant.email used to have `default: null` alongside `sparse: true, unique:
 *   true`. Mongoose applies schema defaults on document construction regardless
 *   of what the caller sends, so every tenant created WITHOUT an email got an
 *   explicit `email: null` written to Mongo. A sparse index only excludes
 *   documents where the field is truly ABSENT — not ones where it's explicitly
 *   null — so every tenant after the first emailless one hit a false E11000
 *   duplicate-key error on that shared null value.
 *
 *   The schema default has been removed (see models/Tenant.js), which fixes
 *   things going forward. This script cleans up documents that already have
 *   the bad `email: null` stored, by $unset-ing the field so the sparse index
 *   stops tracking them.
 *
 * WHAT IT DOES:
 *   1. Finds all tenants where email is explicitly null (not just missing).
 *   2. $unset's the email field on those documents.
 *   3. Prints a summary. No other data is touched.
 *
 * SAFETY:
 *   - Only touches documents where email === null (never touches real emails).
 *   - Idempotent — safe to re-run; second run will find 0 documents.
 *
 * USAGE:
 *   MONGODB_URI=... node -r dotenv/config src/scripts/migrate_unset_null_email.js
 */

import { config } from 'dotenv';
config({ path: '.env' });

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI not set');
  process.exit(1);
}

const tenantSchema = new mongoose.Schema({
  email: { type: String, default: undefined },
}, { strict: false, collection: 'tenants' });

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const Tenant = mongoose.model('TenantEmailCleanup', tenantSchema);

  const affected = await Tenant.find({ email: null }).select('_id name').lean();
  console.log(`Found ${affected.length} tenant(s) with email explicitly set to null`);

  if (!affected.length) {
    console.log('✓ Nothing to migrate');
    await mongoose.disconnect();
    return;
  }

  for (const t of affected) {
    console.log(`  - ${t.name || t._id} (${t._id})`);
  }

  const result = await Tenant.updateMany(
    { email: null },
    { $unset: { email: '' } },
  );

  console.log(`\n✓ Cleaned up ${result.modifiedCount} tenant(s)`);
  console.log('  email field is now truly absent on these docs — sparse index will skip them.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
