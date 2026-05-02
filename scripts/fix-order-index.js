/**
 * scripts/fix-order-index.js — WhatsBotLyn v3.1 one-time migration
 *
 * PROBLEM:
 *   The `orders` collection has a unique index on:
 *     (tenantId, customerPhone, idempotencyKey)
 *   But `idempotencyKey` was never set in the application code, so every
 *   insert had idempotencyKey: null.  MongoDB treats all nulls as equal,
 *   so the SECOND order from any customer always hit E11000 duplicate key,
 *   causing the "We're having a little trouble right now" error.
 *
 * FIX (run once):
 *   1. Drops the stale index (which only works when the field is null).
 *   2. Backfills existing orders with a unique idempotencyKey (UUID).
 *   3. Mongoose recreates the index correctly on next app start because
 *      Order.js now declares it — and the default: randomUUID() ensures
 *      new orders are never null.
 *
 * USAGE:
 *   node scripts/fix-order-index.js
 *
 * Safe to run multiple times — it checks for the index before dropping.
 */

import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.development.local' });
if (process.env.NODE_ENV === 'production') {
  dotenv.config({ path: '.env.production.local', override: true });
}

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌  MONGODB_URI not set. Check your .env file.');
  process.exit(1);
}

async function run() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('✅  Connected.');

  const db         = mongoose.connection.db;
  const collection = db.collection('orders');

  // ── 1. Drop the stale index ──────────────────────────────────────────────
  const indexes = await collection.indexes();
  const staleIndex = indexes.find(
    (idx) =>
      idx.unique &&
      idx.key?.tenantId === 1 &&
      idx.key?.customerPhone === 1 &&
      idx.key?.idempotencyKey === 1,
  );

  if (staleIndex) {
    console.log(`Dropping stale index: ${staleIndex.name}`);
    await collection.dropIndex(staleIndex.name);
    console.log('✅  Stale index dropped.');
  } else {
    console.log('ℹ️   Stale index not found — already dropped or never existed.');
  }

  // ── 2. Backfill existing orders that have no idempotencyKey ─────────────
  const missing = await collection.countDocuments({
    $or: [{ idempotencyKey: null }, { idempotencyKey: { $exists: false } }],
  });

  if (missing > 0) {
    console.log(`Backfilling ${missing} order(s) with unique idempotencyKey…`);

    const cursor = collection.find({
      $or: [{ idempotencyKey: null }, { idempotencyKey: { $exists: false } }],
    });

    let updated = 0;
    for await (const doc of cursor) {
      await collection.updateOne(
        { _id: doc._id },
        { $set: { idempotencyKey: randomUUID() } },
      );
      updated++;
    }

    console.log(`✅  Backfilled ${updated} order(s).`);
  } else {
    console.log('ℹ️   All orders already have an idempotencyKey.');
  }

  // ── 3. Recreate the index correctly (with sparse: false, unique: true) ───
  console.log('Recreating index (tenantId + customerPhone + idempotencyKey, unique)…');
  await collection.createIndex(
    { tenantId: 1, customerPhone: 1, idempotencyKey: 1 },
    { unique: true, name: 'tenantId_1_customerPhone_1_idempotencyKey_1' },
  );
  console.log('✅  Index recreated.');

  await mongoose.disconnect();
  console.log('\n🎉  Migration complete. Start the app normally.');
}

run().catch((err) => {
  console.error('❌  Migration failed:', err.message);
  process.exit(1);
});
