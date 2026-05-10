/**
 * scripts/migrate-apikey-hash.js
 *
 * ONE-TIME migration: hashes all plain-text apiKey values in the Tenant
 * collection to SHA-256 and stores them in the separate `apiKeyHash` field,
 * matching the storage format expected by authMiddleware.js.
 *
 * Run ONCE after deploying the v6 model change, before restarting the server:
 *   node scripts/migrate-apikey-hash.js
 *
 * IMPORTANT:
 *   - The plain-text `apiKey` field is LEFT INTACT so tenants who haven't
 *     updated their client apps yet continue to work during the transition.
 *     The middleware does a hash-first lookup and falls back to plain-text
 *     until APIKEY_MIGRATION_DONE=true is set in your env.
 *   - The script is idempotent — records already having `apiKeyHash` set
 *     are skipped on subsequent runs.
 *   - Take a MongoDB backup before running in production.
 *
 * STORAGE LAYOUT (must match authMiddleware.js):
 *   apiKey     — original plain-text key (retained for fallback, never compared directly)
 *   apiKeyHash — SHA-256 hex digest of apiKey (primary lookup field)
 *
 * After all tenants have been verified to work with the hashed flow, you may
 * set APIKEY_MIGRATION_DONE=true to disable the plain-text fallback and
 * optionally drop the apiKey field entirely.
 */

import '../config/env.js';
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { connectToDB } from '../config/database.js';

async function migrate() {
  await connectToDB();

  const db = mongoose.connection.db;
  const collection = db.collection('tenants');

  // Only process records that don't yet have an apiKeyHash.
  // We do NOT filter by apiKeyHashed:true — that flag belonged to the old
  // incompatible scheme where the hash overwrote apiKey. The authoritative
  // signal is apiKeyHash presence.
  const cursor = collection.find({ apiKeyHash: { $exists: false } });
  let migrated = 0;
  let skipped  = 0;

  for await (const doc of cursor) {
    if (!doc.apiKey) { skipped++; continue; }

    // Hash stored in apiKeyHash; plain-text apiKey is intentionally kept intact
    // so the middleware's plaintext fallback continues to work during the transition.
    const hashed = createHash('sha256').update(doc.apiKey).digest('hex');
    await collection.updateOne(
      { _id: doc._id },
      { $set: { apiKeyHash: hashed } }  // write to apiKeyHash — never overwrite apiKey
    );
    migrated++;
  }

  console.log(`Migration complete. Migrated: ${migrated}, Skipped (no apiKey): ${skipped}`);
  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
