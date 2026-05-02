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
 * Step 2 no longer requires WhatsApp to be connected first —
 *         businesses can configure menu, hours, tone WHILE waiting for Meta approval.
 * Better validation messages with actionable guidance.
 * Status endpoint now includes % complete and per-step guidance.
 * Duplicate email returns existing tenantId hint (not just "already exists").
 * Plan validation defaults gracefully to FREE with a note.
 * WhatsApp connect step auto-creates BusinessConfig if not yet done.
 * Status endpoint checks Groq health as optional indicator.
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
// Returns a human-readable response payload, or null if not a dup-key error.
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

  if (keyPattern['whatsapp.phoneNumberId'] || keyValue['whatsapp.phoneNumberId'] !== undefined) {
    // Only show the WA-conflict message when an actual non-null phoneNumberId collided.
    // If keyValue is null it means the sparse index is incorrectly indexing null values —
    // that is a server-side schema misconfiguration, not a user error.
    if (keyValue['whatsapp.phoneNumberId'] === null) {
      return {
        status:  500,
        message: 'A rare registration conflict occurred. Please try again.',
      };
    }
    return {
      status:  409,
      message: 'This WhatsApp number is already connected to another account.',
    };
  }

  if (keyPattern.apiKey || keyValue.apiKey) {
    return {
      status:  500,
      message: 'A rare key collision occurred. Please try again.',
    };
  }

  const field = Object.keys(keyPattern)[0] || 'unknown field';
  return {
    status:  409,
    message: `Duplicate value on field: ${field}.`,
  };
}

// ─── Step 1: Register ─────────────────────────────────────────────────────────
export const registerBusiness = async (req, res) => {
  try {
    const { name, email, businessName, phone, plan } = req.body;

    if (!name?.trim() || !email?.trim() || !businessName?.trim() || !phone?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Required fields: name, email, businessName, phone',
        required: {
          name:         'Your full name',
          email:        'Your email address',
          businessName: 'Your business name',
          phone:        'Your WhatsApp phone number (e.g. +2207000000)',
        },
      });
    }

    const cleanEmail = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }

    // Basic phone validation — must start with + and contain only digits after that
    const cleanPhone = phone.trim();
    if (!/^\+\d{7,15}$/.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number. Use international format starting with + (e.g. +2207000000)',
      });
    }

    // Duplicate email — hint without exposing full account
    const existing = await Tenant.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
        hint: 'Check your email for your API key. If you lost it, contact support with your email address.',
      });
    }

    // Plan validation — default to FREE with a note
    const resolvedPlan = VALID_PLANS.includes(plan?.toUpperCase()) ? plan.toUpperCase() : 'FREE';
    const planNote     = plan && !VALID_PLANS.includes(plan?.toUpperCase())
      ? `Plan "${plan}" not recognised — defaulted to FREE. Valid plans: ${VALID_PLANS.join(', ')}.`
      : null;

    const tenant = await Tenant.create({
      name:   name.trim(),
      email:  cleanEmail,
      plan:   resolvedPlan,
      status: 'PENDING',
      // Store the user's own phone number (not the Meta phoneNumberId) so it's
      // available for admin notifications before WhatsApp is fully connected.
      'whatsapp.phone': cleanPhone,
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
        phone:    cleanPhone,
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
              adminPhone:   cleanPhone,
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
                wavePhone:    cleanPhone,
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
              phone:         cleanPhone,
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
// No longer requires WhatsApp to be connected first.
export const setupBusiness = async (req, res) => {
  try {
    const tenant = req.tenant;

    // Guard against missing or non-object body.
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
      'name', 'description', 'mode', 'businessMode', 'menu', 'services', 'tone', 'hours',
      'adminPhone', 'customMessages', 'faq', 'payment', 'settings',
    ];

    // Array-type fields sent as null crash Mongoose's array caster
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
// Auto-creates BusinessConfig if step 2 was skipped.
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

    // Ensure BusinessConfig exists + phoneNumberId is linked
    await BusinessConfig.findOneAndUpdate(
      { tenantId: tenant._id },
      {
        $set:      { phoneNumberId: phoneNumberId.trim() },
        $setOnInsert: {
          tenantId:     tenant._id,
          name:         tenant.name,
          businessMode: 'RESTAURANT', // was mode:'BOTH' (legacy); businessMode is the v15 canonical field
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
// Richer status with % complete and per-step guidance.
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
          ? `Mode: ${business?.businessMode || 'RESTAURANT'}, Menu items: ${business?.menu?.length || 0}` // businessMode is canonical
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

// ─── Meta Embedded Signup OAuth Callback ──────────────────────────────────────
// GET /onboarding/callback?code=...&state=<tenantId>
// 
// Meta redirects here after the user completes Embedded Signup.
// `code` is exchanged for an access token; WABA + phone are auto-fetched and
// saved against the tenant identified by `state` (tenantId).
// 
// [CALLBACK-1] This route was MISSING — META_REDIRECT_URI pointed here but no
//              handler existed → "Cannot GET /onboarding/callback".
// [CALLBACK-2] On Meta OAuth error, returns structured JSON (API-friendly).
// [CALLBACK-3] On success, redirects to FRONTEND_URL if set, else JSON.
export const handleMetaCallback = async (req, res) => {
  try {
    const { code, state, error: oauthError, error_description } = req.query;

    // OAuth error returned by Meta
    if (oauthError) {
      logger.warn('[Onboarding/callback] Meta OAuth error', { oauthError, error_description });
      return res.status(400).json({
        success: false,
        message: 'Meta OAuth failed.',
        error:   oauthError,
        detail:  error_description || 'No additional detail from Meta.',
      });
    }

    if (!code) {
      return res.status(400).json({
        success: false,
        message: 'Missing "code" query parameter from Meta OAuth redirect.',
      });
    }

    // Resolve tenant from `state` (tenantId passed when starting OAuth flow)
    let tenant = null;
    if (state) {
      try { tenant = await Tenant.findById(state); } catch (_) {}
    }

    const { META_APP_ID, META_APP_SECRET, META_REDIRECT_URI } = process.env;
    const WA_API_VERSION = process.env.WA_API_VERSION || 'v21.0';

    if (!META_APP_ID || !META_APP_SECRET || !META_REDIRECT_URI) {
      return res.status(500).json({
        success: false,
        message: 'Server misconfiguration: META_APP_ID, META_APP_SECRET, or META_REDIRECT_URI is not set.',
      });
    }

    // Step 1: Exchange code for access token
    const tokenRes  = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/oauth/access_token` +
      `?client_id=${META_APP_ID}` +
      `&client_secret=${META_APP_SECRET}` +
      `&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}` +
      `&code=${code}`
    );
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      logger.error('[Onboarding/callback] Token exchange failed', { tokenData });
      return res.status(400).json({
        success: false,
        message: 'Failed to exchange Meta authorisation code for an access token.',
        detail:  tokenData.error?.message || 'No detail from Meta.',
      });
    }

    const userToken = tokenData.access_token;

    // Step 2: Fetch WABA
    const wabaRes  = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/me/whatsapp_business_accounts?access_token=${userToken}`
    );
    const wabaData = await wabaRes.json();
    const wabaId   = wabaData.data?.[0]?.id;

    if (!wabaId) {
      return res.status(400).json({
        success: false,
        message: 'No WhatsApp Business Account found for this Meta account.',
      });
    }

    // Step 3: Fetch phone numbers
    const phonesRes  = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${wabaId}/phone_numbers?access_token=${userToken}`
    );
    const phonesData = await phonesRes.json();
    const firstPhone = phonesData.data?.[0];

    if (!firstPhone?.id) {
      return res.status(400).json({
        success: false,
        message: 'No phone number found in the WhatsApp Business Account.',
      });
    }

    const phoneNumberId = firstPhone.id;
    const phone         = firstPhone.display_phone_number || null;

    // Step 4: Persist if tenant was resolved from state
    if (tenant) {
      const duplicate = await Tenant.findOne({
        'whatsapp.phoneNumberId': phoneNumberId,
        _id: { $ne: tenant._id },
      });

      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: 'This WhatsApp number is already connected to another account.',
        });
      }

      const resolvedVerifyToken = tenant.whatsapp?.verifyToken || crypto.randomBytes(16).toString('hex');

      tenant.whatsapp = {
        ...tenant.whatsapp,
        phone,
        phoneNumberId,
        wabaId,
        accessToken:    userToken,
        verifyToken:    resolvedVerifyToken,
        apiVersion:     WA_API_VERSION,
        connected:      true,
        tokenUpdatedAt: new Date(),
      };
      tenant.status = 'ACTIVE';
      await tenant.save();

      await BusinessConfig.findOneAndUpdate(
        { tenantId: tenant._id },
        {
          $set:         { phoneNumberId },
          $setOnInsert: { tenantId: tenant._id, name: tenant.name, businessMode: 'RESTAURANT' },
        },
        { upsert: true, new: true }
      );

      logger.info('[Onboarding/callback] WhatsApp auto-linked via Meta callback', {
        tenantId: tenant._id, phoneNumberId,
      });

      const webhookUrl  = `${process.env.BASE_URL || 'https://your-domain.com'}/webhook/${phoneNumberId}`;
      const frontendUrl = process.env.FRONTEND_URL;

      if (frontendUrl) {
        return res.redirect(
          `${frontendUrl}?connected=true&phoneNumberId=${phoneNumberId}&verifyToken=${resolvedVerifyToken}`
        );
      }

      return res.json({
        success: true,
        message: '🎉 WhatsApp connected via Meta Embedded Signup! Your bot is now LIVE.',
        data: {
          tenantId:    tenant._id,
          status:      'ACTIVE',
          phone,
          phoneNumberId,
          wabaId,
          verifyToken: resolvedVerifyToken,
          webhookUrl,
          instructions: [
            `1. Go to: https://developers.facebook.com → Your App → WhatsApp → Configuration`,
            `2. Set Callback URL to: ${webhookUrl}`,
            `3. Set Verify Token to: ${resolvedVerifyToken}`,
            `4. Subscribe to: messages, message_deliveries`,
            `5. Send "Hi" to your WhatsApp number to test!`,
          ],
        },
      });
    }

    // No valid state/tenantId — return raw data for manual linking
    logger.warn('[Onboarding/callback] No valid tenantId in state — returning raw data');
    return res.json({
      success: true,
      message: 'Meta authorisation successful. Link this to your tenant via PUT /register/whatsapp.',
      data: {
        phone,
        phoneNumberId,
        wabaId,
        accessToken: userToken,
        hint: 'Pass these values in PUT /register/whatsapp with your x-api-key header.',
      },
    });

  } catch (err) {
    logger.error('[Onboarding/callback] Unexpected error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error processing Meta callback.' });
  }
};
