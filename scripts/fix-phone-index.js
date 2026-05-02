/**
 * scripts/fix-phone-index.js
 *
 * One-time migration: drop the stale non-sparse unique index on
 * `whatsapp.phoneNumberId` so Mongoose can recreate it as sparse.
 *
 * WHY THIS IS NEEDED:
 *   The Tenant schema declares:
 *     phoneNumberId: { unique: true, sparse: true, default: null }
 *
 *   BUT if this index was created before `sparse: true` was added,
 *   MongoDB still holds the OLD non-sparse unique index in place.
 *   Non-sparse unique indexes treat every null as a distinct value to
 *   enforce uniqueness on — meaning only ONE document can have null.
 *   Every subsequent /register call fails with E11000.
 *
 *   Sparse unique indexes ignore null/undefined entirely, so any number
 *   of PENDING tenants can have phoneNumberId: null simultaneously.
 *
 * HOW TO RUN (once, then restart the server):
 *   node scripts/fix-phone-index.js
 *
 * SAFE TO RE-RUN: idempotent — if the index doesn't exist, it logs and exits cleanly.
 */

import mongoose from 'mongoose';
import { config } from 'dotenv';

config(); // load .env

const MONGO_URI  = process.env.MONGO_URI || process.env.MONGODB_URI;
const INDEX_NAME = 'whatsapp.phoneNumberId_1'; // default Mongoose-generated name

if (!MONGO_URI) {
  console.error('❌  MONGO_URI not set. Add it to your .env file.');
  process.exit(1);
}

async function run() {
  console.log('🔌  Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('✅  Connected.');

  const db         = mongoose.connection.db;
  const collection = db.collection('tenants');

  // ── 1. List current indexes ───────────────────────────────────────────────
  const indexes = await collection.indexes();
  const target  = indexes.find((idx) => idx.name === INDEX_NAME);

  if (!target) {
    console.log(`ℹ️   Index "${INDEX_NAME}" not found — nothing to do.`);
    console.log('    (Mongoose will create the correct sparse index on next startup.)');
    await mongoose.disconnect();
    return;
  }

  const isSparse = target.sparse === true;

  if (isSparse) {
    console.log(`✅  Index "${INDEX_NAME}" already sparse — no action needed.`);
    await mongoose.disconnect();
    return;
  }

  // ── 2. Drop the stale non-sparse index ───────────────────────────────────
  console.log(`⚠️   Found non-sparse unique index: ${JSON.stringify(target, null, 2)}`);
  console.log(`🗑️   Dropping "${INDEX_NAME}"…`);

  await collection.dropIndex(INDEX_NAME);
  console.log(`✅  Index "${INDEX_NAME}" dropped.`);

  // ── 3. Let Mongoose recreate it correctly ─────────────────────────────────
  // Import the Tenant model so Mongoose runs syncIndexes
  const { default: Tenant } = await import('../models/Tenant.js');
  await Tenant.syncIndexes();
  console.log('✅  Indexes synced — sparse unique index recreated.');

  // ── 4. Verify ─────────────────────────────────────────────────────────────
  const after = await collection.indexes();
  const recreated = after.find((idx) => idx.name === INDEX_NAME);
  if (recreated?.sparse) {
    console.log('🎉  Verified: index is now sparse. You are good to go!');
  } else {
    console.warn('⚠️   Index recreated but sparse flag not confirmed. Check manually:');
    console.warn(JSON.stringify(recreated, null, 2));
  }

  await mongoose.disconnect();
  console.log('🔌  Disconnected. Restart your server now.');
}

run().catch((err) => {
  console.error('❌  Migration failed:', err.message);
  process.exit(1);
});
