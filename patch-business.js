/**
 * patch-business.js — ONE-TIME migration script
 *
 * Problem: seed.js previously created BusinessConfig without a tenantId,
 * so the webhook couldn't find it → "No BusinessConfig for tenant: <id>"
 *
 * This script finds any BusinessConfig records that are missing a tenantId
 * and links them to the matching Tenant by phoneNumberId.
 *
 * Run once with: node patch-business.js
 * Safe to run multiple times — skips already-linked records.
 */

import "./config/env.js";
import mongoose from "mongoose";
import Tenant from "./models/Tenant.js";
import BusinessConfig from "./models/BusinessConfig.js";

await mongoose.connect(process.env.MONGODB_URI);

// Find all BusinessConfig docs with no tenantId set
const orphans = await BusinessConfig.find({
  $or: [{ tenantId: null }, { tenantId: { $exists: false } }]
});

if (orphans.length === 0) {
  console.log("✅ No orphaned BusinessConfig records found — nothing to patch.");
  process.exit(0);
}

console.log(`Found ${orphans.length} orphaned BusinessConfig record(s). Patching...`);

let patched = 0;
let skipped = 0;

for (const config of orphans) {
  const tenant = await Tenant.findOne({ "whatsapp.phoneNumberId": config.phoneNumberId });

  if (!tenant) {
    console.warn(`  ⚠️  No Tenant found for phoneNumberId: ${config.phoneNumberId} — skipping`);
    skipped++;
    continue;
  }

  await BusinessConfig.updateOne(
    { _id: config._id },
    { $set: { tenantId: tenant._id } }
  );

  console.log(`  ✅ Linked BusinessConfig ${config._id} → Tenant ${tenant._id} (${tenant.name})`);
  patched++;
}

console.log(`\nDone. Patched: ${patched}, Skipped: ${skipped}`);
await mongoose.disconnect();
process.exit(0);
