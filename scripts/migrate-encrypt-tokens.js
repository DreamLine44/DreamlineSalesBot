/**
 * scripts/migrate-encrypt-tokens.js — Dreamline Sales Bot v11.0
 *
 * One-time migration: encrypts plaintext WhatsApp accessTokens in
 * the Tenant collection using AES-256-GCM.
 *
 * Usage:
 *   node scripts/migrate-encrypt-tokens.js
 *
 * Prerequisites:
 *   - ENCRYPTION_KEY env var must be set (64 hex chars)
 *   - MONGODB_URI env var must point to your database
 *
 * Safety:
 *   - Skips already-encrypted tokens (idempotent)
 *   - Dry-run mode: set DRY_RUN=true to preview without writing
 *   - Logs every tenant processed
 *
 * After running:
 *   - Set TOKEN_ENCRYPTION_ENABLED=true in your env
 *   - New tokens written by the app will be auto-encrypted
 */

import '../config/env.js';
import { connectToDB } from '../config/database.js';
import Tenant from '../models/Tenant.js';
import { encrypt, isEncrypted } from '../services/cryptoService.js';
import logger from '../config/logger.js';

const DRY_RUN = process.env.DRY_RUN === 'true';

async function run() {
  if (!process.env.ENCRYPTION_KEY) {
    console.error('ERROR: ENCRYPTION_KEY env var is required. Generate one with:');
    console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }

  await connectToDB();

  const tenants = await Tenant.find({
    'whatsapp.accessToken': { $exists: true, $ne: null, $ne: '' },
  }).select('_id whatsapp.accessToken name');

  console.log(`Found ${tenants.length} tenants with accessTokens.`);
  if (DRY_RUN) console.log('DRY RUN — no changes will be written.');

  let encrypted = 0;
  let skipped   = 0;
  let errors    = 0;

  for (const tenant of tenants) {
    const token = tenant.whatsapp?.accessToken;
    if (!token) { skipped++; continue; }

    if (isEncrypted(token)) {
      console.log(`  [SKIP] ${tenant._id} (${tenant.name || 'unnamed'}) — already encrypted`);
      skipped++;
      continue;
    }

    try {
      const encryptedToken = encrypt(token);

      if (!DRY_RUN) {
        await Tenant.updateOne(
          { _id: tenant._id },
          { $set: { 'whatsapp.accessToken': encryptedToken } }
        );
      }

      console.log(`  [OK]   ${tenant._id} (${tenant.name || 'unnamed'}) — encrypted`);
      encrypted++;
    } catch (err) {
      console.error(`  [ERR]  ${tenant._id} — ${err.message}`);
      errors++;
    }
  }

  console.log('\nMigration complete:');
  console.log(`  Encrypted: ${encrypted}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Errors:    ${errors}`);

  if (!DRY_RUN && encrypted > 0) {
    console.log('\nNext steps:');
    console.log('  1. Set TOKEN_ENCRYPTION_ENABLED=true in your .env');
    console.log('  2. Restart the server');
    console.log('  3. Verify bot is sending messages correctly for 1 tenant before proceeding');
  }

  process.exit(errors > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
