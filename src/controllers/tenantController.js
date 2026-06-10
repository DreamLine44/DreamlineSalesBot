/**
 * controllers/tenantController.js — WhatSalesAgent2
 *
 * ─── CHANGE LOG ───────────────────────────────────────────────────────────────
 *
 * [FIX-G]        updateTenantStatus accepts ACTIVE / SUSPENDED / INACTIVE / PENDING.
 *
 * [FIX-TENANT-1] deleteTenant purges ALL tenant-scoped data.
 *
 * [FIX-TENANT-2] createTenant validates required fields before Mongoose.
 *
 * [FIX #6]       createTenant no longer sets status:'ACTIVE'.
 *
 * [FIX #7]       updateTenant PATCH /:id — allowlist prevents overwriting protected fields.
 *
 * [FIX #8]       API key generation delegated to the Tenant pre-validate hook.
 *
 * [FIX #12]      listTenants supports ?name= and ?status= query filters.
 *
 * [AUDIT-P1-A]   updateTenant auto-syncs whatsapp.phoneNumberId to BusinessConfig.
 *
 * [AUDIT-P2-A]   Access token encryption at rest using AES-256-GCM.
 *
 * [AUDIT-P2-C]   verifyWhatsApp — POST /:id/verify-whatsapp.
 *
 * [AUDIT-P2-D]   rotateApiKey — POST /:id/rotate-key.
 *
 * [AUDIT-OB]     createTenant creates BusinessConfig.phoneNumberId in sync.
 *
 * [AUDIT-STEP]   onboardingStep advances automatically:
 *                  0 → 1  createTenant
 *                  1 → 2  updateTenant when whatsapp credentials are set
 *                  2 → 3  verifyWhatsApp success
 *                  3 → 4  updateTenantStatus(ACTIVE) or ONE-SHOT activation
 *
 * [AUDIT-FIX-1]  getTenant strips sensitive fields explicitly after .lean().
 *
 * [AUDIT-FIX-2]  updateTenant response explicitly deletes apiKeyHash.
 *
 * [AUDIT-FIX-3]  verifyWhatsApp → step 3; updateTenantStatus(ACTIVE) → step 4.
 *
 * [AUDIT-FIX-4]  updateTenantStatus blocks ACTIVE if phoneNumberId is SIM_.
 *
 * [AUDIT-FIX-5]  getEncryptionKey SHA-256 hashes the raw env var.
 *
 * [AUDIT-FIX-6]  Webhook routing queries Tenant.whatsapp.phoneNumberId directly.
 *
 * [ONE-SHOT]     updateTenant accepts "activate": true to set + verify + activate
 *                in a single PATCH call. Activation always proceeds regardless of
 *                Meta's response — super-admin has authority. whatsapp.connected is
 *                set to true only when Meta confirms; false otherwise.
 *
 * [ONE-SHOT-FIX-1..3] Various ONE-SHOT edge-case fixes (see inline comments).
 *
 * [FIX-PUT]      PUT /:id is now a valid alias for PATCH /:id (handled at route level).
 *                No controller change needed — this comment documents the route fix.
 *
 * [FIX-VERIFY-PRE] verifyWhatsApp now returns separate, specific errors for SIM_
 *                phoneNumberId vs missing accessToken instead of a single generic
 *                combined message. Makes it immediately clear which credential to fix.
 *
 * [FIX-FORCE-CONNECTED] updateTenantStatus with force:true now sets
 *                whatsapp.connected = true alongside the ACTIVE status update.
 *                Previously a force-activated tenant was ACTIVE but connected=false
 *                forever — the dashboard showed it as disconnected even when live.
 */

import Tenant           from '../models/Tenant.js';
import BusinessConfig   from '../models/BusinessConfig.js';
import Session          from '../models/Session.js';
import Order            from '../models/Order.js';
import Booking          from '../models/Booking.js';
import UserProfile      from '../models/UserProfile.js';
import Analytics        from '../models/Analytics.js';
import ProcessedMessage from '../models/ProcessedMessage.js';
import crypto           from 'crypto';
import logger           from '../config/logger.js';

// ─── Token Encryption Utilities (AES-256-GCM) ────────────────────────────────

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey() {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) return null;
  // [AUDIT-FIX-5] SHA-256 hash folds any-length key into exactly 32 bytes.
  return crypto.createHash('sha256').update(k, 'utf8').digest();
}

/**
 * Encrypt a plaintext access token.
 * Returns "enc:<iv_hex>:<tag_hex>:<ciphertext_hex>" or plaintext in dev.
 */
export function encryptToken(plaintext) {
  if (!plaintext) return plaintext;
  const key = getEncryptionKey();
  if (!key) {
    logger.warn('[TenantCtrl] ENCRYPTION_KEY not set — token stored in plaintext (dev only)');
    return plaintext;
  }
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/**
 * Decrypt a token produced by encryptToken.
 * Passes through plaintext values (no enc: prefix) transparently.
 */
export function decryptToken(stored) {
  if (!stored || !stored.startsWith('enc:')) return stored;
  const key = getEncryptionKey();
  if (!key) {
    logger.warn('[TenantCtrl] ENCRYPTION_KEY not set — cannot decrypt token, using stored value');
    return stored;
  }
  try {
    const parts = stored.split(':');
    if (parts.length < 4) throw new Error('Malformed encrypted token');
    const ivHex  = parts[1];
    const tagHex = parts[2];
    const encHex = parts.slice(3).join(':');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
  } catch (err) {
    logger.warn('[TenantCtrl] Token decryption failed — returning stored value to prevent lock-out', {
      err: err.message,
    });
    return stored;
  }
}

// ─── Internal: verifyCredentialsWithMeta ──────────────────────────────────────
/**
 * Calls the Meta Graph API to confirm a phoneNumberId + accessToken pair is valid.
 * Never throws — always returns a result object.
 */
async function verifyCredentialsWithMeta(phoneNumberId, encryptedToken, apiVersion = 'v21.0', appId = null) {
  // Pre-flight: skip network call for obviously invalid values
  if (!phoneNumberId || phoneNumberId.startsWith('SIM_')) {
    return {
      verified: false,
      error: 'phoneNumberId is still a simulation placeholder. Set a real Meta phoneNumberId first.',
    };
  }

  // Meta Phone Number IDs are purely numeric and ≥10 digits
  if (!/^\d{10,}$/.test(phoneNumberId)) {
    return {
      verified: false,
      error: `phoneNumberId "${phoneNumberId}" does not look like a valid Meta Phone Number ID.`,
      hint: 'A valid Phone Number ID is purely numeric (e.g. 123456789012345). '
          + 'Find it in Meta for Developers → WhatsApp → API Setup → "Phone number ID". '
          + 'Do NOT use the WABA ID, App ID, or the phone number itself.',
    };
  }

  const token = decryptToken(encryptedToken);
  const url   = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);

  let metaResp;
  try {
    metaResp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal:  ctrl.signal,
    });
    clearTimeout(timer);
  } catch (fetchErr) {
    clearTimeout(timer);
    const isTimeout = fetchErr.name === 'AbortError';
    return {
      verified: false,
      error: isTimeout
        ? 'Request to Meta API timed out (10 s). Check Railway outbound network and retry.'
        : `Network error reaching Meta API: ${fetchErr.message}`,
    };
  }

  if (!metaResp.ok) {
    const errBody  = await metaResp.json().catch(() => ({}));
    const metaMsg  = errBody?.error?.message || 'Meta API rejected the credentials';
    const metaCode = errBody?.error?.code;

    let hint = null;
    if (metaMsg.toLowerCase().includes('does not exist') || metaMsg.toLowerCase().includes('unsupported get')) {
      hint = 'The Phone Number ID appears wrong. Copy the numeric "Phone number ID" from '
           + 'Meta for Developers → WhatsApp → API Setup. Do NOT use the WABA ID or App ID.';
    } else if (metaCode === 190 || metaMsg.toLowerCase().includes('access token')) {
      hint = 'The Access Token is invalid or expired. Generate a new System User token '
           + 'in Meta Business Manager with whatsapp_business_messaging permission.';
    } else if (metaCode === 10 || metaMsg.toLowerCase().includes('permission')) {
      hint = 'The token is missing required permissions. Ensure the System User has '
           + 'whatsapp_business_messaging and whatsapp_business_management permissions.';
    } else if (metaCode === 200 || metaMsg.toLowerCase().includes('blocked')) {
      hint = 'API access is blocked. This can occur when the token belongs to a restricted '
           + 'app, a test token has expired, or the app is not approved for the WA Business API. '
           + 'Check your Meta App status in the developer dashboard.';
    }

    return {
      verified:  false,
      error:     metaMsg,
      hint,
      metaCode,
      metaType:  errBody?.error?.type ?? null,
    };
  }

  const data = await metaResp.json();
  return {
    verified:      true,
    displayPhone:  data.display_phone_number  ?? null,
    verifiedName:  data.verified_name         ?? null,
    qualityRating: data.quality_rating        ?? null,
  };
}

// ─── createTenant ─────────────────────────────────────────────────────────────
export async function createTenant(req, res) {
  try {
    const {
      name, businessMode = 'RESTAURANT', adminPhone, email,
      whatsapp = {}, menuItems = [], services = [], payment = {},
      leadCapture = {}, faq = [], description = '',
    } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const storedAccessToken   = whatsapp.accessToken   ? encryptToken(whatsapp.accessToken)   : null;
    const storedVerifyToken   = whatsapp.verifyToken   ? encryptToken(whatsapp.verifyToken)   : null;
    const storedWebhookSecret = whatsapp.webhookSecret ? encryptToken(whatsapp.webhookSecret) : null;

    const tenant = await Tenant.create({
      name: name.trim(),
      adminPhone,
      ...(email ? { email: email.trim() } : {}),
      onboardingStep: 1,
      whatsapp: {
        phoneNumberId: whatsapp.phoneNumberId || `SIM_${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        accessToken:   storedAccessToken,
        apiVersion:    whatsapp.apiVersion || 'v21.0',
        ...(whatsapp.wabaId         ? { wabaId:        whatsapp.wabaId }         : {}),
        ...(whatsapp.phone          ? { phone:         whatsapp.phone }          : {}),
        ...(storedVerifyToken       ? { verifyToken:   storedVerifyToken }       : {}),
        ...(storedWebhookSecret     ? { webhookSecret: storedWebhookSecret }     : {}),
      },
    });

    const business = await BusinessConfig.create({
      tenantId:      String(tenant._id),
      phoneNumberId: tenant.whatsapp.phoneNumberId,
      name:          name.trim(),
      businessMode,  adminPhone,  description,
      menuItems,     services,    payment,
      leadCapture,   faq,
      addOns: [],
    });

    const plaintextKey = tenant._plaintextApiKey;
    logger.info('[Tenant] Created', { tenantId: tenant._id, name: tenant.name });
    res.status(201).json({
      tenant:   { _id: tenant._id, name: tenant.name, status: tenant.status, apiKey: plaintextKey },
      business: { _id: business._id, businessMode, name: business.name },
      next:     `Use x-api-key: <the key above> for business / dashboard routes. `
              + `Activate via PATCH /admin/tenants/${tenant._id} with credentials + "activate":true`,
    });
  } catch (err) {
    logger.error('[Tenant] createTenant failed', { err: err.message });
    if (err.code === 11000) {
      return res.status(409).json({ error: 'A tenant with that phone number or email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
}

// ─── listTenants ──────────────────────────────────────────────────────────────
export async function listTenants(req, res) {
  try {
    const filter = {};
    if (req.query.name)   filter.name   = { $regex: req.query.name, $options: 'i' };
    if (req.query.status) filter.status = req.query.status;

    const tenants = await Tenant.find(filter)
      .select('name status createdAt email adminPhone plan onboardingStep whatsapp.phoneNumberId whatsapp.connected whatsapp.phone')
      .lean();

    if (tenants.length > 0) {
      const ids     = tenants.map(t => String(t._id));
      const configs = await BusinessConfig.find(
        { tenantId: { $in: ids } },
        { tenantId: 1, businessMode: 1 },
      ).lean();
      const modeMap = Object.fromEntries(configs.map(c => [String(c.tenantId), c.businessMode]));
      for (const t of tenants) t.businessMode = modeMap[String(t._id)] || null;
    }

    res.json({ tenants, count: tenants.length });
  } catch (err) {
    logger.error('[Tenant] listTenants failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ─── getTenant ────────────────────────────────────────────────────────────────
export async function getTenant(req, res) {
  try {
    const tenant = await Tenant.findById(req.params.id).lean();
    if (!tenant) return res.status(404).json({ error: 'Not found' });

    // [AUDIT-FIX-1] .lean() skips toJSON transforms — strip sensitive fields manually
    if (tenant.whatsapp) {
      delete tenant.whatsapp.accessToken;
      delete tenant.whatsapp.verifyToken;
      delete tenant.whatsapp.webhookSecret;
    }
    if (tenant.meta) {
      delete tenant.meta.appSecret;
    }
    delete tenant.apiKey;
    delete tenant.apiKeyHash;

    const business = await BusinessConfig.findOne({ tenantId: String(tenant._id) }).lean();
    res.json({ tenant, business });
  } catch (err) {
    logger.error('[Tenant] getTenant failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ─── updateTenant — PATCH /admin/tenants/:id  (also PUT via route alias) ─────
/**
 * Updates tenant credentials and metadata post-creation.
 *
 * Normal use: send any subset of the ALLOWED fields.
 *
 * ONE-SHOT use: include "activate": true alongside WhatsApp credentials to:
 *   1. Save the credentials (encrypted at rest)
 *   2. Attempt Meta API verification — result always included in response
 *   3. Set status = ACTIVE and onboardingStep = 4 regardless of Meta's response
 *   4. Set whatsapp.connected = true only if Meta confirmed; false otherwise
 */
export async function updateTenant(req, res) {
  try {
    const ALLOWED = [
      'name', 'adminPhone', 'email', 'plan', 'notes',
      'whatsapp.phone', 'whatsapp.phoneNumberId', 'whatsapp.wabaId',
      'whatsapp.accessToken', 'whatsapp.verifyToken', 'whatsapp.webhookSecret', 'whatsapp.apiVersion',
      'meta.appId', 'meta.appSecret',
      'limits.messagesPerMonth', 'limits.maxMenuItems', 'limits.maxAdmins',
    ];

    // Accept both nested { whatsapp: { accessToken } } and flat { 'whatsapp.accessToken': '...' }
    const updates = {};
    for (const field of ALLOWED) {
      const parts = field.split('.');
      if (parts.length === 1) {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      } else {
        const [top, sub] = parts;
        if (req.body[top]?.[sub]  !== undefined) updates[`${top}.${sub}`] = req.body[top][sub];
        if (req.body[field]       !== undefined) updates[field]           = req.body[field];
      }
    }

    const wantsActivate = req.body.activate === true;

    if (!Object.keys(updates).length && !wantsActivate) {
      return res.status(400).json({ error: 'No valid fields to update', allowed: ALLOWED });
    }

    // Encrypt sensitive tokens before they reach the DB
    if (updates['whatsapp.accessToken']) {
      updates['whatsapp.accessToken']    = encryptToken(updates['whatsapp.accessToken']);
      updates['whatsapp.tokenUpdatedAt'] = new Date();
    }
    if (updates['whatsapp.verifyToken'])   updates['whatsapp.verifyToken']   = encryptToken(updates['whatsapp.verifyToken']);
    if (updates['whatsapp.webhookSecret']) updates['whatsapp.webhookSecret'] = encryptToken(updates['whatsapp.webhookSecret']);
    if (updates['meta.appSecret'])         updates['meta.appSecret']         = encryptToken(updates['meta.appSecret']);

    // Load current state — needed for step gate and ONE-SHOT effective-value resolution
    const current = await Tenant.findById(req.params.id)
      .select('onboardingStep whatsapp.phoneNumberId whatsapp.accessToken whatsapp.apiVersion meta.appId')
      .lean();
    if (!current) return res.status(404).json({ error: 'Tenant not found' });

    // Advance onboardingStep to 2 when credentials are supplied for the first time
    const hasCredentialUpdate = updates['whatsapp.accessToken'] || updates['whatsapp.phoneNumberId'];
    if (hasCredentialUpdate && (current.onboardingStep ?? 0) <= 1) {
      updates['onboardingStep'] = 2;
    }

    // ONE-SHOT: verify + activate when activate:true is requested
    let metaVerification = null;

    if (wantsActivate) {
      const effectivePhoneNumberId = updates['whatsapp.phoneNumberId'] || current.whatsapp?.phoneNumberId;
      const effectiveToken         = updates['whatsapp.accessToken']   || current.whatsapp?.accessToken;
      const effectiveApiVersion    = updates['whatsapp.apiVersion']    || current.whatsapp?.apiVersion || 'v21.0';
      const effectiveAppId         = updates['meta.appId'] || current.meta?.appId || null;

      if (!effectivePhoneNumberId || effectivePhoneNumberId.startsWith('SIM_')) {
        return res.status(400).json({
          error: 'Cannot activate: phoneNumberId is still a simulation placeholder. '
               + 'Include a real Meta phoneNumberId in this request body.',
          phoneNumberId: effectivePhoneNumberId || null,
        });
      }

      if (!effectiveToken) {
        return res.status(400).json({
          error: 'Cannot activate: accessToken must be provided before activation.',
        });
      }

      // Token is already encrypted; verifyCredentialsWithMeta calls decryptToken() internally
      metaVerification = await verifyCredentialsWithMeta(
        effectivePhoneNumberId,
        effectiveToken,
        effectiveApiVersion,
        effectiveAppId,
      );

      logger.info('[Tenant] ONE-SHOT Meta verification result', {
        tenantId: req.params.id,
        verified: metaVerification.verified,
        ...(metaVerification.error ? { metaError: metaVerification.error } : {}),
      });

      // whatsapp.connected = true only when Meta confirmed
      updates['whatsapp.connected'] = metaVerification.verified;
      updates['status']             = 'ACTIVE';
      if ((current.onboardingStep ?? 0) < 4) updates['onboardingStep'] = 4;
    }

    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true },
    );
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // [AUDIT-P1-A] Sync phoneNumberId to BusinessConfig when it changes
    if (updates['whatsapp.phoneNumberId']) {
      try {
        await BusinessConfig.updateOne(
          { tenantId: String(req.params.id) },
          { $set: { phoneNumberId: updates['whatsapp.phoneNumberId'] } },
        );
        logger.info('[Tenant] Synced phoneNumberId to BusinessConfig', {
          tenantId: req.params.id,
          phoneNumberId: updates['whatsapp.phoneNumberId'],
        });
      } catch (syncErr) {
        logger.warn('[Tenant] BusinessConfig phoneNumberId sync failed (non-fatal)', {
          tenantId: req.params.id,
          err: syncErr.message,
        });
      }
    }

    logger.info('[Tenant] Updated', {
      tenantId:  tenant._id,
      fields:    Object.keys(updates),
      activated: wantsActivate,
    });

    // [AUDIT-FIX-2] Delete apiKeyHash after toJSON() as defence-in-depth
    const tenantOut = tenant.toJSON();
    delete tenantOut.apiKeyHash;

    res.json({
      ok:     true,
      tenant: tenantOut,
      ...(wantsActivate ? {
        activated:            true,
        message:              'Tenant credentials set and activated. Bot is live.',
        whatsappVerification: metaVerification,
      } : {}),
    });
  } catch (err) {
    logger.error('[Tenant] updateTenant failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ─── updateTenantStatus — PATCH /admin/tenants/:id/status ────────────────────
export async function updateTenantStatus(req, res) {
  try {
    const { status } = req.body;

    if (!['ACTIVE', 'SUSPENDED', 'INACTIVE', 'PENDING'].includes(status)) {
      return res.status(400).json({
        error: 'Invalid status. Must be one of: ACTIVE, PENDING, SUSPENDED, INACTIVE',
      });
    }

    const stepUpdate = {};
    if (status === 'ACTIVE') {
      const current = await Tenant.findById(req.params.id)
        .select('onboardingStep whatsapp.phoneNumberId')
        .lean();
      if (!current) return res.status(404).json({ error: 'Tenant not found' });

      // [AUDIT-FIX-4] Block activation on SIM_ placeholder
      const phoneNumberId = current?.whatsapp?.phoneNumberId;
      if (!phoneNumberId || phoneNumberId.startsWith('SIM_')) {
        return res.status(400).json({
          error: 'Cannot activate: phoneNumberId is still a simulation placeholder. '
               + 'Set real credentials via PATCH /admin/tenants/:id first.',
          phoneNumberId: phoneNumberId || null,
        });
      }

      // [FIX-AUTH-2] Check force:true BEFORE the onboardingStep gate
      const forceActivate = req.body.force === true;

      const currentStep = current?.onboardingStep ?? 0;
      if (currentStep < 3 && !forceActivate) {
        return res.status(400).json({
          error: 'Cannot activate: WhatsApp credentials must be verified before activation. '
               + 'Use POST /admin/tenants/:id/verify-whatsapp first, '
               + 'or send { "force": true } to bypass verification.',
          onboardingStep: currentStep,
          required: 3,
        });
      }

      // [AUDIT-FIX-3] Step 4 = activated (distinct from step 3 = verified)
      if (currentStep < 4) stepUpdate.onboardingStep = 4;

      // [FIX-FORCE-CONNECTED] force:true sets connected=true — /status never did this,
      // leaving the tenant ACTIVE but whatsapp.connected=false after force-activation.
      // Without this the dashboard shows the tenant as disconnected even when live.
      if (forceActivate) stepUpdate['whatsapp.connected'] = true;
    }

    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: { status, ...stepUpdate } },
      { new: true },
    );
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    logger.info('[Tenant] Status updated', {
      tenantId: tenant._id, status, onboardingStep: tenant.onboardingStep,
    });
    res.json({ ok: true, status: tenant.status, onboardingStep: tenant.onboardingStep });
  } catch (err) {
    logger.error('[Tenant] updateTenantStatus failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ─── deleteTenant ─────────────────────────────────────────────────────────────
export async function deleteTenant(req, res) {
  try {
    const { id } = req.params;
    const tid = String(id);

    const [tenantResult, ...collectionResults] = await Promise.allSettled([
      Tenant.findByIdAndDelete(id),
      BusinessConfig.deleteMany({ tenantId: tid }),
      Session.deleteMany({ tenantId: tid }),
      Order.deleteMany({ tenantId: tid }),
      Booking.deleteMany({ tenantId: tid }),
      UserProfile.deleteMany({ tenantId: tid }),
      Analytics.deleteMany({ tenantId: tid }),
      ProcessedMessage.deleteMany({ tenantId: tid }),
    ]);

    if (tenantResult.status === 'rejected') throw tenantResult.reason;
    if (tenantResult.value === null) return res.status(404).json({ error: 'Tenant not found' });

    for (const result of collectionResults) {
      if (result.status === 'rejected') {
        logger.warn('[Tenant] Partial cleanup failure (non-fatal)', { err: result.reason?.message });
      }
    }

    logger.info('[Tenant] Deleted with all associated data', { tenantId: tid });
    res.json({ ok: true, tenantId: tid });
  } catch (err) {
    logger.error('[Tenant] deleteTenant failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ─── verifyWhatsApp — POST /admin/tenants/:id/verify-whatsapp ─────────────────
/**
 * Validates stored WhatsApp credentials against the Meta Graph API.
 * On success: sets whatsapp.connected = true and advances onboardingStep to 3.
 * On failure: returns the Meta error with translated hints — does NOT activate.
 */
export async function verifyWhatsApp(req, res) {
  try {
    const tenant = await Tenant.findById(req.params.id).lean();
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const { accessToken, phoneNumberId, apiVersion = 'v21.0' } = tenant.whatsapp || {};

    // [FIX-VERIFY-PRE] Separate, specific errors for each missing/invalid credential
    // rather than a generic combined message — makes it immediately clear what to fix.
    if (!phoneNumberId || phoneNumberId.startsWith('SIM_')) {
      return res.status(400).json({
        error: 'phoneNumberId is still a simulation placeholder — real Meta credentials have not been saved yet. '
             + 'Use PATCH /admin/tenants/:id with { "whatsapp": { "phoneNumberId": "...", "accessToken": "..." } } first.',
        field: 'phoneNumberId',
        currentValue: phoneNumberId || null,
      });
    }
    if (!accessToken) {
      return res.status(400).json({
        error: 'accessToken has not been set yet. '
             + 'Use PATCH /admin/tenants/:id with { "whatsapp": { "accessToken": "..." } } first.',
        field: 'accessToken',
      });
    }

    const result = await verifyCredentialsWithMeta(phoneNumberId, accessToken, apiVersion);

    if (!result.verified) {
      logger.warn('[Tenant] WhatsApp verification failed', {
        tenantId: req.params.id,
        metaError: result.error,
        metaCode:  result.metaCode,
      });
      return res.status(400).json({
        verified:  false,
        error:     result.error,
        hint:      result.hint      ?? null,
        metaCode:  result.metaCode  ?? null,
        metaType:  result.metaType  ?? null,
      });
    }

    // Guard: a tenant at step 4 stays at 4 on re-verification — don't regress
    const currentStep = tenant.onboardingStep ?? 0;
    const newStep     = currentStep < 3 ? 3 : currentStep;

    await Tenant.findByIdAndUpdate(req.params.id, {
      $set: { 'whatsapp.connected': true, onboardingStep: newStep },
    });

    logger.info('[Tenant] WhatsApp credentials verified', {
      tenantId:    req.params.id,
      phoneNumberId,
      displayPhone: result.displayPhone,
    });

    res.json({
      verified:       true,
      phoneNumberId,
      displayPhone:   result.displayPhone,
      verifiedName:   result.verifiedName,
      qualityRating:  result.qualityRating,
      onboardingStep: newStep,
    });
  } catch (err) {
    logger.error('[Tenant] verifyWhatsApp failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ─── rotateApiKey — POST /admin/tenants/:id/rotate-key ───────────────────────
export async function rotateApiKey(req, res) {
  try {
    const newKey  = crypto.randomBytes(32).toString('hex');
    const newHash = crypto.createHash('sha256').update(newKey).digest('hex');

    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: { apiKeyHash: newHash }, $unset: { apiKey: '' } },
      { new: true, runValidators: false },
    );
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    logger.info('[Tenant] API key rotated', { tenantId: req.params.id });
    res.json({
      ok:     true,
      apiKey: newKey,
      note:   'Store this key immediately — it will not be shown again. The previous key is now invalid.',
    });
  } catch (err) {
    logger.error('[Tenant] rotateApiKey failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}
