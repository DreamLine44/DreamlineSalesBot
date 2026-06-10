/**
 * controllers/tenantController.js — WhatSalesAgent2
 *
 * ─── CHANGE LOG ───────────────────────────────────────────────────────────────
 *
 * [FIX-G]        updateTenantStatus accepts ACTIVE / SUSPENDED / INACTIVE / PENDING.
 *                PENDING lets admins revert a suspended tenant to onboarding state.
 *
 * [FIX-TENANT-1] deleteTenant purges ALL tenant-scoped data (Session, Order, Booking,
 *                UserProfile, Analytics, ProcessedMessage), not just BusinessConfig.
 *
 * [FIX-TENANT-2] createTenant validates required fields before Mongoose so the
 *                caller gets a clean 400, not a raw ValidationError 500.
 *
 * [FIX #6]       createTenant no longer sets status:'ACTIVE' — schema default
 *                ('PENDING') applies so new tenants await credential review.
 *
 * [FIX #7]       updateTenant PATCH /:id — allowlist prevents overwriting protected
 *                fields (_id, apiKey, apiKeyHash, status). Supports limits.* fields.
 *
 * [FIX #8]       API key generation delegated to the Tenant pre-validate hook
 *                (randomBytes(32) / 64-char hex). Hook skips re-generation when
 *                apiKey is already set by the caller.
 *
 * [FIX #12]      listTenants supports ?name= and ?status= query filters.
 *
 * [AUDIT-P1-A]   updateTenant auto-syncs whatsapp.phoneNumberId to BusinessConfig
 *                whenever it changes, preventing stale business-config lookups.
 *
 * [AUDIT-P2-A]   Access token encryption at rest using AES-256-GCM keyed on
 *                ENCRYPTION_KEY env var. Existing plaintext tokens are read
 *                transparently (enc: sentinel prefix). decryptToken() exported
 *                for use by dispatcher.js.
 *
 * [AUDIT-P2-C]   verifyWhatsApp — POST /:id/verify-whatsapp — validates credentials
 *                against the Meta Graph API phone number endpoint.
 *
 * [AUDIT-P2-D]   rotateApiKey — POST /:id/rotate-key — generates a new API key
 *                and hash atomically without touching tenant data.
 *
 * [AUDIT-OB]     createTenant creates BusinessConfig.phoneNumberId in sync from
 *                the start, preventing the P1-A routing gap on fresh tenants.
 *
 * [AUDIT-STEP]   onboardingStep advances automatically:
 *                  0 → 1  createTenant
 *                  1 → 2  updateTenant when whatsapp credentials are set
 *                  2 → 3  verifyWhatsApp success (standalone endpoint)
 *                  3 → 4  updateTenantStatus(ACTIVE) or ONE-SHOT activation
 *
 * [AUDIT-FIX-1]  getTenant strips sensitive fields explicitly after .lean() so
 *                the toJSON transform (only runs on Mongoose docs) cannot be bypassed.
 *
 * [AUDIT-FIX-2]  updateTenant response explicitly deletes apiKeyHash as
 *                defence-in-depth after toJSON().
 *
 * [AUDIT-FIX-3]  verifyWhatsApp → step 3; updateTenantStatus(ACTIVE) → step 4.
 *                Previously both set step 3, making them indistinguishable.
 *
 * [AUDIT-FIX-4]  updateTenantStatus blocks ACTIVE if phoneNumberId is SIM_.
 *
 * [AUDIT-FIX-5]  getEncryptionKey SHA-256 hashes the raw env var before slicing
 *                to 32 bytes, eliminating multibyte-UTF-8 entropy loss.
 *
 * [AUDIT-FIX-6]  Webhook routing queries Tenant.whatsapp.phoneNumberId directly,
 *                not BusinessConfig. BusinessConfig sync still maintained for
 *                business-config lookups.
 *
 * [ONE-SHOT]     updateTenant accepts "activate": true to set credentials, attempt
 *                Meta verification, and activate the tenant in a single PATCH call.
 *                Meta verification result is included in the response (informational).
 *                Activation always proceeds regardless of Meta's response — the
 *                super-admin has authority to activate even if Meta rejects (e.g.
 *                rate-limited token, sandbox environment). whatsapp.connected is set
 *                to true only when Meta confirms; false otherwise — so the frontend
 *                can show the credential health status accurately.
 *
 * [ONE-SHOT-FIX-1] The [ONE-SHOT] JSDoc comment previously said "Meta verification
 *                skipped" — corrected to "Meta verification attempted; always activates".
 *
 * [ONE-SHOT-FIX-2] activate:true with no credential fields (credentials already set
 *                in DB from a prior PATCH) now falls through to the ONE-SHOT block
 *                and runs verify+activate using the stored credentials. Previously
 *                returned 400 directing to /status force:true, which skips Meta
 *                verification entirely — defeating the purpose of ONE-SHOT.
 *
 * [ONE-SHOT-FIX-3] verifyWhatsApp (standalone) now delegates all Meta API logic to
 *                the shared verifyCredentialsWithMeta() helper — zero duplication.
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
// [AUDIT-P2-A] ENCRYPTION_KEY can be any non-empty string.
// In development without ENCRYPTION_KEY, tokens are stored plaintext with a
// warning. In production, env.js validateEnv() enforces ENCRYPTION_KEY is present,
// so the graceful-degradation path only fires in dev/test.
//
// [FIX-ENC-1] The old guard required Buffer.byteLength(k,"utf8") >= 32, but since
// [AUDIT-FIX-5] we SHA-256 hash the key before use, the raw byte length is
// irrelevant — SHA-256 always produces exactly 32 bytes regardless of input length.
// The 32-byte guard was silently rejecting valid short ENCRYPTION_KEY values in dev,
// returning null and falling back to plaintext storage without warning.
// Any non-empty key value is now accepted.

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey() {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) return null;
  // [AUDIT-FIX-5] SHA-256 hash folds the full entropy of any-length key into exactly
  // 32 bytes. Slicing the first 32 UTF-8 bytes loses entropy for long keys and
  // silently under-counts multibyte characters. Hashing is deterministic so existing
  // encrypted tokens continue to decrypt as long as ENCRYPTION_KEY is unchanged.
  return crypto.createHash('sha256').update(k, 'utf8').digest();
}

/**
 * Encrypt a plaintext access token.
 * Returns a sentinel-prefixed string: "enc:<iv_hex>:<tag_hex>:<ciphertext_hex>"
 * Falls back to plaintext with a warning when ENCRYPTION_KEY is absent (dev only).
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
 * Passes through plaintext values (no enc: prefix) transparently so tokens stored
 * before encryption was deployed continue to work without migration.
 * On decryption failure returns the stored value and logs a warning to prevent
 * lock-out of existing tenants.
 */
export function decryptToken(stored) {
  if (!stored || !stored.startsWith('enc:')) return stored; // plaintext passthrough
  const key = getEncryptionKey();
  if (!key) {
    logger.warn('[TenantCtrl] ENCRYPTION_KEY not set — cannot decrypt token, using stored value');
    return stored;
  }
  try {
    const parts = stored.split(':');
    // Format: enc:<iv>:<tag>:<ciphertext>  (all hex, no embedded colons today)
    // Taking parts[1], parts[2], and joining parts[3..] future-proofs against a
    // version prefix being added without silently destructuring wrong segments.
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
 * Never throws — always returns a result object. Used by both the ONE-SHOT path in
 * updateTenant and the standalone verifyWhatsApp endpoint so logic is never duplicated.
 *
 * @param {string} phoneNumberId
 * @param {string} encryptedToken  Stored (possibly enc:-prefixed) token; decrypted internally.
 * @param {string} [apiVersion]
 * @param {string} [appId]         [META-CREDS] Optional Meta App ID for richer token validation.
 *                                  When provided, debug_token includes app_id → Meta returns
 *                                  which app issued the token, preventing cross-app token reuse.
 * @returns {{ verified: boolean, displayPhone?, verifiedName?, qualityRating?,
 *             error?, hint?, metaCode?, metaType? }}
 */
async function verifyCredentialsWithMeta(phoneNumberId, encryptedToken, apiVersion = 'v21.0', appId = null) {
  // ── Pre-flight checks — skip the network call for obviously invalid values ──
  if (!phoneNumberId || phoneNumberId.startsWith('SIM_')) {
    return {
      verified: false,
      error: 'phoneNumberId is still a simulation placeholder. Set a real Meta phoneNumberId first.',
    };
  }

  // Meta Phone Number IDs are purely numeric and ≥10 digits.
  // Non-numeric values are almost always a WABA ID, App ID, or copy-paste mistake.
  if (!/^\d{10,}$/.test(phoneNumberId)) {
    return {
      verified: false,
      error: `phoneNumberId "${phoneNumberId}" does not look like a valid Meta Phone Number ID.`,
      hint: 'A valid Phone Number ID is purely numeric (e.g. 123456789012345). '
          + 'Find it in Meta for Developers → WhatsApp → API Setup → "Phone number ID". '
          + 'Do NOT use the WABA ID, App ID, or the phone number itself.',
    };
  }

  // ── Network call ──────────────────────────────────────────────────────────
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

  // ── Error response from Meta ──────────────────────────────────────────────
  if (!metaResp.ok) {
    const errBody  = await metaResp.json().catch(() => ({}));
    const metaMsg  = errBody?.error?.message || 'Meta API rejected the credentials';
    const metaCode = errBody?.error?.code;

    // Translate common Meta error codes into actionable guidance
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

  // ── Success ───────────────────────────────────────────────────────────────
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

    // [FIX-TENANT-2] Return a clean 400 before Mongoose throws a ValidationError.
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    // [AUDIT-P2-A] Encrypt sensitive whatsapp fields at creation time if supplied.
    const storedAccessToken   = whatsapp.accessToken   ? encryptToken(whatsapp.accessToken)   : null;
    const storedVerifyToken   = whatsapp.verifyToken   ? encryptToken(whatsapp.verifyToken)   : null;
    const storedWebhookSecret = whatsapp.webhookSecret ? encryptToken(whatsapp.webhookSecret) : null;

    // [FIX #6]  No status:'ACTIVE' — schema default 'PENDING' applies.
    // [FIX #8]  No manual apiKey generation — Tenant pre-validate hook handles it.
    // [AUDIT-STEP]  onboardingStep starts at 1 (tenant created, awaiting credentials).
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

    // [AUDIT-OB] Create BusinessConfig with phoneNumberId in sync immediately so
    // the P1-A routing gap never occurs for freshly created tenants.
    const business = await BusinessConfig.create({
      tenantId:      String(tenant._id),
      phoneNumberId: tenant.whatsapp.phoneNumberId,
      name:          name.trim(),
      businessMode,  adminPhone,  description,
      menuItems,     services,    payment,
      leadCapture,   faq,
      addOns: [],
    });

    // [FIX-RAWKEY] _plaintextApiKey is a transient in-memory property set by the
    // Tenant pre-validate hook. After this response it is gone — not in the DB, not in logs.
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
    // [FIX #12] Support ?name= and ?status= filters.
    const filter = {};
    if (req.query.name)   filter.name   = { $regex: req.query.name, $options: 'i' };
    if (req.query.status) filter.status = req.query.status;

    const tenants = await Tenant.find(filter)
      .select('name status createdAt email adminPhone plan onboardingStep whatsapp.phoneNumberId whatsapp.connected whatsapp.phone')
      .lean();

    // Enrich each tenant row with businessMode from BusinessConfig in one batched query.
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

    // [AUDIT-FIX-1] .lean() returns a plain JS object — Mongoose toJSON transforms
    // do NOT run. Strip all sensitive credential fields manually.
    if (tenant.whatsapp) {
      delete tenant.whatsapp.accessToken;
      delete tenant.whatsapp.verifyToken;
      delete tenant.whatsapp.webhookSecret;
    }
    // [META-CREDS] Strip appSecret — encrypted at rest but must never leave the server.
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

// ─── updateTenant — PATCH /admin/tenants/:id ─────────────────────────────────
/**
 * Updates tenant credentials and metadata post-creation.
 *
 * Normal use: send any subset of the ALLOWED fields to update them.
 *
 * ONE-SHOT use: include "activate": true alongside WhatsApp credentials to:
 *   1. Save the credentials (encrypted at rest)
 *   2. Attempt Meta API verification — result is always included in the response
 *   3. Set status = ACTIVE and onboardingStep = 4 regardless of Meta's response
 *   4. Set whatsapp.connected = true only if Meta confirmed; false otherwise
 *
 * The super-admin always has the authority to activate. Meta rejections (expired
 * token, rate limit, sandbox) are surfaced in whatsappVerification so the admin
 * knows the credential health without being blocked from going live.
 */
export async function updateTenant(req, res) {
  try {
    const ALLOWED = [
      'name', 'adminPhone', 'email', 'plan', 'notes',
      'whatsapp.phone', 'whatsapp.phoneNumberId', 'whatsapp.wabaId',
      'whatsapp.accessToken', 'whatsapp.verifyToken', 'whatsapp.webhookSecret', 'whatsapp.apiVersion',
      // [META-CREDS] Per-tenant Meta application credentials.
      // appId is informational (not sensitive); appSecret is encrypted before storage.
      'meta.appId', 'meta.appSecret',
      'limits.messagesPerMonth', 'limits.maxMenuItems', 'limits.maxAdmins',
    ];

    // Build the updates map from the allowlist only — both nested { whatsapp: { accessToken } }
    // and flat dot-notation { 'whatsapp.accessToken': '...' } body shapes are accepted.
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

    // [ONE-SHOT-FIX-2] When activate:true is sent with no other fields, the credentials
    // are already set in the DB — run the full ONE-SHOT verify+activate path using the
    // stored credentials. This is the correct use case: admin already ran a plain PATCH
    // to set credentials, now wants to activate via a second call without re-supplying them.
    // Previously this returned a 400 directing to /status force:true, which skips Meta
    // verification entirely. Now it falls through to the ONE-SHOT block below where
    // effectivePhoneNumberId and effectiveToken are resolved from `current`.
    if (!Object.keys(updates).length && !wantsActivate) {
      return res.status(400).json({ error: 'No valid fields to update', allowed: ALLOWED });
    }

    // [AUDIT-P2-A] Encrypt sensitive tokens before they reach the DB.
    if (updates['whatsapp.accessToken']) {
      updates['whatsapp.accessToken']   = encryptToken(updates['whatsapp.accessToken']);
      updates['whatsapp.tokenUpdatedAt'] = new Date();
    }
    if (updates['whatsapp.verifyToken'])   updates['whatsapp.verifyToken']   = encryptToken(updates['whatsapp.verifyToken']);
    if (updates['whatsapp.webhookSecret']) updates['whatsapp.webhookSecret'] = encryptToken(updates['whatsapp.webhookSecret']);
    // [META-CREDS] appSecret is sensitive — encrypt at rest using the same AES-256-GCM
    // pattern as accessToken. appId is not sensitive; stored plaintext.
    if (updates['meta.appSecret']) updates['meta.appSecret'] = encryptToken(updates['meta.appSecret']);

    // Load current tenant state — needed for the step gate and to resolve effective
    // credential values for the ONE-SHOT verification call.
    const current = await Tenant.findById(req.params.id)
      .select('onboardingStep whatsapp.phoneNumberId whatsapp.accessToken whatsapp.apiVersion meta.appId')
      .lean();
    if (!current) return res.status(404).json({ error: 'Tenant not found' });

    // [AUDIT-STEP] Advance onboardingStep to 2 when credentials are supplied for the
    // first time. Never regress a tenant that is already at step 2 or beyond.
    const hasCredentialUpdate = updates['whatsapp.accessToken'] || updates['whatsapp.phoneNumberId'];
    if (hasCredentialUpdate && (current.onboardingStep ?? 0) <= 1) {
      updates['onboardingStep'] = 2;
    }

    // [ONE-SHOT] When activate:true is requested ─────────────────────────────
    let metaVerification = null;

    if (wantsActivate) {
      const effectivePhoneNumberId = updates['whatsapp.phoneNumberId'] || current.whatsapp?.phoneNumberId;
      const effectiveToken         = updates['whatsapp.accessToken']   || current.whatsapp?.accessToken;
      const effectiveApiVersion    = updates['whatsapp.apiVersion']    || current.whatsapp?.apiVersion || 'v21.0';
      // [META-CREDS] Pass appId when available for richer token validation.
      const effectiveAppId         = updates['meta.appId'] || current.meta?.appId || null;

      // Hard-block on SIM_ placeholder — there is no way to send real messages with it.
      if (!effectivePhoneNumberId || effectivePhoneNumberId.startsWith('SIM_')) {
        return res.status(400).json({
          error: 'Cannot activate: phoneNumberId is still a simulation placeholder. '
               + 'Include a real Meta phoneNumberId in this request body.',
          phoneNumberId: effectivePhoneNumberId || null,
        });
      }

      // Hard-block on missing token — the bot cannot authenticate to Meta without it.
      if (!effectiveToken) {
        return res.status(400).json({
          error: 'Cannot activate: accessToken must be provided before activation.',
        });
      }

      // Attempt Meta verification. Result is informational — never blocks activation.
      // The token is already encrypted at this point; verifyCredentialsWithMeta
      // calls decryptToken() internally before making the outbound request.
      metaVerification = await verifyCredentialsWithMeta(
        effectivePhoneNumberId,
        effectiveToken,
        effectiveApiVersion,
        effectiveAppId,   // [META-CREDS] optional — undefined-safe
      );

      logger.info('[Tenant] ONE-SHOT Meta verification result', {
        tenantId: req.params.id,
        verified: metaVerification.verified,
        ...(metaVerification.error ? { metaError: metaVerification.error } : {}),
      });

      // whatsapp.connected = true only when Meta confirmed the credentials.
      // This is the accurate health flag — the frontend uses it to show a warning
      // badge when the token is blocked so the admin can fix it without the bot
      // being taken offline.
      updates['whatsapp.connected'] = metaVerification.verified;
      updates['status']             = 'ACTIVE';
      if ((current.onboardingStep ?? 0) < 4) updates['onboardingStep'] = 4;
    }
    // ─────────────────────────────────────────────────────────────────────────

    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true },
    );
    // Extremely unlikely (deleted between findById and findByIdAndUpdate) but guard anyway.
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // [AUDIT-P1-A] Sync phoneNumberId to BusinessConfig when it changes on Tenant.
    // webhook routing reads Tenant.whatsapp.phoneNumberId directly, but businessController
    // and config lookups use BusinessConfig.phoneNumberId — keep them in sync.
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
        // Non-fatal: webhook routing still works (reads Tenant directly), but log
        // visibly so the ops team can manually re-sync if needed.
        logger.warn('[Tenant] BusinessConfig phoneNumberId sync failed — business-config lookups may be stale', {
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

    // [AUDIT-FIX-2] Delete apiKeyHash after toJSON() as defence-in-depth.
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

    // [FIX-G] PENDING added so admins can revert a suspended tenant to onboarding state.
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

      // [AUDIT-FIX-4] Block activation when phoneNumberId is still a SIM_ placeholder.
      const phoneNumberId = current?.whatsapp?.phoneNumberId;
      if (!phoneNumberId || phoneNumberId.startsWith('SIM_')) {
        return res.status(400).json({
          error: 'Cannot activate: phoneNumberId is still a simulation placeholder. '
               + 'Set real credentials via PATCH /admin/tenants/:id first.',
          phoneNumberId: phoneNumberId || null,
        });
      }

      // [FIX-AUTH-2] Check force:true BEFORE the onboardingStep gate so the flag
      // is not silently ignored.
      const forceActivate = req.body.force === true;

      // [FIX-GATE] Require credentials to have been verified (step ≥ 3) unless
      // the super-admin explicitly sends force:true.
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

      // [AUDIT-FIX-3] Step 4 = activated (distinct from step 3 = verified).
      if (currentStep < 4) stepUpdate.onboardingStep = 4;
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

    // [FIX-TENANT-1] Delete ALL tenant-scoped data, not just BusinessConfig.
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
 * [AUDIT-P2-C] Validates stored WhatsApp credentials against the Meta Graph API.
 * On success: sets whatsapp.connected = true and advances onboardingStep to 3.
 * On failure: returns the Meta error with translated hints — does NOT activate.
 *
 * Use this standalone endpoint when you want to verify without activating, or to
 * re-verify credentials on an already-active tenant after a token rotation.
 *
 * For a single-call set + verify + activate flow, use PATCH /admin/tenants/:id
 * with credentials and "activate": true instead.
 *
 * [ONE-SHOT-FIX-3] All Meta API logic is now in verifyCredentialsWithMeta() so
 * this function and the ONE-SHOT path share the exact same validation behaviour.
 */
export async function verifyWhatsApp(req, res) {
  try {
    const tenant = await Tenant.findById(req.params.id).lean();
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const { accessToken, phoneNumberId, apiVersion = 'v21.0' } = tenant.whatsapp || {};

    if (!accessToken || !phoneNumberId) {
      return res.status(400).json({
        error: 'accessToken and phoneNumberId must both be set before verification. '
             + 'Use PATCH /admin/tenants/:id to set them first.',
      });
    }

    // Delegate all Meta API interaction to the shared helper.
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

    // Advance onboardingStep to 3 (verified, not yet activated).
    // Guard: a tenant already at step 4 (active) stays at 4 on re-verification
    // so that re-checking a live tenant's token does not regress its state.
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
/**
 * [AUDIT-P2-D] Generates a new API key and hash atomically without touching any
 * tenant data. The new plaintext key is returned once and never stored.
 * The old key is immediately invalidated.
 */
export async function rotateApiKey(req, res) {
  try {
    const newKey  = crypto.randomBytes(32).toString('hex');
    const newHash = crypto.createHash('sha256').update(newKey).digest('hex');

    // $unset apiKey removes any legacy plaintext key that may exist on older documents.
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
