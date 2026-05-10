import "./config/env.js";
import mongoose from "mongoose";
import crypto from "crypto";
import BusinessConfig from "./models/BusinessConfig.js";
import Tenant from "./models/Tenant.js";

// ─── seed.js ──────────────────────────────────────────────────────────────────
// Idempotent dev setup. Run after cloning or whenever your DB is empty.
// Also run after deploying fixes — safe to re-run anytime.

try {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("✅ Connected to MongoDB");

  // Drop stale key_1 index that causes E11000 duplicate key crashes
  try {
    const sessionIndexes = await mongoose.connection.db.collection("sessions").indexes();
    if (sessionIndexes.some(idx => idx.name === "key_1")) {
      await mongoose.connection.db.collection("sessions").dropIndex("key_1");
      console.log("✅ Dropped stale sessions index: key_1");
    } else {
      console.log("ℹ️  Stale key_1 index not present — skipping");
    }
  } catch (e) {
    console.warn("⚠️  Could not check/drop key_1 index:", e.message);
  }

  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken   = process.env.META_WHATSAPP_TOKEN;
  const verifyToken   = process.env.META_WEBHOOK_VERIFY_TOKEN || crypto.randomBytes(16).toString("hex");
  const apiVersion    = process.env.META_API_VERSION || "v21.0";

  if (!phoneNumberId) {
    console.error("❌  META_PHONE_NUMBER_ID is not set in your .env.development.local");
    process.exit(1);
  }

  // ── STEP 1: Tenant ──────────────────────────────────────────────────────────
  let tenant = await Tenant.findOne({ "whatsapp.phoneNumberId": phoneNumberId });

  if (tenant) {
    console.log(`ℹ️  Tenant found: ${tenant.name} (${tenant._id})`);
    const needsPatch = tenant.status !== "ACTIVE" || !tenant.whatsapp?.connected || !tenant.whatsapp?.accessToken;
    if (needsPatch) {
      await Tenant.updateOne({ _id: tenant._id }, {
        $set: {
          status:                    "ACTIVE",
          onboardingStep:            3,
          "whatsapp.connected":      true,
          "whatsapp.accessToken":    accessToken || tenant.whatsapp?.accessToken || "DEV_TOKEN",
          "whatsapp.verifyToken":    tenant.whatsapp?.verifyToken || verifyToken,
          "whatsapp.apiVersion":     apiVersion,
          "whatsapp.tokenUpdatedAt": new Date(),
        },
      });
      tenant = await Tenant.findOne({ _id: tenant._id });
      console.log("✅ Tenant patched → ACTIVE + connected");
    } else {
      console.log("✅ Tenant already ACTIVE and connected");
    }
  } else {
    console.log("➕ No tenant found — creating one...");
    tenant = await Tenant.create({
      name:           "Dreamline Sales Bot",
      email:          `wa_${phoneNumberId}@dreamlinesalesbot.internal`,
      status:         "ACTIVE",
      onboardingStep: 3,
      whatsapp: {
        phoneNumberId,
        accessToken:    accessToken || "DEV_TOKEN",
        verifyToken,
        apiVersion,
        connected:      true,
        tokenUpdatedAt: new Date(),
      },
    });
    console.log(`✅ Tenant created: ${tenant._id}`);
    console.log(`\n🔑  API KEY (save this): ${tenant.apiKey}\n`);
  }

  // ── STEP 2: BusinessConfig ──────────────────────────────────────────────────
  let biz = await BusinessConfig.findOne({ $or: [{ phoneNumberId }, { tenantId: tenant._id }] });

  if (biz) {
    console.log(`ℹ️  BusinessConfig found: ${biz.name || "(unnamed)"} (${biz._id})`);
    const needsPatch = String(biz.tenantId) !== String(tenant._id) || biz.phoneNumberId !== phoneNumberId;
    if (needsPatch) {
      await BusinessConfig.updateOne({ _id: biz._id }, { $set: { tenantId: tenant._id, phoneNumberId } });
      console.log("✅ BusinessConfig linked to tenant");
    } else {
      console.log("✅ BusinessConfig already linked");
    }
  } else {
    console.log("➕ Creating starter BusinessConfig...");
    await BusinessConfig.create({
      tenantId:     tenant._id,
      phoneNumberId,
      name:         "Dreamline Sales Bot",
      businessMode: "RESTAURANT",
      botEnabled:   true,
      adminPhone:   null,
      menu: [
        { name: "Burger",  price: 5,  description: "Classic beef burger",  available: true },
        { name: "Chicken", price: 7,  description: "Grilled chicken",      available: true },
        { name: "Rice",    price: 3,  description: "Steamed white rice",   available: true },
      ],
    });
    console.log("✅ BusinessConfig created with starter menu");
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const finalTenant = await Tenant.findOne({ _id: tenant._id }).lean();
  const finalBiz    = await BusinessConfig.findOne({ tenantId: tenant._id }).lean();

  console.log("\n═══════════════════════════════════════════");
  console.log("✅  SEED COMPLETE");
  console.log("═══════════════════════════════════════════");
  console.log(`  Tenant ID:      ${finalTenant._id}`);
  console.log(`  Status:         ${finalTenant.status}`);
  console.log(`  Connected:      ${finalTenant.whatsapp?.connected}`);
  console.log(`  phoneNumberId:  ${finalTenant.whatsapp?.phoneNumberId}`);
  console.log(`  accessToken:    ${finalTenant.whatsapp?.accessToken ? "✅ set" : "❌ MISSING"}`);
  console.log(`  BusinessConfig: ${finalBiz?.name || "❌ not found"}`);
  console.log(`  API Key:        ${finalTenant.apiKey}`);
  console.log("═══════════════════════════════════════════");
  console.log("\n▶  Ensure your .env.development.local has:");
  console.log("     SKIP_WEBHOOK_SIGNATURE=true");
  console.log("     DISABLE_WORKING_HOURS=true");
  console.log("\n▶  Start server: npm run dev");
  console.log("▶  No more 403s, session crashes, or Unknown phoneNumberId\n");
  console.log("⚠️  Outbound 403 from Meta = expired META_WHATSAPP_TOKEN.");
  console.log("   Refresh at: developers.facebook.com → Your App → WhatsApp → API Setup\n");

} catch (err) {
  console.error("❌ Seed failed:", err.message);
  process.exit(1);
}

process.exit(0);
