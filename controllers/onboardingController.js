/**
 * controllers/onboardingController.js — Dreamline Sales Bot v7.0
 *
 * Thin controller — all business logic lives in services/onboardingService.js.
 *
 * Onboarding flows:
 *
 * ── SIMPLE (2 requests) ─────────────────────────────────────────────────────
 *   PUT  /register/whatsapp   → Step 1: validate Meta + create tenant → returns apiKey (ONCE)
 *   POST /register/business   → Step 2: configure bot (basic or full)
 *
 * ── UNIFIED (1 request) ─────────────────────────────────────────────────────
 *   POST /onboarding/full     → Step 1 + Step 2 in one request → returns apiKey (ONCE)
 *
 * ── STATUS ──────────────────────────────────────────────────────────────────
 *   GET  /register/status     → onboarding progress (requires x-api-key)
 *
 * ── META OAUTH ──────────────────────────────────────────────────────────────
 *   GET  /onboarding/callback → Meta Embedded Signup redirect target (public)
 *
 * Security rules enforced here:
 *   - apiKey is returned ONLY from connectWhatsApp and fullOnboarding — never again
 *   - accessToken is NEVER returned in any response
 *   - All responses use the Tenant toJSON transform (strips accessToken automatically)
 */

import crypto         from 'crypto';
import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import logger         from '../config/logger.js';
import {
  connectWhatsAppAndCreateTenant,
  setupBusinessConfig,
  fullOnboarding,
  getOnboardingStatusData,
} from '../services/onboardingService.js';

// ─── Duplicate-key error parser ───────────────────────────────────────────────
function parseDuplicateKeyError(err) {
  if (err.code !== 11000) return null;
  const kp = err.keyPattern || {};
  const kv = err.keyValue   || {};

  if (kp.email || kv.email)
    return { status: 409, message: 'An account with this email already exists.' };

  if (kp['whatsapp.phoneNumberId'] || kv['whatsapp.phoneNumberId'] !== undefined) {
    if (kv['whatsapp.phoneNumberId'] === null)
      return { status: 500, message: 'A rare registration conflict occurred. Please try again.' };
    return { status: 409, message: 'This WhatsApp number is already connected to another account.' };
  }

  if (kp.apiKey || kv.apiKey)
    return { status: 500, message: 'A rare key collision occurred. Please try again.' };

  return { status: 409, message: `Duplicate value: ${Object.keys(kp)[0] || 'unknown field'}.` };
}

// ─── Step 1: Connect WhatsApp → creates tenant → returns apiKey (ONCE) ────────
// Also handles Step 3 of the legacy email-first flow: when a tenant already
// exists (identified by x-api-key auth from requireApiKeyForOnboarding or by
// passing the apiKey in body), this updates the existing tenant with WhatsApp
// credentials instead of creating a new one.
export const connectWhatsApp = async (req, res) => {
  try {
    const { phoneNumberId, accessToken, phone } = req.body;

    // ── If this request is authenticated (Step 3 of email-first flow) ──────────
    // req.tenant is populated by requireApiKeyForOnboarding middleware when
    // the client sends x-api-key. In that case, update the existing tenant.
    if (req.tenant) {
      const { validateMetaCredentials } = await import('../services/onboardingService.js');
      const WA_API_VERSION = process.env.WA_API_VERSION || process.env.META_API_VERSION || 'v21.0';

      if (!phoneNumberId?.trim() || !accessToken?.trim()) {
        return res.status(400).json({ success: false, message: 'phoneNumberId and accessToken are required.' });
      }

      // Check if this phoneNumberId is already used by a DIFFERENT tenant
      const duplicate = await Tenant.findOne({
        'whatsapp.phoneNumberId': phoneNumberId.trim(),
        _id: { $ne: req.tenant._id },
      });
      if (duplicate) {
        return res.status(409).json({ success: false, message: 'This WhatsApp number is already connected to another account.' });
      }

      // Validate with Meta
      const validation = await validateMetaCredentials(phoneNumberId.trim(), accessToken.trim());
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          message: `Meta rejected these credentials: ${validation.error}`,
          hint: 'Ensure accessToken is valid and phoneNumberId belongs to your WhatsApp Business Account.',
        });
      }

      const crypto       = (await import('crypto')).default;
      const verifyToken  = req.tenant.whatsapp?.verifyToken || crypto.randomBytes(16).toString('hex');
      const cleanPhone   = phone?.trim() || validation.displayPhone || null;

      req.tenant.whatsapp = {
        ...req.tenant.whatsapp?.toObject?.() || {},
        phone:          cleanPhone,
        phoneNumberId:  phoneNumberId.trim(),
        wabaId:         validation.wabaId || req.tenant.whatsapp?.wabaId || null,
        accessToken:    accessToken.trim(),
        verifyToken,
        apiVersion:     WA_API_VERSION,
        connected:      true,
        tokenUpdatedAt: new Date(),
      };
      req.tenant.status         = 'ACTIVE';
      req.tenant.onboardingStep = Math.max(req.tenant.onboardingStep || 0, 1);
      await req.tenant.save();

      await BusinessConfig.findOneAndUpdate(
        { tenantId: req.tenant._id },
        {
          $set:         { phoneNumberId: phoneNumberId.trim() },
          $setOnInsert: { tenantId: req.tenant._id, name: '', businessMode: 'RESTAURANT', botEnabled: true },
        },
        { upsert: true, new: true },
      );

      const webhookUrl = `${process.env.BASE_URL || 'https://your-domain.com'}/webhook/${phoneNumberId.trim()}`;
      logger.info('[Onboarding] connectWhatsApp: updated existing tenant', { tenantId: req.tenant._id, phoneNumberId });

      return res.json({
        success: true,
        message: '✅ WhatsApp connected to your existing account!',
        data: {
          tenantId: req.tenant._id,
          onboardingStep: req.tenant.onboardingStep,
          whatsapp: {
            phone:         cleanPhone,
            phoneNumberId: phoneNumberId.trim(),
            wabaId:        validation.wabaId || null,
            connected:     true,
          },
          webhook: {
            callbackUrl: webhookUrl,
            verifyToken,
            instructions: [
              `1. Go to Meta → Your App → WhatsApp → Configuration`,
              `2. Set Callback URL: ${webhookUrl}`,
              `3. Set Verify Token: ${verifyToken}`,
              `4. Subscribe to: messages`,
            ],
          },
        },
      });
    }

    // ── No auth header: fresh registration (Step 1 of WhatsApp-first flow) ─────
    const result = await connectWhatsAppAndCreateTenant({ phoneNumberId, accessToken, phone });

    if (!result.success) {
      return res.status(result.status || 400).json({ success: false, message: result.message, hint: result.hint, guide: result.guide });
    }

    const { tenant, apiKey, verifyToken, webhookUrl } = result;

    return res.status(201).json({
      success: true,
      message: '✅ WhatsApp connected! Your tenant account is created.',
      // ⚠️  apiKey is returned EXACTLY ONCE — store it securely, it will never be shown again.
      data: {
        tenantId:       tenant._id,
        apiKey,
        onboardingStep: 1,
        whatsapp: {
          phone:         tenant.whatsapp.phone,
          phoneNumberId: tenant.whatsapp.phoneNumberId,
          wabaId:        tenant.whatsapp.wabaId,
          connected:     true,
        },
        webhook: {
          callbackUrl: webhookUrl,
          verifyToken,
          instructions: [
            `1. Go to Meta → Your App → WhatsApp → Configuration`,
            `2. Set Callback URL: ${webhookUrl}`,
            `3. Set Verify Token: ${verifyToken}`,
            `4. Subscribe to: messages`,
          ],
        },
        nextStep: {
          step:     2,
          action:   'Configure your bot (name, menu, hours, etc.)',
          method:   'POST',
          endpoint: '/register/business',
          headers:  { 'x-api-key': '(your apiKey above)' },
        },
      },
    });

  } catch (err) {
    logger.error('[Onboarding] connectWhatsApp error', { err: err.message });
    const dup = parseDuplicateKeyError(err);
    if (dup) return res.status(dup.status).json({ success: false, message: dup.message });
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ─── Step 2: Configure business ───────────────────────────────────────────────
export const setupBusiness = async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a JSON object.',
        hint:    'Set Content-Type: application/json header.',
      });
    }

    const result = await setupBusinessConfig(req.tenant, req.body);

    if (!result.success) {
      return res.status(result.status || 400).json({ success: false, message: result.message });
    }

    const { business, onboardingStep, isFullMode } = result;

    return res.json({
      success: true,
      message: isFullMode
        ? '✅ Full bot configuration saved! Your bot is ready to use.'
        : '✅ Basic bot setup complete. Add menu, hours, and payment when ready.',
      data: {
        onboardingStep,
        business,
        ...(onboardingStep < 3 ? {
          tip: 'Use POST /business/menu, /business/hours, /business/payment to complete advanced config.',
        } : {}),
      },
    });

  } catch (err) {
    logger.error('[Onboarding] setupBusiness error', { err: err.message });
    const dup = parseDuplicateKeyError(err);
    if (dup) return res.status(dup.status).json({ success: false, message: dup.message });
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ─── Unified: Step 1 + Step 2 in one request ─────────────────────────────────
export const fullOnboardingHandler = async (req, res) => {
  try {
    const { whatsapp, business } = req.body || {};

    const result = await fullOnboarding({ whatsapp, business });

    if (!result.success) {
      return res.status(result.status || 400).json({ success: false, message: result.message, hint: result.hint });
    }

    const { tenant, apiKey, verifyToken, webhookUrl, business: biz, onboardingStep } = result;

    return res.status(201).json({
      success: true,
      message: '🎉 Full onboarding complete! Your bot is live.',
      data: {
        tenantId: tenant._id,
        // ⚠️  apiKey returned ONCE only — store it securely
        apiKey,
        onboardingStep,
        whatsapp: {
          phone:         tenant.whatsapp.phone,
          phoneNumberId: tenant.whatsapp.phoneNumberId,
          wabaId:        tenant.whatsapp.wabaId,
          connected:     true,
        },
        business: biz || null,
        webhook: {
          callbackUrl: webhookUrl,
          verifyToken,
          instructions: [
            `1. Go to Meta → Your App → WhatsApp → Configuration`,
            `2. Set Callback URL: ${webhookUrl}`,
            `3. Set Verify Token: ${verifyToken}`,
            `4. Subscribe to: messages`,
          ],
        },
      },
    });

  } catch (err) {
    logger.error('[Onboarding] fullOnboarding error', { err: err.message });
    const dup = parseDuplicateKeyError(err);
    if (dup) return res.status(dup.status).json({ success: false, message: dup.message });
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ─── Status ───────────────────────────────────────────────────────────────────
export const getOnboardingStatus = async (req, res) => {
  try {
    const data = await getOnboardingStatusData(req.tenant);
    res.json({ success: true, data });
  } catch (err) {
    logger.error('[Onboarding] getStatus error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Legacy: Step 1 email/name registration (kept for backward compat) ────────
// Previously POST /register — still works if clients use it, but WhatsApp-first
// is now the recommended flow.
export const registerBusiness = async (req, res) => {
  try {
    const { name, email, businessName, phone, plan } = req.body;

    if (!name?.trim() || !email?.trim() || !businessName?.trim() || !phone?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Required fields: name, email, businessName, phone',
        hint:    'Or use PUT /register/whatsapp to onboard directly with your WhatsApp credentials.',
      });
    }

    const cleanEmail = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ success: false, message: 'Invalid email address.' });
    }
    const cleanPhone = phone.trim();
    if (!/^\+\d{7,15}$/.test(cleanPhone)) {
      return res.status(400).json({ success: false, message: 'Use international format: +2207000000' });
    }

    const existing = await Tenant.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
        hint:    'Check your email for your API key.',
      });
    }

    const VALID_PLANS  = ['FREE', 'STARTER', 'PRO', 'ENTERPRISE'];
    const resolvedPlan = VALID_PLANS.includes(plan?.toUpperCase()) ? plan.toUpperCase() : 'FREE';

    const tenant = await Tenant.create({
      name:          name.trim(),
      email:         cleanEmail,
      plan:          resolvedPlan,
      status:        'PENDING',
      onboardingStep: 0,
      adminPhone:    cleanPhone,
      'whatsapp.phone': cleanPhone,
    });

    logger.info('[Onboarding] Legacy account created', { tenantId: tenant._id, email: cleanEmail });

    return res.status(201).json({
      success: true,
      message: '✅ Account created! Now connect your WhatsApp number.',
      data: {
        tenantId: tenant._id,
        apiKey:   tenant.apiKey,
        plan:     tenant.plan,
        status:   tenant.status,
        nextStep: {
          step:     1,
          action:   'Connect WhatsApp (recommended: use PUT /register/whatsapp directly instead)',
          method:   'PUT',
          endpoint: '/register/whatsapp',
          headers:  { 'x-api-key': tenant.apiKey },
        },
      },
    });

  } catch (err) {
    logger.error('[Onboarding] registerBusiness error', { err: err.message });
    const dup = parseDuplicateKeyError(err);
    if (dup) return res.status(dup.status).json({ success: false, message: dup.message, hint: dup.hint });
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ─── Meta Embedded Signup OAuth Callback ──────────────────────────────────────
export const handleMetaCallback = async (req, res) => {
  try {
    // ── [FIX] Webhook verification — Meta sends this when you click "Verify and save"
    // in the developer dashboard. Must be handled BEFORE the OAuth code check,
    // otherwise Meta gets "Missing code" and verification always fails.
    // NOTE: Webhook verification belongs at /webhook — this handler exists at
    // /onboarding/callback which is the OAuth redirect URI. If you see this
    // path being hit for webhook verification it means the Meta dashboard
    // "Callback URL" is set to /onboarding/callback instead of /webhook.
    // Fix that in Meta dashboard → Configuration → Callback URL → use /webhook.
    // This guard prevents a confusing 400 in the meantime.
    if (req.query['hub.mode'] === 'subscribe') {
      const token     = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (token === process.env.META_WEBHOOK_VERIFY_TOKEN && challenge) {
        logger.warn(
          '[OnboardingCallback] Webhook verification hit /onboarding/callback — ' +
          'update Meta dashboard Callback URL to /webhook instead.'
        );
        return res.status(200).send(challenge);
      }
      return res.sendStatus(403);
    }

    const { code, state, error: oauthError, error_description } = req.query;

    if (oauthError) {
      return res.status(400).json({
        success: false,
        message: 'Meta OAuth failed.',
        error: oauthError,
        detail: error_description || 'No additional detail.',
      });
    }

    if (!code) {
      return res.status(400).json({ success: false, message: 'Missing "code" query parameter from Meta OAuth redirect.' });
    }

    const { META_APP_ID, META_APP_SECRET, META_REDIRECT_URI } = process.env;
    const WA_API_VERSION = process.env.WA_API_VERSION || 'v21.0';

    if (!META_APP_ID || !META_APP_SECRET || !META_REDIRECT_URI) {
      return res.status(500).json({ success: false, message: 'Server misconfiguration: META env vars missing.' });
    }

    // Exchange code for token
    const tokenRes  = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/oauth/access_token` +
      `?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}` +
      `&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}&code=${code}`
    );
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return res.status(400).json({
        success: false,
        message: 'Failed to exchange Meta code for access token.',
        detail:  tokenData.error?.message || 'No detail from Meta.',
      });
    }

    const userToken = tokenData.access_token;

    // Fetch WABA
    const wabaRes  = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/me/whatsapp_business_accounts?access_token=${userToken}`
    );
    const wabaData = await wabaRes.json();
    const wabaId   = wabaData.data?.[0]?.id;
    if (!wabaId) return res.status(400).json({ success: false, message: 'No WhatsApp Business Account found.' });

    // Fetch phone numbers
    const phonesRes  = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${wabaId}/phone_numbers?access_token=${userToken}`
    );
    const phonesData = await phonesRes.json();
    const firstPhone = phonesData.data?.[0];
    if (!firstPhone?.id) return res.status(400).json({ success: false, message: 'No phone number found in WABA.' });

    const phoneNumberId = firstPhone.id;
    const phone         = firstPhone.display_phone_number || null;

    // Resolve tenant from state
    let tenant = null;
    if (state) {
      try { tenant = await Tenant.findById(state); } catch (_) {}
    }

    if (tenant) {
      const duplicate = await Tenant.findOne({
        'whatsapp.phoneNumberId': phoneNumberId,
        _id: { $ne: tenant._id },
      });
      if (duplicate) {
        return res.status(409).json({ success: false, message: 'This WhatsApp number is already registered.' });
      }

      const resolvedVerifyToken = tenant.whatsapp?.verifyToken || crypto.randomBytes(16).toString('hex');
      tenant.whatsapp = {
        ...tenant.whatsapp,
        phone, phoneNumberId, wabaId,
        accessToken:    userToken,
        verifyToken:    resolvedVerifyToken,
        apiVersion:     WA_API_VERSION,
        connected:      true,
        tokenUpdatedAt: new Date(),
      };
      tenant.status        = 'ACTIVE';
      tenant.onboardingStep = Math.max(tenant.onboardingStep || 0, 1);
      await tenant.save();

      await BusinessConfig.findOneAndUpdate(
        { tenantId: tenant._id },
        {
          $set:         { phoneNumberId },
          $setOnInsert: { tenantId: tenant._id, name: '', businessMode: 'RESTAURANT', botEnabled: true },
        },
        { upsert: true, new: true }
      );

      logger.info('[Onboarding/callback] WhatsApp linked', { tenantId: tenant._id, phoneNumberId });

      const webhookUrl  = `${process.env.BASE_URL || 'https://your-domain.com'}/webhook/${phoneNumberId}`;
      const frontendUrl = process.env.FRONTEND_URL;

      if (frontendUrl) {
        return res.redirect(
          `${frontendUrl}?connected=true&phoneNumberId=${phoneNumberId}&verifyToken=${resolvedVerifyToken}`
        );
      }

      return res.json({
        success: true,
        message: '🎉 WhatsApp connected via Meta Embedded Signup!',
        data: {
          tenantId: tenant._id, status: 'ACTIVE', phone, phoneNumberId, wabaId,
          verifyToken: resolvedVerifyToken, webhookUrl,
        },
      });
    }

    // No state — return safe partial data (no accessToken)
    logger.warn('[Onboarding/callback] No tenantId in state');
    return res.json({
      success: true,
      message: 'Meta authorisation successful but no tenantId in state. Re-trigger with ?state=<tenantId>.',
      data: { phone, phoneNumberId, wabaId },
    });

  } catch (err) {
    logger.error('[Onboarding/callback] Error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error processing Meta callback.' });
  }
};
