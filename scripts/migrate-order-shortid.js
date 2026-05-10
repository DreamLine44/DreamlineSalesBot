/**
 * scripts/migrate-order-shortid.js
 *
 * ONE-TIME migration: back-fills the `shortId` field on all existing Order
 * documents that were created before the shortId field was added.
 *
 * `shortId` = last 6 hex characters of the Order's `_id`, stored uppercase.
 * New orders have it populated automatically by the Order pre-save hook.
 *
 * Run ONCE after deploying the Order model change:
 *   node scripts/migrate-order-shortid.js
 *
 * The script is idempotent — documents that already have `shortId` are skipped.
 * Take a MongoDB backup before running in production.
 */

import '../config/env.js';
import mongoose from 'mongoose';
import { connectToDB } from '../config/database.js';

async function migrate() {
  await connectToDB();

  const db         = mongoose.connection.db;
  const collection = db.collection('orders');

  // Only back-fill documents that don't yet have shortId
  const cursor = collection.find({ shortId: { $exists: false } }, { projection: { _id: 1 } });
  let migrated = 0;

  for await (const doc of cursor) {
    const shortId = String(doc._id).slice(-6).toUpperCase();
    await collection.updateOne(
      { _id: doc._id },
      { $set: { shortId } }
    );
    migrated++;
  }

  console.log(`Migration complete. Back-filled shortId on ${migrated} order(s).`);
  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
