import { applyModePreset, buildSetupChecklist as buildChecklist, getDefaultConfig as defaultConfigTemplate, validateBusinessConfig } from '../services/modePresetService.js';
import BusinessConfig from "../models/BusinessConfig.js";
import Session        from "../models/Session.js";
import Tenant         from "../models/Tenant.js";
import { getAnalyticsSummary } from "../services/analyticsService.js";
import logger from "../config/logger.js";
import { getLeadsForTenant } from '../services/leadCaptureService.js';
import { v2 as cloudinary } from 'cloudinary';


// [FIX-12] Single source of truth for allowed business config fields.
// Previously ALLOWED was duplicated inline in createBusiness AND updateBusiness
// with misaligned indentation — any future field addition required two edits
// and the mismatch made diffs hard to review.
const BUSINESS_ALLOWED_FIELDS    = [
  "name", "description", "businessMode", "mode", "menu", "services",
  "tone", "settings", "hours", "nlp", "botEnabled", "adminPhone",
  "wavePhone", "payment", "customMessages", "faq",
];
const BUSINESS_UPPERCASE_FIELDS = new Set(["businessMode", "mode"]);

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

    const data = { phoneNumberId, tenantId: req.tenant._id };
    for (const field of BUSINESS_ALLOWED_FIELDS) {
      if (req.body[field] !== undefined) {
        // Uppercase businessMode/mode — 'restaurant' would fail the enum
        data[field] = BUSINESS_UPPERCASE_FIELDS.has(field) && typeof req.body[field] === 'string'
          ? req.body[field].toUpperCase()
          : req.body[field];
      }
    }

    // validateBusinessConfig was imported but never called — run it now
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

    const patch = {};
    for (const field of BUSINESS_ALLOWED_FIELDS) {
      if (req.body[field] !== undefined) {
        // Uppercase businessMode/mode — 'restaurant' would fail the enum
        patch[field] = BUSINESS_UPPERCASE_FIELDS.has(field) && typeof req.body[field] === 'string'
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

    // Normalize phone: strip leading '+' so the key matches how WhatsApp
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
              humanModeNotified: false, // Reset so notification fires again next time human mode is enabled
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

// ─── Menu image upload ────────────────────────────────────────────────────────
//
// POST /business/menu/upload-image
//
// Accepts a multipart/form-data upload (field: "image") and optionally
// a menuItemId in the body to attach the image directly to an existing item.
//
// Cloudinary is configured from env vars:
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
//
// Returns: { url, public_id } — store these in the menu item's image field.
// If a menuItemId is provided, the image is also written to that menu item
// automatically so callers don't need a second request.
//
// Security:
//   - Only images are accepted (image/* MIME type)
//   - File size limit enforced by multer (configured in businessRoutes.js)
//   - Cloudinary strips EXIF data by default

export const uploadMenuImage = async (req, res) => {
  try {
    // Lazy-configure Cloudinary (reads env at call time, not module load)
    const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return res.status(503).json({
        success: false,
        message: 'Image uploads are not configured on this server. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET env vars.',
      });
    }

    // Re-configure on every call so runtime env changes (e.g. secret rotation) take effect
    // without restarting the process. cloudinary.config() is idempotent.
    cloudinary.config({
      cloud_name: CLOUDINARY_CLOUD_NAME,
      api_key:    CLOUDINARY_API_KEY,
      api_secret: CLOUDINARY_API_SECRET,
    });

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided. Send a multipart/form-data request with field "image".',
      });
    }

    // Validate MIME type — only images allowed
    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({
        success: false,
        message: `Invalid file type: ${req.file.mimetype}. Only image files are accepted.`,
      });
    }

    // Upload buffer to Cloudinary via upload_stream.
    // - folder:        organises assets per-tenant
    // - resource_type: must be 'image'
    // - format:        force WebP output for optimal WhatsApp compression
    // - transformation: cap at 1280px wide, strip EXIF, auto quality
    // - use_filename:  false — let Cloudinary generate a collision-free public_id
    // - unique_filename: true (default) — prevents accidental overwrites
    const folder = `dreamlinesalesbot/${req.tenant._id}/menu`;
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
          format: 'webp',
          transformation: [{ width: 1280, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
          use_filename: false,
        },
        (err, uploadResult) => {
          if (err) return reject(err);
          resolve(uploadResult);
        },
      );

      // Guard: catch synchronous errors from stream.end() (e.g. corrupted buffer)
      stream.on('error', reject);
      stream.end(req.file.buffer);
    });

    const { secure_url: url, public_id } = result;

    // Optionally update the menu item directly if menuItemId was provided
    const { menuItemId } = req.body;
    if (menuItemId) {
      // Fetch the existing menu item so we can delete the old Cloudinary asset if present
      const existing = await BusinessConfig.findOne(
        { tenantId: req.tenant._id, 'menu._id': menuItemId },
        { 'menu.$': 1 },
      );
      const oldPublicId = existing?.menu?.[0]?.image?.public_id;

      const updated = await BusinessConfig.findOneAndUpdate(
        { tenantId: req.tenant._id, 'menu._id': menuItemId },
        { $set: { 'menu.$.image': { url, public_id } } },
        { new: true },
      );
      if (!updated) {
        // Image uploaded fine — just warn that item wasn't found
        logger.warn('[Business] uploadMenuImage: menuItemId not found, image not attached', {
          tenantId: req.tenant._id, menuItemId,
        });
        return res.json({
          success: true,
          message: 'Image uploaded but menuItemId not found — image was NOT attached to any menu item.',
          data: { url, public_id },
        });
      }

      // Delete the old Cloudinary asset after successful DB update to avoid orphaned assets
      if (oldPublicId && oldPublicId !== public_id) {
        cloudinary.uploader.destroy(oldPublicId, { resource_type: 'image' })
          .catch(e => logger.warn('[Business] uploadMenuImage: failed to delete old Cloudinary asset', {
            oldPublicId, err: e.message,
          }));
      }
    }

    logger.info('[Business] Menu image uploaded', { tenantId: req.tenant._id, public_id, menuItemId: menuItemId || null });

    return res.json({
      success: true,
      message: menuItemId
        ? 'Image uploaded and attached to menu item.'
        : 'Image uploaded. Use the returned url + public_id when creating or updating a menu item.',
      data: { url, public_id },
    });

  } catch (err) {
    logger.error('Upload Menu Image Error:', err);
    res.status(500).json({ success: false, message: 'Image upload failed. Please try again.' });
  }
};

// ─── Advanced config endpoints (POST /business/{section}) ────────────────────
//
// Each endpoint patches only its own section of BusinessConfig.
// All require x-api-key (applied at router level via requireApiKey in app.js).
// Use these AFTER Step 2 (POST /register/business) for incremental configuration
// instead of sending one giant full-mode payload.

/**
 * POST /business/menu
 * Body: { menu: [{ name, price, description, keywords, available }] }
 */
export const updateMenu = async (req, res) => {
  try {
    const { menu } = req.body;
    if (!Array.isArray(menu)) {
      return res.status(400).json({ success: false, message: '"menu" must be an array. Send [] to clear it.' });
    }
    const business = await BusinessConfig.findOneAndUpdate(
      { tenantId: req.tenant._id },
      { $set: { menu } },
      { new: true, upsert: true, runValidators: true },
    );
    await _advanceStepIfComplete(req.tenant);
    logger.info('[Business] Menu updated', { tenantId: req.tenant._id, items: menu.length });
    res.json({ success: true, message: `Menu updated — ${menu.length} item(s) saved.`, data: { menu: business.menu } });
  } catch (err) {
    logger.error('Update Menu Error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * POST /business/hours
 * Body: { hours: { enabled, timezone, days: { mon: { open, close }, ... } } }
 */
export const updateHours = async (req, res) => {
  try {
    const { hours } = req.body;
    if (!hours || typeof hours !== 'object' || Array.isArray(hours)) {
      return res.status(400).json({ success: false, message: '"hours" must be an object.' });
    }
    const business = await BusinessConfig.findOneAndUpdate(
      { tenantId: req.tenant._id },
      { $set: { hours } },
      { new: true, upsert: true, runValidators: true },
    );
    await _advanceStepIfComplete(req.tenant);
    logger.info('[Business] Hours updated', { tenantId: req.tenant._id });
    res.json({ success: true, message: 'Business hours updated.', data: { hours: business.hours } });
  } catch (err) {
    logger.error('Update Hours Error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * POST /business/payment
 * Body: { payment: { wavePhone, bankDetails, ... } }
 */
export const updatePayment = async (req, res) => {
  try {
    const { payment } = req.body;
    if (!payment || typeof payment !== 'object' || Array.isArray(payment)) {
      return res.status(400).json({ success: false, message: '"payment" must be an object.' });
    }
    const business = await BusinessConfig.findOneAndUpdate(
      { tenantId: req.tenant._id },
      { $set: { payment } },
      { new: true, upsert: true, runValidators: true },
    );
    await _advanceStepIfComplete(req.tenant);
    logger.info('[Business] Payment updated', { tenantId: req.tenant._id });
    res.json({ success: true, message: 'Payment config updated.', data: { payment: business.payment } });
  } catch (err) {
    logger.error('Update Payment Error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * POST /business/faq
 * Body: { faq: [{ trigger, reply }] }
 */
export const updateFaq = async (req, res) => {
  try {
    const { faq } = req.body;
    if (!Array.isArray(faq)) {
      return res.status(400).json({ success: false, message: '"faq" must be an array. Send [] to clear it.' });
    }
    const business = await BusinessConfig.findOneAndUpdate(
      { tenantId: req.tenant._id },
      { $set: { faq } },
      { new: true, upsert: true, runValidators: true },
    );
    await _advanceStepIfComplete(req.tenant);
    logger.info('[Business] FAQ updated', { tenantId: req.tenant._id, entries: faq.length });
    res.json({ success: true, message: `FAQ updated — ${faq.length} entry/entries saved.`, data: { faq: business.faq } });
  } catch (err) {
    logger.error('Update FAQ Error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * POST /business/settings
 * Body: any combination of { settings, tone, nlp, botEnabled, customMessages }
 */
export const updateSettings = async (req, res) => {
  try {
    const SETTINGS_FIELDS = ['settings', 'tone', 'nlp', 'botEnabled', 'customMessages'];
    const patch = {};
    for (const field of SETTINGS_FIELDS) {
      if (req.body[field] !== undefined) patch[field] = req.body[field];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No recognised settings fields provided.',
        accepted: SETTINGS_FIELDS,
      });
    }
    const business = await BusinessConfig.findOneAndUpdate(
      { tenantId: req.tenant._id },
      { $set: patch },
      { new: true, upsert: true, runValidators: true },
    );
    logger.info('[Business] Settings updated', { tenantId: req.tenant._id, fields: Object.keys(patch) });
    res.json({
      success: true,
      message: 'Settings updated.',
      data: {
        settings:       business.settings,
        tone:           business.tone,
        nlp:            business.nlp,
        botEnabled:     business.botEnabled,
        customMessages: business.customMessages,
      },
    });
  } catch (err) {
    logger.error('Update Settings Error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Helper: advance onboardingStep → 3 once all key sections are present ─────
async function _advanceStepIfComplete(tenant) {
  if ((tenant.onboardingStep || 0) >= 3) return; // already complete
  try {
    const biz       = await BusinessConfig.findOne({ tenantId: tenant._id })
      .select('menu hours payment faq')
      .lean();
    const menuOk    = Array.isArray(biz?.menu)    && biz.menu.length    > 0;
    const hoursOk   = biz?.hours?.enabled === true;
    const paymentOk = !!biz?.payment?.wavePhone;
    const faqOk     = Array.isArray(biz?.faq)     && biz.faq.length     > 0;
    if (menuOk && hoursOk && paymentOk && faqOk) {
      await Tenant.findByIdAndUpdate(tenant._id, { $set: { onboardingStep: 3 } });
    }
  } catch (_) { /* non-critical — step advance is best-effort */ }
}

// ================= DEFAULT CONFIG (v3.0) =================
// GET /business/default-config?mode=RESTAURANT
// Returns a ready-to-use starter config template for a business mode.
// Business owners can use this as the body for POST /business.


export const getLeads = async (req, res) => {
  try {
    const tenantId = req.tenant._id;
    const leads = await getLeadsForTenant(tenantId);
    res.json({ success: true, data: leads, total: leads.length });
  } catch (err) {
    logger.error('[Business] getLeads error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

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
