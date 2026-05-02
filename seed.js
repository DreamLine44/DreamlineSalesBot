import "./config/env.js"; // MUST be first — loads .env.*.local before anything reads process.env
import mongoose from "mongoose";
import BusinessConfig from "./models/BusinessConfig.js";
import Tenant from "./models/Tenant.js";

// [FIX 1] Use config/env.js (consistent with app.js) instead of calling dotenv directly.
// tenantId is now looked up and linked so the webhook can find BusinessConfig by tenant._id.

try {
  await mongoose.connect(process.env.MONGODB_URI);

  const phoneNumberId = process.env.META_PHONE_NUMBER_ID || "SEED_PHONE_NUMBER_ID";

  const existing = await BusinessConfig.findOne({ phoneNumberId });
  if (existing) {
    // If tenantId is already set, nothing to do.
    if (existing.tenantId) {
      console.log("⚠️  Business already seeded and linked — skipping.");
      process.exit(0);
    }
    // tenantId missing on existing doc — patch it now (handles re-runs after the old bug).
    const tenant = await Tenant.findOne({ "whatsapp.phoneNumberId": phoneNumberId });
    if (tenant) {
      await BusinessConfig.updateOne({ phoneNumberId }, { $set: { tenantId: tenant._id } });
      console.log(`✅ Patched existing BusinessConfig — linked to tenant: ${tenant._id}`);
    } else {
      console.log("⚠️  Business already seeded but no matching Tenant found. Run connect-whatsapp first.");
    }
    process.exit(0);
  }

  // Look up the tenant so we can link tenantId on creation.
  // In dev you must have called POST /admin/tenants/register + connect-whatsapp first.
  const tenant = await Tenant.findOne({ "whatsapp.phoneNumberId": phoneNumberId });
  if (!tenant) {
    console.warn(
      `⚠️  No Tenant found for phoneNumberId: ${phoneNumberId}\n` +
      `   The BusinessConfig will be created WITHOUT a tenantId.\n` +
      `   Run the seed again AFTER connecting WhatsApp via connect-whatsapp to auto-patch.`
    );
  }

  await BusinessConfig.create({
    name: "DLK Restaurant",
    phoneNumberId,
    tenantId: tenant?._id ?? null, // [FIX 1] link to tenant so webhook can find config
    menu: [
      { name: "Burger", price: 5 },
      { name: "Chicken", price: 7 },
      { name: "Rice", price: 3 }
    ]
  });

  console.log(`✅ Business seeded${tenant ? ` and linked to tenant: ${tenant._id}` : " (no tenant linked yet)"}`);
} catch (err) {
  console.error("❌ Seed failed:", err.message);
  process.exit(1);
}

process.exit(0);

