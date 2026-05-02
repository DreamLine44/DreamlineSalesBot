import { applyModePreset, buildSetupChecklist as buildChecklist, getDefaultConfig as defaultConfigTemplate, validateBusinessConfig } from '../services/modePresetService.js';
import BusinessConfig from "../models/BusinessConfig.js";
import Session        from "../models/Session.js";
import { getAnalyticsSummary } from "../services/analyticsService.js";
import logger from "../config/logger.js";

// ─── Helper: get phoneNumberId safely ────────────────────────────────────────
function getPhoneNumberId(req, res) {
  const id = req.tenant?.whatsapp?.phoneNumberId;
  if (!id) {
    res.status(400).json({
      success: false,
      message: 'WhatsApp not connected yet. Complete step 3 of onboarding first: PUT /register/whatsapp',
    });
    return null;
  }
  return id;
}

// ================= CREATE BUSINESS =================
export const createBusiness = async (req, res) => {
  try {
    const phoneNumberId = getPhoneNumberId(req, res);
    if (!phoneNumberId) return;

    const existing = await BusinessConfig.findOne({ phoneNumberId });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: "Business config already exists. Use PUT to update it."
      });
    }

    // ✅ UPDATED — includes all new fields: description, botEnabled, adminPhone, customMessages
    const ALLOWED = [
      "name", "description", "businessMode", "mode", "menu", "services",
      "tone", "settings", "hours", "nlp", "botEnabled", "adminPhone",
      "wavePhone", "payment", "customMessages", "faq"
    ];
    const UPPERCASE_FIELDS = new Set(["businessMode", "mode"]);
    const data = { phoneNumberId, tenantId: req.tenant._id };
    for (const field of ALLOWED) {
      if (req.body[field] !== undefined) {
        // [FIX-2] Uppercase businessMode/mode — 'restaurant' would fail the enum
        data[field] = UPPERCASE_FIELDS.has(field) && typeof req.body[field] === 'string'
          ? req.body[field].toUpperCase()
          : req.body[field];
      }
    }

    // [FIX-4] validateBusinessConfig was imported but never called — run it now
    const validation = validateBusinessConfig(data);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: 'Please fix the following before creating your business config:',
        errors:  validation.errors,
      });
    }

    const business = await BusinessConfig.create(data);

    res.status(201).json({
      success: true,
      message: "Business configuration created.",
      data: business
    });

  } catch (error) {
    logger.error("Create Business Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ================= GET BUSINESS =================
export const getBusiness = async (req, res) => {
  try {
    const phoneNumberId = getPhoneNumberId(req, res);
    if (!phoneNumberId) return;
    const business = await BusinessConfig.findOne({ phoneNumberId });

    if (!business) {
      return res.status(404).json({
        success: false,
        message: "No business configuration found. Use POST to create one."
      });
    }

    res.json({ success: true, data: business });

  } catch (error) {
    logger.error("Get Business Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ================= UPDATE BUSINESS =================
export const updateBusiness = async (req, res) => {
  try {
    const phoneNumberId = getPhoneNumberId(req, res);
    if (!phoneNumberId) return;

    // ✅ UPDATED — includes all new fields
    const ALLOWED = [
      "name", "description", "businessMode", "mode", "menu", "services",
      "tone", "settings", "hours", "nlp", "botEnabled", "adminPhone",
      "wavePhone", "payment", "customMessages", "faq"
    ];
    const UPPERCASE_FIELDS = new Set(["businessMode", "mode"]);
    const patch = {};
    for (const field of ALLOWED) {
      if (req.body[field] !== undefined) {
        // [FIX-3] Uppercase businessMode/mode — 'restaurant' would fail the enum
        patch[field] = UPPERCASE_FIELDS.has(field) && typeof req.body[field] === 'string'
          ? req.body[field].toUpperCase()
          : req.body[field];
      }
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, message: "No updatable fields provided." });
    }

    const updated = await BusinessConfig.findOneAndUpdate(
      { phoneNumberId },
      { $set: patch },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "No business config found. Use POST to create one first."
      });
    }

    res.json({ success: true, message: "Business configuration updated.", data: updated });

  } catch (error) {
    logger.error("Update Business Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ================= GET ANALYTICS =================
// ✅ NEW — GET /business/analytics
// Returns total orders, bookings, failed interactions, top item, peak hour, daily breakdown.

export const getAnalytics = async (req, res) => {
  try {
    const phoneNumberId = getPhoneNumberId(req, res);
    if (!phoneNumberId) return;
    const summary = await getAnalyticsSummary(phoneNumberId);

    if (!summary) {
      return res.status(500).json({ success: false, message: "Could not retrieve analytics." });
    }

    res.json({ success: true, data: summary });

  } catch (error) {
    logger.error("Analytics Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ================= HUMAN MODE TOGGLE =================
// ✅ NEW — POST /business/human-mode
// Body: { phone: "2207000000", active: true }
// Pauses or resumes the bot for a specific customer session.

export const toggleHumanMode = async (req, res) => {
  try {
    const tenantId = String(req.tenant._id);
    const { phone, active } = req.body;

    if (!phone || typeof active !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "Required: { phone: string, active: boolean }"
      });
    }

    // [FIX-HM] Normalize phone: strip leading '+' so the key matches how WhatsApp
    // delivers the `from` field (always without '+', e.g. "2207123456").
    // Without this, callers who include the '+' would build a different key and
    // never find the session — humanMode toggle would silently fail.
    const normalizedPhone = String(phone).replace(/^\+/, '');

    // Session key MUST match sessionService format: "${customerPhone}_${tenantId}"
    const key = `${normalizedPhone}_${tenantId}`;

    const session = active
      ? await Session.findOneAndUpdate(
          { phone: key },
          { $set: { humanMode: true } },
          { new: true }
        )
      : await Session.findOneAndUpdate(
          { phone: key },
          {
            $set: {
              humanMode: false,
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            },
          },
          { new: true }
          // NOTE: No upsert when turning OFF — if there's no session the bot is
          // already inactive, so creating a bare document would be misleading.
        );

    if (!session) {
      // active=true → no session exists yet (customer hasn't messaged)
      // active=false → session already expired or never existed (no action needed)
      if (active) {
        return res.status(404).json({
          success: false,
          message: `No active session found for ${normalizedPhone}. The customer may need to message first.`
        });
      }
      // Turning off when no session exists is a no-op — that's fine
      return res.json({
        success: true,
        message: `No active session for ${normalizedPhone} — bot is already inactive.`,
        data: { phone: normalizedPhone, humanMode: false }
      });
    }

    res.json({
      success: true,
      message: active
        ? `Bot paused for ${normalizedPhone}. Human mode ON.`
        : `Bot resumed for ${normalizedPhone}. Human mode OFF.`,
      data: { phone: normalizedPhone, humanMode: session.humanMode }
    });

  } catch (error) {
    logger.error("Human Mode Toggle Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};


// ================= APPLY MODE PRESET (v3.0) =================
// POST /business/apply-mode
// Body: { mode: "RESTAURANT" | "SALON" | "RETAIL" }
// Applies a pre-configured mode bundle. Business owners use this to set up
// their bot without any coding knowledge.

export const applyMode = async (req, res) => {
  try {
    const phoneNumberId = getPhoneNumberId(req, res);
    if (!phoneNumberId) return;
    const { mode } = req.body;

    if (!mode) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a mode. Valid options are: RESTAURANT, SALON, or RETAIL.',
      });
    }

    const result = await applyModePreset(phoneNumberId, mode);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);

  } catch (error) {
    logger.error('Apply Mode Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ================= SETUP CHECKLIST (v3.0) =================
// GET /business/setup-checklist
// Returns a plain-English checklist of what's set up and what's missing.
// Perfect for business owners who want to know if their bot is fully configured.

export const getSetupChecklist = async (req, res) => {
  try {
    const phoneNumberId = getPhoneNumberId(req, res);
    if (!phoneNumberId) return;
    const business = await BusinessConfig.findOne({ phoneNumberId });

    if (!business) {
      return res.status(404).json({
        success: false,
        message: "No business found. Please create your business config first using POST /business.",
      });
    }

    const checklist = buildChecklist(business);

    res.json({ success: true, data: checklist });

  } catch (error) {
    logger.error('Setup Checklist Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ================= DEFAULT CONFIG (v3.0) =================
// GET /business/default-config?mode=RESTAURANT
// Returns a ready-to-use starter config template for a business mode.
// Business owners can use this as the body for POST /business.

export const getDefaultConfig = async (req, res) => {
  try {
    const mode = req.query.mode || 'RESTAURANT';
    const template = defaultConfigTemplate(mode);

    res.json({
      success: true,
      message: `Here is a starter template for ${mode.toUpperCase()} mode. Fill in your details and send it to POST /business to set up your bot.`,
      data: template,
    });

  } catch (error) {
    logger.error('Default Config Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
