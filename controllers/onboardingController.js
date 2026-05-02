/**
 * controllers/onboardingController.js — WhatsBotLyn v5.0
 *
 * Public self-serve onboarding — no SUPER_ADMIN_API_KEY required.
 * Rate-limited by the global rateLimiter middleware.
 *
 * Flow:
 *   Step 1: POST /register          → creates Tenant, returns apiKey + tenantId
 *   Step 2: POST /register/business → creates/updates BusinessConfig (requires apiKey)
 *   Step 3: PUT  /register/whatsapp → links WhatsApp credentials (phoneNumberId + accessToken)
 *   GET    /register/status         → returns current onboarding progress
 *
 * v5.0 improvements:
 * [ONB-1] Step 2 no longer requires WhatsApp to be connected first —
 *         businesses can configure menu, hours, tone WHILE waiting for Meta approval.
 * [ONB-2] Better validation messages with actionable guidance.
 * [ONB-3] Status endpoint now includes % complete and per-step guidance.
 * [ONB-4] Duplicate email returns existing tenantId hint (not just "already exists").
 * [ONB-5] Plan validation defaults gracefully to FREE with a note.
 * [ONB-6] WhatsApp connect step auto-creates BusinessConfig if not yet done.
 * [ONB-7] Status endpoint checks Groq health as optional indicator.
 */

import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import logger         from '../config/logger.js';
import crypto         from 'crypto';

const VALID_PLANS         = ['FREE', 'STARTER', 'PRO', 'ENTERPRISE'];
const VALID_MODES         = ['ORDER', 'BOOKING', 'BOTH'];           // legacy flow-control field
const VALID_BUSINESS_MODES = ['RESTAURANT', 'SALON', 'RETAIL'];     // canonical v15 business type

// ─── Duplicate-key error helper ───────────────────────────────────────────────
// MongoDB E11000 fires when a unique index is violated.
// Returns a human-readable 409 response payload, or null if not a dup-key error.
//
// Common culprits:
//   email                    → tenant tried to register twice
//   whatsapp.phoneNumberId   → stale non-sparse index (run scripts/fix-phone-index.js)
//   apiKey                   → crypto collision (astronomically rare)
//
function parseDuplicateKeyError(err) {
  if (err.code !== 11000) return null;

  const keyPattern = err.keyPattern || {};
  const keyValue   = err.keyValue   || {};

  if (keyPattern.email || keyValue.email) {
    return {
      status:  409,
      message: 'An account with this email already exists.',
      hint:    'Check your email for your API key. If you lost it, contact support.',
    };
  }

  if (keyPattern['whatsapp.phoneNumberId'] || keyValue['whatsapp.phoneNumberId']) {
    // This means the non-sparse index is still active in MongoDB.
    // Registering a new tenant is safe — the bug is the index, not the data.
    // Surface a clear actionable message instead of a generic 500.
    return {
      status:  500,
      message: 'Database index misconfiguration detected.',
      hint:    'Run: node scripts/fix-phone-index.js — then restart the server. This is a one-time fix.',
      debug:   'E11000 on whatsapp.phoneNumberId — index must be sparse. See scripts/fix-phone-index.js',
    };
  }

  if (keyPattern.apiKey || keyValue.apiKey) {
    return {
      status:  500,
      message: 'A rare key collision occurred. Please try again.',
    };
  }

  // Unknown duplicate field
  const field = Object.keys(keyPattern)[0] || 'unknown field';
  return {
    status:  409,
    message: `Duplicate value on field: ${field}.`,
  };
}

// ─── Step 1: Register ─────────────────────────────────────────────────────────
export const registerBusiness = async (req, res) => {
  try {
    const { name, email, businessName, plan } = req.body;

    if (!name?.trim() || !email?.trim() || !businessName?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Required fields: name, email, businessName',
        required: { name: 'Your full name', email: 'Your email address', businessName: 'Your business name' },
      });
    }

    const cleanEmail = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }

    // [ONB-4] Duplicate email — hint without exposing full account
    const existing = await Tenant.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
        hint: 'Check your email for your API key. If you lost it, contact support with your email address.',
      });
    }

    // [ONB-5] Plan validation — default to FREE with a note
    const resolvedPlan = VALID_PLANS.includes(plan?.toUpperCase()) ? plan.toUpperCase() : 'FREE';
    const planNote     = plan && !VALID_PLANS.includes(plan?.toUpperCase())
      ? `Plan "${plan}" not recognised — defaulted to FREE. Valid plans: ${VALID_PLANS.join(', ')}.`
      : null;

    const tenant = await Tenant.create({
      name:   name.trim(),
      email:  cleanEmail,
      plan:   resolvedPlan,
      status: 'PENDING',
    });

    logger.info('[Onboarding] New tenant registered', { tenantId: tenant._id, email: cleanEmail, plan: resolvedPlan });

    return res.status(201).json({
      success: true,
      message: '✅ Account created! Complete the next steps to go live.',
      ...(planNote ? { note: planNote } : {}),
      data: {
        tenantId: tenant._id,
        apiKey:   tenant.apiKey,
        plan:     tenant.plan,
        status:   tenant.status,
        nextSteps: [
          {
            step:        2,
            action:      'Configure your bot (menu, hours, tone)',
            method:      'POST',
            endpoint:    '/register/business',
            headers:     { 'x-api-key': tenant.apiKey },
            tip:         'You can do this now — even before connecting WhatsApp.',
            sampleBody: {
              name:         businessName.trim(),
              businessMode: 'RESTAURANT',  // RESTAURANT | SALON | RETAIL
              description:  'A short description of your business (used by AI for smart replies)',
              adminPhone:   '+220XXXXXXX',
              menu: [
                { name: 'Item 1', price: 50, available: true },
                { name: 'Item 2', price: 100, available: true },
              ],
              hours: {
                enabled: false,
                open:    8,   // integer hour 0–23
                close:   18,
              },
              payment: {
                wavePhone:    '+220XXXXXXX',
                currency:     'GMD',
                requireProof: true,
              },
            },
          },
          {
            step:        3,
            action:      'Connect WhatsApp',
            method:      'PUT',
            endpoint:    '/register/whatsapp',
            headers:     { 'x-api-key': tenant.apiKey },
            tip:         'Get phoneNumberId and accessToken from your Meta Developer dashboard.',
            guide:       'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
            sampleBody: {
              phoneNumberId: 'from Meta dashboard',
              accessToken:   'from Meta dashboard',
              phone:         '+220XXXXXXX',
            },
          },
        ],
      },
    });

  } catch (err) {
    logger.error('[Onboarding] registerBusiness error', { err: err.message });

    const dupError = parseDuplicateKeyError(err);
    if (dupError) {
      logger.warn('[Onboarding] Duplicate key on register', { key: err.keyPattern, hint: dupError.hint });
      return res.status(dupError.status).json({ success: false, message: dupError.message, ...(dupError.hint ? { hint: dupError.hint } : {}) });
    }

    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};
// [ONB-1] No longer requires WhatsApp to be connected first.
export const setupBusiness = async (req, res) => {
  try {
    const tenant = req.tenant;

    // [FIX-NULL-BODY] Guard against missing or non-object body.
    // Without Content-Type: application/json, express.json() leaves req.body as
    // undefined, and the first req.body.mode access below would crash the handler
    // with "Cannot read properties of undefined (reading 'mode')".
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a JSON object.',
        hint: 'Set the Content-Type: application/json header and send a valid JSON body.',
      });
    }

    const ALLOWED = [
      'name', 'description', 'mode', 'businessMode', 'menu', 'tone', 'hours',
      'adminPhone', 'customMessages', 'faq', 'payment', 'settings',
    ];

    // [FIX-NULL-ARRAY] Array-type fields sent as null crash Mongoose's array caster
    // with "Cannot read properties of null (reading 'length')" when runValidators:true
    // is active. Catch them early and return a helpful 400 instead.
    const ARRAY_FIELDS = new Set(['menu', 'services', 'faq']);
    for (const field of ARRAY_FIELDS) {
      if (req.body[field] === null) {
        return res.status(400).json({
          success: false,
          message: `"${field}" cannot be null — send an empty array [] to clear it.`,
        });
      }
    }

    // Validate mode if provided (legacy flow-control field: ORDER / BOOKING / BOTH)
    if (req.body.mode && !VALID_MODES.includes(req.body.mode?.toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: `Invalid mode "${req.body.mode}". Valid values: ${VALID_MODES.join(', ')}. To set business type use "businessMode" instead.`,
      });
    }

    // Validate businessMode if provided (RESTAURANT / SALON / RETAIL)
    if (req.body.businessMode && !VALID_BUSINESS_MODES.includes(req.body.businessMode?.toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: `Invalid businessMode "${req.body.businessMode}". Valid values: ${VALID_BUSINESS_MODES.join(', ')}`,
      });
    }

    // Build update payload — uppercase mode/businessMode to prevent enum failures
    const UPPERCASE_FIELDS = new Set(['mode', 'businessMode']);
    const data = { tenantId: tenant._id };
    for (const field of ALLOWED) {
      if (req.body[field] !== undefined) {
        data[field] = UPPERCASE_FIELDS.has(field) && typeof req.body[field] === 'string'
          ? req.body[field].toUpperCase()
          : req.body[field];
      }
    }

    // If WhatsApp is already connected, link the phoneNumberId
    if (tenant?.whatsapp?.phoneNumberId) {
      data.phoneNumberId = tenant.whatsapp.phoneNumberId;
    }

    // Upsert by tenantId — works whether WhatsApp is connected yet or not
    const business = await BusinessConfig.findOneAndUpdate(
      { tenantId: tenant._id },
      { $set: data },
      { new: true, upsert: true, runValidators: true }
    );

    logger.info('[Onboarding] Business configured', { tenantId: tenant._id });

    const isLive = tenant.whatsapp?.connected === true;

    return res.status(200).json({
      success: true,
      message: isLive
        ? '✅ Bot updated and live!'
        : '✅ Bot configured! Now connect WhatsApp (step 3) to go live.',
      data: business,
      ...(isLive ? {} : {
        nextStep: {
          step:     3,
          action:   'Connect WhatsApp',
          method:   'PUT',
          endpoint: '/register/whatsapp',
        },
      }),
    });

  } catch (err) {
    logger.error('[Onboarding] setupBusiness error', { err: err.message });

    const dupError = parseDuplicateKeyError(err);
    if (dupError) {
      return res.status(dupError.status).json({ success: false, message: dupError.message, ...(dupError.hint ? { hint: dupError.hint } : {}) });
    }

    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ─── Step 3: Connect WhatsApp ────────────────────────────────────────────────
// [ONB-6] Auto-creates BusinessConfig if step 2 was skipped.
export const connectWhatsApp = async (req, res) => {
  try {
    const tenant = req.tenant;
    const { phoneNumberId, accessToken, phone, verifyToken, apiVersion } = req.body;

    if (!phoneNumberId?.trim() || !accessToken?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Required: phoneNumberId and accessToken (from Meta Developer dashboard)',
        guide:   'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
      });
    }

    // Check for duplicate across other tenants
    const duplicate = await Tenant.findOne({
      'whatsapp.phoneNumberId': phoneNumberId.trim(),
      _id: { $ne: tenant._id },
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'This WhatsApp number is already connected to another account.',
      });
    }

    const resolvedVerifyToken = verifyToken?.trim() || crypto.randomBytes(16).toString('hex');

    tenant.whatsapp = {
      ...tenant.whatsapp,
      phone:          phone?.trim() || null,
      phoneNumberId:  phoneNumberId.trim(),
      accessToken:    accessToken.trim(),
      verifyToken:    resolvedVerifyToken,
      apiVersion:     apiVersion?.trim() || process.env.WA_API_VERSION || 'v21.0',
      connected:      true,
      tokenUpdatedAt: new Date(),
    };
    tenant.status = 'ACTIVE';
    await tenant.save();

    // [ONB-6] Ensure BusinessConfig exists + phoneNumberId is linked
    await BusinessConfig.findOneAndUpdate(
      { tenantId: tenant._id },
      {
        $set:      { phoneNumberId: phoneNumberId.trim() },
        $setOnInsert: {
          tenantId:     tenant._id,
          name:         tenant.name,
          businessMode: 'RESTAURANT', // [FIX-1] was mode:'BOTH' (legacy); businessMode is the v15 canonical field
        },
      },
      { upsert: true, new: true }
    );

    logger.info('[Onboarding] WhatsApp connected', { tenantId: tenant._id, phoneNumberId });

    const webhookUrl = `${process.env.BASE_URL || 'https://your-domain.com'}/webhook/${phoneNumberId.trim()}`;

    return res.json({
      success: true,
      message: '🎉 WhatsApp connected! Your bot is now LIVE.',
      data: {
        status:      'ACTIVE',
        webhookUrl,
        verifyToken: resolvedVerifyToken,
        instructions: [
          `1. Go to: https://developers.facebook.com → Your App → WhatsApp → Configuration`,
          `2. Set Callback URL to: ${webhookUrl}`,
          `3. Set Verify Token to: ${resolvedVerifyToken}`,
          `4. Subscribe to: messages, message_deliveries`,
          `5. Send "Hi" to your WhatsApp number to test!`,
        ],
      },
    });

  } catch (err) {
    logger.error('[Onboarding] connectWhatsApp error', { err: err.message });

    const dupError = parseDuplicateKeyError(err);
    if (dupError) {
      return res.status(dupError.status).json({ success: false, message: dupError.message, ...(dupError.hint ? { hint: dupError.hint } : {}) });
    }

    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ─── Status check ─────────────────────────────────────────────────────────────
// [ONB-3] Richer status with % complete and per-step guidance.
export const getOnboardingStatus = async (req, res) => {
  try {
    const tenant   = req.tenant;
    const business = await BusinessConfig.findOne({ tenantId: tenant._id })
      .select('name menu mode businessMode adminPhone description payment')
      .lean();

    const hasName    = !!business?.name;
    const hasMenu    = Array.isArray(business?.menu) && business.menu.length > 0;
    const hasAdmin   = !!business?.adminPhone;
    const hasWA      = tenant.whatsapp?.connected === true;
    const hasPayment = !!business?.payment?.wavePhone;
    const hasAI      = !!process.env.GROQ_API_KEY;

    const steps = [
      {
        step:   1,
        label:  'Account created',
        done:   true,
        detail: `Registered as ${tenant.email}`,
      },
      {
        step:   2,
        label:  'Bot configured',
        done:   hasName && hasAdmin,
        detail: hasName && hasAdmin
          ? `Mode: ${business?.businessMode || 'RESTAURANT'}, Menu items: ${business?.menu?.length || 0}` // [FIX-7] businessMode is canonical
          : 'POST /register/business with name, adminPhone, menu, etc.',
        subChecks: {
          name:        hasName,
          adminPhone:  hasAdmin,
          menu:        hasMenu,
          payment:     hasPayment,
          description: !!business?.description,
        },
      },
      {
        step:   3,
        label:  'WhatsApp connected',
        done:   hasWA,
        detail: hasWA
          ? `Connected: ${tenant.whatsapp?.phone || tenant.whatsapp?.phoneNumberId}`
          : 'PUT /register/whatsapp with phoneNumberId + accessToken from Meta',
      },
    ];

    const doneCount  = steps.filter(s => s.done).length;
    const allDone    = doneCount === steps.length;
    const pctComplete = Math.round((doneCount / steps.length) * 100);

    res.json({
      success: true,
      data: {
        status:      tenant.status,
        allDone,
        pctComplete,
        steps,
        extras: {
          paymentConfigured: hasPayment,
          groqActive:        hasAI,
          groqNote:          hasAI ? 'AI replies active ✅' : 'Set GROQ_API_KEY for smart AI replies',
        },
        ...(allDone
          ? { message: '🎉 Your bot is fully set up and live!' }
          : { nextStep: steps.find(s => !s.done) }
        ),
      },
    });

  } catch (err) {
    logger.error('[Onboarding] getStatus error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
