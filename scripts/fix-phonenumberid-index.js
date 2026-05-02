/**
 * scripts/fix-phonenumberid-index.js
 *
 * ONE-TIME migration — run this ONCE after deploying the Tenant.js model fix.
 *
 * PROBLEM:
 *   The Tenant model had `default: null` on `whatsapp.phoneNumberId` alongside
 *   `sparse: true` + `unique: true`. MongoDB's sparse index skips documents where
 *   the field is *absent* (undefined), but Mongoose's `default: null` writes null
 *   explicitly to every new document — so MongoDB indexes every null, and the unique
 *   constraint treats all PENDING tenants (who haven't connected WhatsApp yet) as
 *   duplicates of each other → E11000 on every second registration.
 *
 * FIX:
 *   1. Drop the old index (which has null entries baked in).
 *   2. Clear the stale null values from existing documents so they become undefined.
 *   3. Let Mongoose/MongoDB recreate the index cleanly on next app start.
 *      The recreated index will be truly sparse — it skips all docs where the field
 *      is now absent.
 *
 * USAGE:
 *   node scripts/fix-phonenumberid-index.js
 *
 * Safe to run multiple times — checks before dropping.
 */

import '../config/env.js';
import mongoose from 'mongoose';
import { connectToDB } from '../config/database.js';
import logger from '../config/logger.js';

async function run() {
  await connectToDB();

  const collection = mongoose.connection.collection('tenants');

  // ── Step 1: Drop the old broken index ───────────────────────────────────────
  try {
    const indexes = await collection.indexes();
    const badIndex = indexes.find(
      (idx) => idx.key?.['whatsapp.phoneNumberId'] !== undefined
    );

    if (badIndex) {
      await collection.dropIndex(badIndex.name);
      logger.info(`[Migration] Dropped broken index: ${badIndex.name}`);
    } else {
      logger.info('[Migration] Index not found — already clean or already dropped.');
    }
  } catch (err) {
    logger.error('[Migration] Failed to drop index:', err.message);
    process.exit(1);
  }

  // ── Step 2: Unset null phoneNumberId on existing PENDING tenants ─────────────
  // Documents with null stored will still be treated as having the field present
  // until we explicitly $unset it. Only touch docs where it's null (not real IDs).
  try {
    const result = await collection.updateMany(
      { 'whatsapp.phoneNumberId': null },
      { $unset: { 'whatsapp.phoneNumberId': '' } }
    );
    logger.info(`[Migration] Unset null phoneNumberId on ${result.modifiedCount} documents.`);
  } catch (err) {
    logger.error('[Migration] Failed to unset null values:', err.message);
    process.exit(1);
  }

  logger.info('[Migration] Done. Restart the app — Mongoose will recreate the index correctly.');
  process.exit(0);
}

run().catch((err) => {
  logger.error('[Migration] Unexpected error:', err);
  process.exit(1);
});
