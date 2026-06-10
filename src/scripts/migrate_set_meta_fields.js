/**
 * scripts/migrate_set_meta_fields.js
 *
 * One-time migration: populate meta.appId and meta.appSecret on all existing
 * tenant documents that currently rely on the global META_APP_SECRET env var.
 *
 * WHEN TO RUN:
 *   After deploying the multi-tenant credential upgrade, run this script ONCE
 *   to seed the new meta fields from environment variables. After migration,
 *   each tenant has their own credentials and META_APP_SECRET becomes optional.
 *
 * WHAT IT DOES:
 *   1. Reads META_APP_ID and META_APP_SECRET from environment.
 *   2. Finds all tenants where meta.appSecret is null/unset.
 *   3. Encrypts the app secret and writes meta.appId + meta.appSecret to each.
 *   4. Prints a summary — no data is deleted, all operations are additive.
 *
 * SAFETY:
 *   - Only writes to tenants where meta.appSecret is currently null.
 *   - Existing per-tenant secrets are NEVER overwritten.
 *   - Can be re-run safely — idempotent.
 *
 * USAGE:
 *   MONGODB_URI=... ENCRYPTION_KEY=... META_APP_ID=... META_APP_SECRET=... \
 *     node --experimental-vm-modules src/scripts/migrate_set_meta_fields.js
 *
 *   Or with dotenv:
 *     node -r dotenv/config src/scripts/migrate_set_meta_fields.js
 */

import { config } from 'dotenv';
config({ path: '.env' });

import mongoose from 'mongoose';
import crypto   from 'crypto';

const MONGODB_URI    = process.env.MONGODB_URI;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const META_APP_ID    = process.env.META_APP_ID    || null;
const META_APP_SECRET = process.env.META_APP_SECRET || null;

if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI not set');
  process.exit(1);
}

if (!META_APP_SECRET) {
  console.warn('⚠  META_APP_SECRET not set — meta.appSecret will not be populated.');
  console.warn('   Tenants without a stored appSecret will use no-secret fallback for signature verification.');
}

// ── Encryption (mirrors tenantController.js) ──────────────────────────────────
function getEncryptionKey() {
  if (!ENCRYPTION_KEY) return null;
  return crypto.createHash('sha256').update(ENCRYPTION_KEY, 'utf8').digest();
}

function encryptToken(plaintext) {
  if (!plaintext) return plaintext;
  const key = getEncryptionKey();
  if (!key) {
    console.warn('⚠  ENCRYPTION_KEY not set — storing appSecret in plaintext');
    return plaintext;
  }
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

// ── Minimal Tenant schema for migration ──────────────────────────────────────
const tenantSchema = new mongoose.Schema({
  meta: {
    appId:     { type: String, default: null },
    appSecret: { type: String, default: null },
  },
}, { strict: false, collection: 'tenants' });

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const Tenant = mongoose.model('TenantMigration', tenantSchema);

  // Find tenants without a per-tenant appSecret
  const tenants = await Tenant.find({
    $or: [
      { 'meta.appSecret': null },
      { 'meta.appSecret': { $exists: false } },
    ],
  }).select('_id name meta').lean();

  console.log(`Found ${tenants.length} tenant(s) without meta.appSecret`);

  if (!tenants.length) {
    console.log('✓ Nothing to migrate — all tenants already have meta.appSecret');
    await mongoose.disconnect();
    return;
  }

  const encryptedSecret = META_APP_SECRET ? encryptToken(META_APP_SECRET) : null;
  let migrated = 0;
  let skipped  = 0;

  for (const t of tenants) {
    const setFields = {};
    if (META_APP_ID    && !t.meta?.appId)     setFields['meta.appId']     = META_APP_ID;
    if (encryptedSecret && !t.meta?.appSecret) setFields['meta.appSecret'] = encryptedSecret;

    if (!Object.keys(setFields).length) {
      console.log(`  — Skipping ${t.name || t._id} (nothing to set)`);
      skipped++;
      continue;
    }

    await Tenant.updateOne({ _id: t._id }, { $set: setFields });
    console.log(`  ✓ Migrated ${t.name || t._id}`);
    migrated++;
  }

  console.log(`\nMigration complete: ${migrated} migrated, ${skipped} skipped`);

  if (migrated > 0) {
    console.log('\nNext steps:');
    console.log('  1. Verify tenants in the admin dashboard.');
    console.log('  2. Once all tenants have per-tenant credentials, META_APP_SECRET in .env becomes optional.');
    console.log('  3. For tenants that use a DIFFERENT Meta App, update via:');
    console.log('     PATCH /api/admin/tenants/:id  { "meta.appId": "...", "meta.appSecret": "..." }');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
