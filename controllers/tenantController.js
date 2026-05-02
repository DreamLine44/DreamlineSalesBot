import Tenant from "../models/Tenant.js";
import BusinessConfig from "../models/BusinessConfig.js";
import crypto from "crypto";
import logger from "../config/logger.js";

// Node 18+ has native global fetch — no import needed.

// ================= REGISTER NEW TENANT =================
export const registerTenant = async (req, res) => {
  try {
    const { name, email, plan } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: "Required: name, email"
      });
    }

    const cleanEmail = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ success: false, message: "Invalid email address." });
    }

    const existingEmail = await Tenant.findOne({ email: cleanEmail });
    if (existingEmail) {
      return res.status(409).json({
        success: false,
        message: "A tenant with this email already exists."
      });
    }

    const tenant = await Tenant.create({
      name,
      email: cleanEmail,
      plan: plan || "FREE",
      status: "PENDING"
    });

    res.status(201).json({
      success: true,
      message: "Tenant registered. Next step: connect their WhatsApp via /admin/tenants/:id/connect-whatsapp",
      data: {
        tenantId: tenant._id,
        name: tenant.name,
        email: tenant.email,
        plan: tenant.plan,
        status: tenant.status,
        apiKey: tenant.apiKey,
        nextStep: `POST /admin/tenants/${tenant._id}/connect-whatsapp`
      }
    });

  } catch (error) {
    logger.error("❌ Register Tenant Error:", error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: "A tenant with this email already exists." });
    }
    res.status(500).json({ success: false, message: "Server error" });
  }
};


// ================= CONNECT WHATSAPP =================
export const connectWhatsApp = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant = await Tenant.findById(id);

    if (!tenant) {
      return res.status(404).json({ success: false, message: "Tenant not found" });
    }

    // Ensure whatsapp object exists
    if (!tenant.whatsapp) {
      tenant.whatsapp = {};
    }

    const { phoneNumberId, accessToken, wabaId, phone, verifyToken, apiVersion } = req.body;

    // ================= OPTION A: MANUAL =================
    if (phoneNumberId && accessToken) {

      const duplicate = await Tenant.findOne({
        "whatsapp.phoneNumberId": phoneNumberId,
        _id: { $ne: id }
      });

      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: "This phoneNumberId is already registered to another tenant."
        });
      }

      tenant.whatsapp.phone = phone || tenant.whatsapp.phone || null;
      tenant.whatsapp.phoneNumberId = phoneNumberId;
      tenant.whatsapp.accessToken = accessToken;
      tenant.whatsapp.wabaId = wabaId || null;
      tenant.whatsapp.verifyToken = verifyToken || crypto.randomBytes(16).toString("hex");
      tenant.whatsapp.apiVersion = apiVersion || process.env.WA_API_VERSION || "v21.0";
      tenant.whatsapp.connected = true;
      tenant.whatsapp.tokenUpdatedAt = new Date();
      tenant.status = "ACTIVE";

      await tenant.save();
      await BusinessConfig.findOneAndUpdate(
        { phoneNumberId },
        { $setOnInsert: { phoneNumberId, tenantId: tenant._id, name: tenant.name, businessMode: "RESTAURANT" } },
        { upsert: true, new: true }
      );

      return res.json({
        success: true,
        message: "WhatsApp connected successfully. Bot is now ACTIVE.",
        data: {
          tenantId: tenant._id,
          name: tenant.name,
          status: tenant.status,
          phoneNumberId,
          wabaId: tenant.whatsapp.wabaId,
          verifyToken: tenant.whatsapp.verifyToken,
          webhookUrl: `${process.env.BASE_URL}/webhook/${phoneNumberId}`
        }
      });
    }

    // ================= OPTION B: META FLOW =================
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Provide either: (a) phoneNumberId + accessToken, or (b) code from Meta Embedded Signup"
      });
    }

    const { META_APP_ID, META_APP_SECRET, META_REDIRECT_URI } = process.env;
    const WA_API_VERSION = process.env.WA_API_VERSION || "v21.0";

    if (!META_APP_ID || !META_APP_SECRET || !META_REDIRECT_URI) {
      return res.status(500).json({
        success: false,
        message: "Missing Meta env configuration."
      });
    }

    // 🔥 STEP 1: EXCHANGE CODE
    const tokenRes = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}&code=${code}`
    );

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      logger.error("Meta token error:", tokenData);
      return res.status(400).json({
        success: false,
        message: "Failed to exchange Meta code.",
        detail: tokenData.error?.message
      });
    }

    const userToken = tokenData.access_token;

    // 🔥 STEP 2: GET WABA (FIXED ENDPOINT)
    const wabaRes = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/me/whatsapp_business_accounts?access_token=${userToken}`
    );

    const wabaData = await wabaRes.json();
    const wabaIdResolved = wabaData.data?.[0]?.id;

    if (!wabaIdResolved) {
      return res.status(400).json({
        success: false,
        message: "No WhatsApp Business Account found."
      });
    }

    // 🔥 STEP 3: GET PHONE NUMBERS
    const phonesRes = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${wabaIdResolved}/phone_numbers?access_token=${userToken}`
    );

    const phonesData = await phonesRes.json();
    const firstPhone = phonesData.data?.[0];

    if (!firstPhone?.id) {
      return res.status(400).json({
        success: false,
        message: "No phone number found in WABA."
      });
    }

    const fetchedPhoneNumberId = firstPhone.id;
    const fetchedPhone = firstPhone.display_phone_number;

        const duplicate = await Tenant.findOne({
      "whatsapp.phoneNumberId": fetchedPhoneNumberId,
      _id: { $ne: id }
    });

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "This WhatsApp number is already connected to another tenant."
      });
    }

        tenant.whatsapp.phone = fetchedPhone || null;
    tenant.whatsapp.phoneNumberId = fetchedPhoneNumberId;
    tenant.whatsapp.wabaId = wabaIdResolved;
    tenant.whatsapp.accessToken = userToken;
    tenant.whatsapp.verifyToken = crypto.randomBytes(16).toString("hex");
    tenant.whatsapp.apiVersion = WA_API_VERSION;
    tenant.whatsapp.connected = true;
    tenant.whatsapp.tokenUpdatedAt = new Date();
    tenant.status = "ACTIVE";

    await tenant.save();

    await BusinessConfig.findOneAndUpdate(
      { phoneNumberId: fetchedPhoneNumberId },
      { $setOnInsert: { phoneNumberId: fetchedPhoneNumberId, tenantId: tenant._id, name: tenant.name, businessMode: "RESTAURANT" } },
      { upsert: true }
    );

    return res.json({
      success: true,
      message: "WhatsApp connected via Meta Embedded Signup. Bot is now ACTIVE.",
      data: {
        tenantId: tenant._id,
        name: tenant.name,
        status: tenant.status,
        phone: fetchedPhone,
        phoneNumberId: fetchedPhoneNumberId,
        wabaId: wabaIdResolved,
        verifyToken: tenant.whatsapp.verifyToken,
        webhookUrl: `${process.env.BASE_URL}/webhook/${fetchedPhoneNumberId}`
      }
    });

  } catch (error) {
    logger.error("❌ Connect WhatsApp Error:", error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: "This WhatsApp number is already connected to another account." });
    }
    res.status(500).json({ success: false, message: "Server error" });
  }
};


// ================= LIST ALL TENANTS =================
export const listTenants = async (req, res) => {
  try {
    const tenants = await Tenant.find({}, "-whatsapp.accessToken -__v")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: tenants.length,
      data: tenants
    });

  } catch (error) {
    logger.error("❌ List Tenants Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};


// ================= GET TENANT =================
export const getTenant = async (req, res) => {
  try {
    const { id } = req.params;

    const tenant = await Tenant.findById(id, "-whatsapp.accessToken -__v");

    if (!tenant) {
      return res.status(404).json({ success: false, message: "Tenant not found" });
    }

    res.json({ success: true, data: tenant });

  } catch (error) {
    logger.error("❌ Get Tenant Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};


// ================= UPDATE TENANT =================
export const updateTenant = async (req, res) => {
  try {
    const { id } = req.params;

    const ALLOWED = ["name", "email", "plan", "status", "notes", "limits", "adminPhone"];
    const patch = {};

    for (const field of ALLOWED) {
      if (req.body[field] !== undefined) patch[field] = req.body[field];
    }

    // Validate status before DB write — Mongoose runValidators catches this too,
    // but returning a clear 400 here is faster and gives a better error message.
    if (patch.status && !["ACTIVE", "SUSPENDED", "PENDING"].includes(patch.status)) {
      return res.status(400).json({
        success: false,
        message: "status must be ACTIVE, SUSPENDED, or PENDING",
      });
    }

    if (req.body.accessToken) {
      patch["whatsapp.accessToken"] = req.body.accessToken;
      patch["whatsapp.tokenUpdatedAt"] = new Date();
    }

    if (req.body.apiVersion) {
      patch["whatsapp.apiVersion"] = req.body.apiVersion;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, message: "No updatable fields provided." });
    }

    const tenant = await Tenant.findByIdAndUpdate(
      id,
      { $set: patch },
      { new: true, runValidators: true, select: "-whatsapp.accessToken -__v" }
    );

    if (!tenant) {
      return res.status(404).json({ success: false, message: "Tenant not found" });
    }

    res.json({ success: true, message: "Tenant updated", data: tenant });

  } catch (error) {
    logger.error("❌ Update Tenant Error:", error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: "A tenant with this email already exists." });
    }
    res.status(500).json({ success: false, message: "Server error" });
  }
};


// ================= ROTATE API KEY =================
export const rotateApiKey = async (req, res) => {
  try {
    const { id } = req.params;

    const newKey = crypto.randomBytes(32).toString("hex");

    const tenant = await Tenant.findByIdAndUpdate(
      id,
      { $set: { apiKey: newKey } },
      { new: true, select: "name email apiKey" }
    );

    if (!tenant) {
      return res.status(404).json({ success: false, message: "Tenant not found" });
    }

    res.json({
      success: true,
      message: "API key rotated. Update the client's credentials.",
      data: { name: tenant.name, email: tenant.email, newApiKey: newKey }
    });

  } catch (error) {
    logger.error("❌ Rotate Key Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};


// ================= SET STATUS =================
export const setTenantStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["ACTIVE", "SUSPENDED", "PENDING"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be ACTIVE, SUSPENDED, or PENDING"
      });
    }

    const tenant = await Tenant.findByIdAndUpdate(
      id,
      { $set: { status } },
      { new: true, select: "name email status" }
    );

    if (!tenant) {
      return res.status(404).json({ success: false, message: "Tenant not found" });
    }

    res.json({
      success: true,
      message: `Tenant ${status.toLowerCase()}`,
      data: tenant
    });

  } catch (error) {
    logger.error("❌ Set Status Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};


// ================= DELETE TENANT =================
export const deleteTenant = async (req, res) => {
  try {
    const { id } = req.params;

    const tenant = await Tenant.findById(id);

    if (!tenant) {
      return res.status(404).json({ success: false, message: "Tenant not found" });
    }

    if (tenant.whatsapp?.phoneNumberId) {
      await BusinessConfig.deleteMany({
        phoneNumberId: tenant.whatsapp.phoneNumberId
      });
    }

    await Tenant.findByIdAndDelete(id);

    res.json({
      success: true,
      message: "Tenant and associated config deleted."
    });

  } catch (error) {
    logger.error("❌ Delete Tenant Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};