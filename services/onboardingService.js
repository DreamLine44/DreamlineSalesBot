/**
 * services/onboardingService.js — Dreamline Sales Bot v7.0
 *
 * Centralises all onboarding business logic so controllers stay thin.
 *
 * Exports:
 *   validateMetaCredentials    — live Graph API validation
 *   connectWhatsAppAndCreateTenant — Step 1 (atomic, with rollback)
 *   setupBusinessConfig        — Step 2 (basic + full mode)
 *   fullOnboarding             — POST /onboarding/full (Step 1 + 2 in one)
 *   getOnboardingStatusData    — GET /onboarding/status data builder
 */

import crypto         from 'crypto';
import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { encrypt }    from './cryptoService.js';
import logger         from '../config/logger.js';

const WA_VER = () => process.env.WA_API_VERSION || process.env.META_API_VERSION || 'v21.0';

const VALID_BUSINESS_MODES = ['RESTAURANT', 'SALON', 'RETAIL', 'BAKERY', 'SUPERMARKET', 'FASHION', 'COSMETICS', 'ELECTRONICS', 'PHARMACY', 'DELIVERY'];
const VALID_MODES          = ['ORDER', 'BOOKING', 'BOTH'];

// ─── Meta API validation ──────────────────────────────────────────────────────
export async function validateMetaCredentials(phoneNumberId, accessToken) {
  try {
    const url  = `https://graph.facebook.com/${WA_VER()}/${phoneNumberId}` +
                 `?fields=display_phone_number,verified_name&access_token=${accessToken}`;
    const res  = await fetch(url);
    const data = await res.json();

    if (data.error) {
      logger.warn('[OnboardingService] Meta validation failed', { error: data.error.message });
      return { valid: false, error: data.error.message || 'Invalid credentials.' };
    }

    let wabaId = null;
    try {
      const wabaRes  = await fetch(
        `https://graph.facebook.com/${WA_VER()}/me/whatsapp_business_accounts?access_token=${accessToken}`
      );
      const wabaData = await wabaRes.json();
      wabaId = wabaData.data?.[0]?.id || null;
    } catch (_) { /* wabaId optional */ }

    return { valid: true, wabaId, displayPhone: data.display_phone_number || null };

  } catch (err) {
    logger.error('[OnboardingService] Network error validating Meta', { err: err.message });
    return { valid: false, error: 'Could not reach Meta API. Check your internet connection.' };
  }
}

// ─── Step 1: Create tenant from WhatsApp credentials ─────────────────────────
export async function connectWhatsAppAndCreateTenant({ phoneNumberId, accessToken, phone }) {
  if (!phoneNumberId?.trim() || !accessToken?.trim()) {
    return {
      success: false, status: 400,
      message: 'phoneNumberId and accessToken are required.',
      guide: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
    };
  }

  // Duplicate check
  const existing = await Tenant.findOne({ 'whatsapp.phoneNumberId': phoneNumberId.trim() });
  if (existing) {
    return {
      success: false, status: 409,
      message: 'This WhatsApp number is already registered. Use your existing API key.',
    };
  }

  // Live Meta validation
  const validation = await validateMetaCredentials(phoneNumberId.trim(), accessToken.trim());
  if (!validation.valid) {
    return {
      success: false, status: 400,
      message: `Meta rejected these credentials: ${validation.error}`,
      hint: 'Ensure accessToken is valid and phoneNumberId belongs to your WhatsApp Business Account.',
    };
  }

  // Atomic creation with rollback
  let tenant = null;
  try {
    const verifyToken = crypto.randomBytes(16).toString('hex');
    const cleanPhone  = phone?.trim() || null;

    tenant = await Tenant.create({
      name:           cleanPhone || phoneNumberId.trim(),
      // Unique internal email placeholder — replaced when business name is set
      email:          `wa_${phoneNumberId.trim()}@dreamlinesalesbot.internal`,
      status:         'ACTIVE',
      onboardingStep: 1,
      adminPhone:     cleanPhone,
      whatsapp: {
        phone:          cleanPhone,
        phoneNumberId:  phoneNumberId.trim(),
        wabaId:         validation.wabaId || null,
        accessToken:    encrypt(accessToken.trim()),
        verifyToken,
        apiVersion:     WA_VER(),
        connected:      true,
        tokenUpdatedAt: new Date(),
      },
    });

    // Create BusinessConfig stub so Step 2 can upsert cleanly
    await BusinessConfig.findOneAndUpdate(
      { tenantId: tenant._id },
      {
        $setOnInsert: {
          tenantId:      tenant._id,
          phoneNumberId: phoneNumberId.trim(),
          name:          '',
          businessMode:  'RESTAURANT',
          botEnabled:    true,
        },
      },
      { upsert: true, new: true }
    );

    const webhookUrl = `${process.env.BASE_URL || 'https://your-domain.com'}/webhook/${phoneNumberId.trim()}`;

    logger.info('[OnboardingService] Tenant created', { tenantId: tenant._id, phoneNumberId });

    return {
      success:     true,
      tenant,
      apiKey:      tenant.apiKey,   // ← returned ONLY HERE, never again
      verifyToken,
      webhookUrl,
    };

  } catch (err) {
    if (tenant?._id) {
      await Tenant.findByIdAndDelete(tenant._id).catch(() => {});
      await BusinessConfig.deleteOne({ tenantId: tenant._id }).catch(() => {});
      logger.warn('[OnboardingService] Rolled back tenant after creation error', { tenantId: tenant._id });
    }
    throw err;
  }
}

// ─── Step 2: Business config setup ───────────────────────────────────────────
export async function setupBusinessConfig(tenant, body) {
  // Null-array guard
  for (const field of ['menu', 'services', 'faq']) {
    if (body[field] === null) {
      return { success: false, status: 400, message: `"${field}" cannot be null. Send [] to clear it.` };
    }
  }

  if (body.businessMode && !VALID_BUSINESS_MODES.includes(body.businessMode?.toUpperCase())) {
    return { success: false, status: 400, message: `Invalid businessMode. Valid: ${VALID_BUSINESS_MODES.join(', ')}` };
  }
  if (body.mode && !VALID_MODES.includes(body.mode?.toUpperCase())) {
    return { success: false, status: 400, message: `Invalid mode. Valid: ${VALID_MODES.join(', ')}` };
  }

  // Full mode = payload includes heavy config fields
  const FULL_FIELDS  = ['menu', 'hours', 'payment', 'faq', 'settings', 'services', 'tone', 'customMessages', 'nlp'];
  const isFullMode   = FULL_FIELDS.some(f => body[f] !== undefined);

  const ALLOWED      = [
    'name', 'description', 'mode', 'businessMode', 'menu', 'services',
    'tone', 'hours', 'adminPhone', 'customMessages', 'faq', 'payment',
    'settings', 'nlp', 'botEnabled',
  ];
  const UPPERCASE    = new Set(['mode', 'businessMode']);

  const patch = { tenantId: tenant._id };
  if (tenant.whatsapp?.phoneNumberId) patch.phoneNumberId = tenant.whatsapp.phoneNumberId;

  for (const field of ALLOWED) {
    if (body[field] !== undefined) {
      patch[field] = UPPERCASE.has(field) && typeof body[field] === 'string'
        ? body[field].toUpperCase()
        : body[field];
    }
  }

  const business = await BusinessConfig.findOneAndUpdate(
    { tenantId: tenant._id },
    { $set: patch },
    { new: true, upsert: true, runValidators: true }
  );

  // Update tenant identity fields + advance step
  const tenantPatch     = {};
  if (body.name?.trim())       tenantPatch.name       = body.name.trim();
  if (body.adminPhone?.trim()) tenantPatch.adminPhone = body.adminPhone.trim();
  tenantPatch.onboardingStep = isFullMode ? 3 : Math.max(tenant.onboardingStep || 0, 2);

  await Tenant.findByIdAndUpdate(tenant._id, { $set: tenantPatch });

  logger.info('[OnboardingService] Business configured', {
    tenantId: tenant._id, step: tenantPatch.onboardingStep, fullMode: isFullMode,
  });

  return { success: true, business, onboardingStep: tenantPatch.onboardingStep, isFullMode };
}

// ─── Unified: Step 1 + Step 2 in one request ─────────────────────────────────
export async function fullOnboarding({ whatsapp, business }) {
  if (!whatsapp?.phoneNumberId || !whatsapp?.accessToken) {
    return { success: false, status: 400, message: 'whatsapp.phoneNumberId and whatsapp.accessToken are required.' };
  }

  const step1 = await connectWhatsAppAndCreateTenant(whatsapp);
  if (!step1.success) return step1;

  const tenant = step1.tenant;

  try {
    let bizResult = null;
    if (business && typeof business === 'object' && Object.keys(business).length > 0) {
      bizResult = await setupBusinessConfig(tenant, business);
      if (!bizResult.success) {
        await Tenant.findByIdAndDelete(tenant._id).catch(() => {});
        await BusinessConfig.deleteOne({ tenantId: tenant._id }).catch(() => {});
        return bizResult;
      }
    }

    return {
      success:        true,
      tenant,
      apiKey:         step1.apiKey,   // ← returned ONLY HERE
      verifyToken:    step1.verifyToken,
      webhookUrl:     step1.webhookUrl,
      business:       bizResult?.business || null,
      onboardingStep: bizResult?.onboardingStep || 1,
    };

  } catch (err) {
    await Tenant.findByIdAndDelete(tenant._id).catch(() => {});
    await BusinessConfig.deleteOne({ tenantId: tenant._id }).catch(() => {});
    logger.error('[OnboardingService] fullOnboarding rollback', { err: err.message });
    throw err;
  }
}

// ─── Status builder ───────────────────────────────────────────────────────────
export async function getOnboardingStatusData(tenant) {
  const business = await BusinessConfig.findOne({ tenantId: tenant._id })
    .select('name menu businessMode adminPhone description payment hours faq botEnabled')
    .lean();

  const step   = tenant.onboardingStep || 0;
  const checks = {
    whatsappConnected: tenant.whatsapp?.connected === true,
    basicSetupDone:    step >= 2 && !!(business?.name && business?.adminPhone),
    advancedSetupDone: step >= 3,
    menuAdded:         Array.isArray(business?.menu) && business.menu.length > 0,
    hoursConfigured:   business?.hours?.enabled === true,
    paymentConfigured: !!business?.payment?.wavePhone,
    faqAdded:          Array.isArray(business?.faq) && business.faq.length > 0,
  };

  const pct = Math.round(
    (Object.values(checks).filter(Boolean).length / Object.keys(checks).length) * 100
  );

  return {
    onboardingStep: step,
    status:         tenant.status,
    pctComplete:    pct,
    ...checks,
    bot: {
      name:       business?.name || null,
      mode:       business?.businessMode || null,
      menuItems:  business?.menu?.length || 0,
      botEnabled: business?.botEnabled !== false,
    },
    whatsapp: {
      phone:         tenant.whatsapp?.phone || null,
      phoneNumberId: tenant.whatsapp?.phoneNumberId || null,
      connected:     tenant.whatsapp?.connected === true,
    },
  };
}
