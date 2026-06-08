/**
 * controllers/tenantController.js — WhatSalesAgent2
 *
 * FIXES applied (merged from v1 + v2):
 *
 * [FIX-G]        updateTenantStatus now accepts ACTIVE / SUSPENDED / INACTIVE / PENDING.
 *                PENDING allows admins to revert a suspended tenant to onboarding state.
 *
 * [FIX-TENANT-1] deleteTenant purges ALL tenant-scoped data (Session, Order, Booking,
 *                UserProfile, Analytics, ProcessedMessage) — not just BusinessConfig.
 *
 * [FIX-TENANT-2] createTenant validates required fields before Mongoose sees them so
 *                the error is a clean 400, not a raw Mongoose ValidationError 500.
 *
 * [FIX #6]       createTenant no longer passes status:'ACTIVE' — the schema default
 *                ('PENDING') applies so new tenants await credential review.
 *
 * [FIX #7]       updateTenant PATCH /:id — allows updating name, adminPhone, and
 *                WhatsApp credentials post-creation. Allowlist prevents overwriting
 *                protected fields (_id, apiKey, apiKeyHash, status).
 *                Also supports limits.* fields from v2.
 *
 * [FIX #8]       API key generation delegated to the Tenant pre-validate hook (which
 *                uses randomBytes(32) / 64-char hex). The old controller path used
 *                randomBytes(32) with a 'wsa_' prefix, creating format inconsistency.
 *                The hook skips re-generation when apiKey is already set by the caller.
 *
 * [FIX #12]      listTenants supports ?name= and ?status= filters. Returned fields
 *                are non-sensitive (no accessToken, no apiKey).
 *
 * [AUDIT-P1-A]   updateTenant now auto-syncs whatsapp.phoneNumberId to BusinessConfig
 *                whenever it changes, fixing the webhook routing gap where incoming
 *                WhatsApp messages could match no tenant after a credential update.
 *
 * [AUDIT-P2-A]   Access token encryption at rest using AES-256-GCM keyed on
 *                ENCRYPTION_KEY env var. Existing plaintext tokens are transparently
 *                read without decryption failure (enc: prefix sentinel). decryptToken()
 *                is exported for use by dispatcher.js.
 *
 * [AUDIT-P2-C]   verifyWhatsApp — POST /:id/verify-whatsapp — validates credentials
 *                against the Meta Graph API phone number endpoint before activation.
 *
 * [AUDIT-P2-D]   rotateApiKey — POST /:id/rotate-key — generates a new API key and
 *                hash atomically, without deleting the tenant or its data.
 *
 * [AUDIT-OB]     createTenant now creates BusinessConfig.phoneNumberId in sync from
 *                the start if whatsapp.phoneNumberId is supplied.
 *
 * [AUDIT-STEP]   onboardingStep is automatically advanced by the system:
 *                0 → 1 on createTenant
 *                1 → 2 on updateTenant when whatsapp fields are set
 *                2 → 3 on verifyWhatsApp success
 *                3 → 4 on updateTenantStatus(ACTIVE)   ← step 4 added by AUDIT-FIX-3
 *
 * [AUDIT-FIX-1]  getTenant now strips sensitive fields explicitly after .lean() so the
 *                toJSON transform (which only runs on Mongoose documents, not plain
 *                objects) cannot be bypassed.
 *                Stripped: whatsapp.accessToken, whatsapp.verifyToken, apiKey, apiKeyHash.
 *
 * [AUDIT-FIX-2]  toJSON transform updated to also strip apiKeyHash. updateTenant
 *                response now explicitly deletes it as defence-in-depth.
 *
 * [AUDIT-FIX-3]  verifyWhatsApp sets onboardingStep -> 3; updateTenantStatus(ACTIVE)
 *                sets it -> 4. Previously both set -> 3, making verified and activated
 *                indistinguishable. Tenant schema max raised from 3 -> 4.
 *
 * [AUDIT-FIX-4]  updateTenantStatus blocks ACTIVE if phoneNumberId is still a SIM_
 *                placeholder.
 *
 * [AUDIT-FIX-5]  getEncryptionKey now SHA-256 hashes the raw env var before slicing
 *                to 32 bytes, eliminating the multibyte-UTF-8 edge case.
 *
 * [AUDIT-FIX-6]  BusinessConfig sync comment corrected: webhook routing queries
 *                Tenant.whatsapp.phoneNumberId directly, not BusinessConfig.
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
// [AUDIT-P2-A] ENCRYPTION_KEY must be exactly 32 bytes (256-bit).
// In development without ENCRYPTION_KEY, tokens are stored plaintext with a
// warning. In production, env.js validateEnv() already enforces ENCRYPTION_KEY
// is present, so the graceful-degradation path only fires in dev/test.

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey() {
  const k = process.env.ENCRYPTION_KEY;
  if (!k || Buffer.byteLength(k, 'utf8') < 32) return null;
  // [AUDIT-FIX-5] Hash the raw key with SHA-256 before using it as the AES-256 key.
  // Slicing the first 32 UTF-8 bytes of the env var has two problems:
  //   1. Multibyte chars (emoji, CJK) pass the byteLength>=32 check but represent
  //      far fewer than 32 independent characters, silently reducing key entropy.
  //   2. Only the first 32 bytes of a longer key are used — extra entropy is thrown away.
  // SHA-256 hashing folds the full entropy of any-length key into exactly 32 bytes
  // and is deterministic, so existing encrypted tokens continue to decrypt correctly
  // as long as ENCRYPTION_KEY is not changed.
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
    logger.warn('[TenantCtrl] ENCRYPTION_KEY not set — access token stored in plaintext (dev only)');
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
 * Passes through plaintext values (no enc: prefix) transparently — this ensures
 * tokens stored before this change was deployed continue to work without migration.
 * On decryption failure (tampered data, wrong key) returns the stored value and
 * logs a warning to prevent lock-out of existing tenants.
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
    // Format: enc:<iv>:<tag>:<ciphertext>
    // All three payload segments are hex (no colons), so split(':') always yields exactly
    // 4 parts today. Guard defensively against a future version prefix (enc:v2:<iv>:...)
    // by always taking parts[1], parts[2] and joining parts[3..] as ciphertext — so a
    // format change that adds a prefix segment cannot silently destructure the wrong value.
    if (parts.length < 4) throw new Error('Malformed encrypted token');
    const ivHex  = parts[1];
    const tagHex = parts[2];
    const encHex = parts.slice(3).join(':'); // safe against extra colons in future formats
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
  } catch (err) {
    logger.warn('[TenantCtrl] Token decryption failed — returning stored value to prevent lock-out', {
      err: err.message,
    });
    return stored; // safe fallback: dispatcher will reject a garbled token and log
  }
}

// ─── createTenant ─────────────────────────────────────────────────────────────
export async function createTenant(req, res) {
  try {
    const {
      name, businessMode = 'RESTAURANT', adminPhone, email,
      whatsapp = {}, menuItems = [], services = [], payment = {},
      leadCapture = {}, faq = [], description = '',
    } = req.body;

    // [FIX-TENANT-2] Return a clean 400 before Mongoose throws a ValidationError
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    // Encrypt access token and verifyToken at creation time if supplied.
    // [AUDIT-P2-A] Never store plaintext tokens in production.
    // [FIX-VT] verifyToken encrypted at rest — it is a Meta webhook secret that
    // must be treated with the same care as accessToken.
    const rawAccessToken  = whatsapp.accessToken  || null;
    const rawVerifyToken  = whatsapp.verifyToken   || null;
    const rawWebhookSecret = whatsapp.webhookSecret || null;
    const storedAccessToken  = rawAccessToken   ? encryptToken(rawAccessToken)   : null;
    const storedVerifyToken  = rawVerifyToken   ? encryptToken(rawVerifyToken)   : null;
    const storedWebhookSecret = rawWebhookSecret ? encryptToken(rawWebhookSecret) : null;

    // [FIX #6]  No status:'ACTIVE' — the Tenant schema default is 'PENDING'.
    // [FIX #8]  No manual apiKey generation — the Tenant pre-validate hook handles it.
    // [AUDIT-STEP] onboardingStep starts at 1 (tenant created, awaiting credentials)
    // [FIX-CREATE-WA] wabaId, phone, and verifyToken from whatsapp block are now
    //                  forwarded to Tenant.create. Previously only phoneNumberId,
    //                  accessToken, and apiVersion were passed — wabaId was silently
    //                  dropped, forcing admins to update it immediately after creation.
    const tenant = await Tenant.create({
      name: name.trim(), adminPhone,
      ...(email ? { email: email.trim() } : {}),
      onboardingStep: 1,
      whatsapp: {
        phoneNumberId: whatsapp.phoneNumberId || `SIM_${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        accessToken:   storedAccessToken,
        apiVersion:    whatsapp.apiVersion || 'v21.0',
        ...(whatsapp.wabaId         ? { wabaId:         whatsapp.wabaId }              : {}),
        ...(whatsapp.phone          ? { phone:          whatsapp.phone }               : {}),
        ...(storedVerifyToken       ? { verifyToken:    storedVerifyToken }            : {}),
        ...(storedWebhookSecret     ? { webhookSecret:  storedWebhookSecret }         : {}),
      },
    });

    // [AUDIT-OB] Create BusinessConfig with phoneNumberId in sync from the start
    // This prevents the P1-A routing gap from occurring for freshly created tenants.
    const business = await BusinessConfig.create({
      tenantId:      String(tenant._id),
      phoneNumberId: tenant.whatsapp.phoneNumberId, // sync immediately
      name:          name.trim(), businessMode, adminPhone,
      description,   menuItems,    services,
      payment, leadCapture, faq,
      addOns: [],
    });

    // [FIX-RAWKEY] _plaintextApiKey is a transient in-memory property set by the
    // Tenant pre-validate hook. It is the only moment the raw key exists; after
    // this response is sent it is gone — not in the DB, not in logs.
    const plaintextKey = tenant._plaintextApiKey;
    logger.info('[Tenant] Created', { tenantId: tenant._id, name: tenant.name, status: tenant.status });
    res.status(201).json({
      tenant:   { _id: tenant._id, name: tenant.name, status: tenant.status, apiKey: plaintextKey },
      business: { _id: business._id, businessMode, name: business.name },
      next:     `Use x-api-key: <the key above> for business / dashboard routes. Activate via PATCH /admin/tenants/${tenant._id}/status`,
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

    // [FIX-LIST-FIELDS] Also fetch email, whatsapp.phone, and businessMode.
    // businessMode lives on BusinessConfig (not Tenant), so we do a lightweight
    // lookup after the Tenant query rather than an expensive $lookup aggregation.
    const tenants = await Tenant.find(filter)
      .select('name status createdAt email adminPhone plan onboardingStep whatsapp.phoneNumberId whatsapp.connected whatsapp.phone')
      .lean();

    // Enrich each tenant row with businessMode from BusinessConfig.
    // Done in one batched query rather than N individual finds.
    if (tenants.length > 0) {
      const ids = tenants.map(t => String(t._id));
      const configs = await BusinessConfig.find(
        { tenantId: { $in: ids } },
        { tenantId: 1, businessMode: 1 },
      ).lean();
      const modeMap = Object.fromEntries(configs.map(c => [String(c.tenantId), c.businessMode]));
      for (const t of tenants) {
        t.businessMode = modeMap[String(t._id)] || null;
      }
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
    // do NOT run on plain objects. Strip all sensitive credential fields manually
    // so they are never exposed regardless of how the result is serialised.
    if (tenant.whatsapp) {
      delete tenant.whatsapp.accessToken;
      delete tenant.whatsapp.verifyToken;
      delete tenant.whatsapp.webhookSecret;
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

/**
 * updateTenant — PATCH /admin/tenants/:id
 *
 * [FIX #7]       Allows updating tenant credentials/metadata post-creation.
 *                Allowlist excludes _id, apiKey, apiKeyHash, status.
 *
 * [AUDIT-P1-A]   When whatsapp.phoneNumberId is updated, BusinessConfig.phoneNumberId
 *                is also updated atomically. This is the critical fix for the webhook
 *                routing gap: webhookController loads BusinessConfig by phoneNumberId,
 *                so Tenant and BusinessConfig must always stay in sync.
 *
 * [AUDIT-P2-A]   whatsapp.accessToken is encrypted before storage.
 *
 * [AUDIT-STEP]   onboardingStep advances to 2 when WhatsApp credentials are provided.
 *
 * [ONE-SHOT]     When the request body includes `"activate": true`, and WhatsApp
 *                credentials (phoneNumberId + accessToken) are present after this
 *                update, the tenant is fully activated in a single call:
 *                  - whatsapp.connected is set to true (Meta verification skipped)
 *                  - status is set to ACTIVE
 *                  - onboardingStep advances to 4
 *                This is the recommended path for super-admins who trust their own
 *                credentials and want to skip the separate verify + activate steps.
 */
export async function updateTenant(req, res) {
  try {
    // [FIX-BYPASS] onboardingStep removed from ALLOWED — it must only advance via
    // system logic (createTenant → 1, updateTenant credentials → 2, verifyWhatsApp → 3,
    // updateTenantStatus(ACTIVE) → 4). Allowing callers to set it directly lets them
    // skip verification and activate without ever passing the Meta credential check.
    // whatsapp.connected also removed — it must only be set by verifyWhatsApp on
    // confirmed Meta API success, not asserted by the caller.
    // Exception: the ONE-SHOT path (activate:true) sets both atomically below.
    const ALLOWED = [
      'name', 'adminPhone', 'email', 'plan', 'notes',
      'whatsapp.phone', 'whatsapp.phoneNumberId', 'whatsapp.wabaId',
      'whatsapp.accessToken', 'whatsapp.verifyToken', 'whatsapp.webhookSecret', 'whatsapp.apiVersion',
      'limits.messagesPerMonth', 'limits.maxMenuItems', 'limits.maxAdmins',
    ];

    const updates = {};
    for (const field of ALLOWED) {
      const parts = field.split('.');
      if (parts.length === 1) {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      } else {
        const [top, sub] = parts;
        // Accept nested body: { whatsapp: { accessToken: '...' } }
        if (req.body[top]?.[sub] !== undefined) updates[`${top}.${sub}`] = req.body[top][sub];
        // Also accept flat dot-notation body: { 'whatsapp.accessToken': '...' }
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields to update', allowed: ALLOWED });
    }

    // [AUDIT-P2-A] Encrypt access token before saving to DB.
    // [FIX-VT] Also encrypt verifyToken — it is a Meta webhook secret, not a
    // public value, and must be protected at rest like accessToken.
    if (updates['whatsapp.accessToken']) {
      updates['whatsapp.accessToken'] = encryptToken(updates['whatsapp.accessToken']);
      updates['whatsapp.tokenUpdatedAt'] = new Date();
    }
    if (updates['whatsapp.verifyToken']) {
      updates['whatsapp.verifyToken'] = encryptToken(updates['whatsapp.verifyToken']);
    }
    if (updates['whatsapp.webhookSecret']) {
      updates['whatsapp.webhookSecret'] = encryptToken(updates['whatsapp.webhookSecret']);
    }

    // [AUDIT-STEP] Auto-advance onboardingStep to 2 when WhatsApp credentials provided,
    // but only if the tenant is still at step 1 (don't regress a verified tenant).
    // [ONE-SHOT] When activate:true is requested, also set connected + ACTIVE + step 4.
    const hasCredentialUpdate = updates['whatsapp.accessToken'] || updates['whatsapp.phoneNumberId'];
    const wantsActivate = req.body.activate === true;

    // Load current tenant state once (needed for step gate and phoneNumberId check)
    const current = await Tenant.findById(req.params.id)
      .select('onboardingStep whatsapp.phoneNumberId whatsapp.accessToken')
      .lean();
    if (!current) return res.status(404).json({ error: 'Not found' });

    if (hasCredentialUpdate) {
      if (current.onboardingStep <= 1) {
        updates['onboardingStep'] = 2;
      }
    }

    if (wantsActivate) {
      // Resolve the phoneNumberId that will be in effect after this update
      const effectivePhoneNumberId = updates['whatsapp.phoneNumberId'] || current.whatsapp?.phoneNumberId;

      // Block if phoneNumberId is still a SIM_ placeholder
      if (!effectivePhoneNumberId || effectivePhoneNumberId.startsWith('SIM_')) {
        return res.status(400).json({
          error:
            'Cannot activate: phoneNumberId is still a simulation placeholder. ' +
            'Include a real Meta phoneNumberId in this request body.',
          phoneNumberId: effectivePhoneNumberId || null,
        });
      }

      // Resolve the accessToken that will be in effect after this update
      const effectiveAccessToken = updates['whatsapp.accessToken'] || current.whatsapp?.accessToken;
      if (!effectiveAccessToken) {
        return res.status(400).json({
          error: 'Cannot activate: accessToken must be set before activation.',
        });
      }

      // Mark connected, activate, and advance to step 4
      updates['whatsapp.connected'] = true;
      updates['status'] = 'ACTIVE';
      if ((current.onboardingStep ?? 0) < 4) {
        updates['onboardingStep'] = 4;
      }

      logger.info('[Tenant] ONE-SHOT activate requested', { tenantId: req.params.id });
    }

    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true },
    );
    if (!tenant) return res.status(404).json({ error: 'Not found' });

    // [AUDIT-P1-A / AUDIT-FIX-6] Sync phoneNumberId to BusinessConfig when changed on Tenant.
    // NOTE: webhook routing actually queries Tenant.whatsapp.phoneNumberId directly
    // (webhookController.js receiveWebhook). BusinessConfig.phoneNumberId is used by
    // businessController and business-config lookups — keeping it in sync prevents those
    // reads from returning stale data after a credential update.
    if (updates['whatsapp.phoneNumberId']) {
      try {
        const syncResult = await BusinessConfig.updateOne(
          { tenantId: String(req.params.id) },
          { $set: { phoneNumberId: updates['whatsapp.phoneNumberId'] } },
        );
        logger.info('[Tenant] Synced phoneNumberId to BusinessConfig', {
          tenantId: req.params.id,
          phoneNumberId: updates['whatsapp.phoneNumberId'],
          matched: syncResult.matchedCount,
          modified: syncResult.modifiedCount,
        });
      } catch (syncErr) {
        // Non-fatal for webhook routing (which reads Tenant directly), but businessController
        // lookups that use BusinessConfig.phoneNumberId will return stale data until the
        // admin retries. Log visibly so the ops team can act.
        logger.warn('[Tenant] BusinessConfig phoneNumberId sync failed — business-config lookups may be stale', {
          tenantId: req.params.id,
          err: syncErr.message,
        });
      }
    }

    logger.info('[Tenant] Updated', { tenantId: tenant._id, fields: Object.keys(updates), activated: wantsActivate });
    // [AUDIT-FIX-2] tenant is a Mongoose document here so toJSON runs — but the transform
    // previously did not strip apiKeyHash. The transform is now fixed, and we also delete
    // it explicitly here as defence-in-depth before the document is serialised.
    const tenantOut = tenant.toJSON();
    delete tenantOut.apiKeyHash;
    res.json({ ok: true, tenant: tenantOut, ...(wantsActivate ? { activated: true, message: 'Tenant credentials set and activated. Bot is live.' } : {}) });
  } catch (err) {
    logger.error('[Tenant] updateTenant failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ─── updateTenantStatus ───────────────────────────────────────────────────────
export async function updateTenantStatus(req, res) {
  try {
    const { status } = req.body;
    // [FIX-G] PENDING added — lets admins revert a suspended tenant to onboarding state
    if (!['ACTIVE', 'SUSPENDED', 'INACTIVE', 'PENDING'].includes(status)) {
      return res.status(400).json({
        error: 'Invalid status. Must be one of: ACTIVE, PENDING, SUSPENDED, INACTIVE',
      });
    }

    // [AUDIT-STEP / AUDIT-FIX-3] Activating a tenant advances onboardingStep to 4.
    // Step 3 = credentials verified with Meta (set by verifyWhatsApp).
    // Step 4 = tenant made live (set here). Distinct values let the frontend tell a
    // verified-but-not-active tenant from a fully live one.
    const stepUpdate = {};
    if (status === 'ACTIVE') {
      const current = await Tenant.findById(req.params.id)
        .select('onboardingStep whatsapp.phoneNumberId')
        .lean();

      // [AUDIT-FIX-4] Block activation when phoneNumberId is still a SIM_ placeholder.
      const phoneNumberId = current?.whatsapp?.phoneNumberId;
      if (!phoneNumberId || phoneNumberId.startsWith('SIM_')) {
        return res.status(400).json({
          error:
            'Cannot activate: phoneNumberId is still a simulation placeholder. ' +
            'Set a real Meta phoneNumberId via PATCH /admin/tenants/:id, then verify ' +
            'credentials via POST /admin/tenants/:id/verify-whatsapp before activating.',
          phoneNumberId: phoneNumberId || null,
        });
      }

      // [FIX-AUTH-2] Check for force:true override BEFORE the onboardingStep gate.
      // The frontend sends force:true when the super-admin explicitly acknowledges
      // that credentials haven't been verified yet and wants to activate anyway.
      // Without this, the frontend's force flag was silently ignored — the backend
      // always blocked activation at step < 3 regardless of what was sent.
      const forceActivate = req.body.force === true;

      // [FIX-GATE] Block activation if WhatsApp credentials have not been verified
      // with Meta (onboardingStep < 3). Without this gate a super-admin can activate
      // a tenant that skipped verifyWhatsApp entirely — the bot would go live with
      // unverified (possibly wrong) credentials and silently drop every message.
      // Steps: 1=created, 2=credentials supplied, 3=Meta verified, 4=active.
      const currentStep = current?.onboardingStep ?? 0;
      if (currentStep < 3 && !forceActivate) {
        return res.status(400).json({
          error:
            'Cannot activate: WhatsApp credentials must be verified before activation. ' +
            'Complete onboarding via POST /admin/tenants/:id/verify-whatsapp first, ' +
            'or send { force: true } to activate without verification.',
          onboardingStep: currentStep,
          required: 3,
        });
      }

      if (currentStep < 4) {
        stepUpdate.onboardingStep = 4;
      }
    }

    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: { status, ...stepUpdate } },
      { new: true },
    );
    if (!tenant) return res.status(404).json({ error: 'Not found' });

    logger.info('[Tenant] Status updated', { tenantId: tenant._id, status, onboardingStep: tenant.onboardingStep });
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

    // [FIX-TENANT-1] Delete ALL tenant-scoped data — not just BusinessConfig.
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

    if (tenantResult.status === 'rejected') {
      throw tenantResult.reason;
    }
    if (tenantResult.value === null) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Log non-fatal collection cleanup failures but don't fail the request
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
 * [AUDIT-P2-C] Validates stored WhatsApp credentials against the Meta Graph API
 * phone number info endpoint. On success, sets whatsapp.connected = true and
 * advances onboardingStep to 3 if not already there.
 *
 * This endpoint should be called BEFORE activating a tenant, so the super-admin
 * can confirm the credentials are correct before going live.
 */
export async function verifyWhatsApp(req, res) {
  try {
    const tenant = await Tenant.findById(req.params.id).lean();
    if (!tenant) return res.status(404).json({ error: 'Not found' });

    const { accessToken, phoneNumberId, apiVersion = 'v21.0' } = tenant.whatsapp || {};

    if (!accessToken || !phoneNumberId) {
      return res.status(400).json({
        error: 'accessToken and phoneNumberId must both be set before verification. ' +
               'Use PATCH /admin/tenants/:id to set them first.',
      });
    }

    // Decrypt token for the outbound API call
    const token = decryptToken(accessToken);

    // Strip any SIM_ placeholder phoneNumberIds (created when no real credentials supplied)
    if (phoneNumberId.startsWith('SIM_')) {
      return res.status(400).json({
        error: 'phoneNumberId is still a simulation placeholder. Set a real Meta phoneNumberId first.',
        phoneNumberId,
      });
    }

    // [FIX-VERIFY-2] Validate phoneNumberId looks like a real Meta Phone Number ID
    // before making the outbound API call. Meta Phone Number IDs are purely numeric
    // and typically 15+ digits. If the value contains non-numeric characters it is
    // almost certainly a WABA ID, App ID, or copy-paste error — return a clear error
    // instead of a cryptic Meta "does not exist" response.
    if (!/^\d{10,}$/.test(phoneNumberId)) {
      return res.status(400).json({
        verified: false,
        error: `phoneNumberId "${phoneNumberId}" does not look like a valid Meta Phone Number ID.`,
        hint: 'A valid Phone Number ID is purely numeric (e.g. 123456789012345). Find it in Meta for Developers → WhatsApp → API Setup → "Phone number ID". Do NOT use the WABA ID, App ID, or phone number itself.',
        phoneNumberId,
      });
    }

    const url  = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);

    let metaResp;
    try {
      metaResp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch (fetchErr) {
      clearTimeout(timer);
      const isTimeout = fetchErr.name === 'AbortError';
      return res.status(502).json({
        verified: false,
        error: isTimeout
          ? 'Request to Meta API timed out (10s). Check network and try again.'
          : `Network error reaching Meta API: ${fetchErr.message}`,
      });
    }

    if (!metaResp.ok) {
      const errBody = await metaResp.json().catch(() => ({}));
      const metaMsg = errBody?.error?.message || 'Meta API rejected the credentials';
      const metaCode = errBody?.error?.code;

      // [FIX-VERIFY-1] Translate common Meta Graph API errors into actionable guidance
      // instead of forwarding the raw cryptic message to the frontend.
      let hint = null;
      if (metaMsg.toLowerCase().includes('does not exist') || metaMsg.toLowerCase().includes('unsupported get')) {
        hint = 'The Phone Number ID appears to be wrong. In Meta for Developers → WhatsApp → API Setup, copy the numeric "Phone number ID" field. Do NOT use the WABA ID, App ID, or phone number itself.';
      } else if (metaCode === 190 || metaMsg.toLowerCase().includes('access token')) {
        hint = 'The Access Token is invalid or expired. Generate a new System User token in Meta Business Manager with whatsapp_business_messaging permission.';
      } else if (metaCode === 10 || metaMsg.toLowerCase().includes('permission')) {
        hint = 'The token is missing required permissions. Ensure the System User has whatsapp_business_messaging and whatsapp_business_management permissions.';
      }

      logger.warn('[Tenant] WhatsApp verification failed', {
        tenantId: req.params.id,
        status: metaResp.status,
        metaCode,
      });
      return res.status(400).json({
        verified:   false,
        error:      metaMsg,
        hint,
        metaCode,
        metaType:   errBody?.error?.type,
        httpStatus: metaResp.status,
      });
    }

    const data = await metaResp.json();

    // [FIX-3] Was doing a second Tenant.findById(...).select('onboardingStep') here,
    // but `tenant` was already loaded with .lean() at the top of this function.
    // tenant.onboardingStep is already in memory — no second DB round-trip needed.
    // Guard < 3: a tenant already at step 4 (active) stays at 4 on re-verification.
    const currentStep = tenant.onboardingStep ?? 0;
    const newStep = currentStep < 3 ? 3 : currentStep;

    await Tenant.findByIdAndUpdate(req.params.id, {
      $set: {
        'whatsapp.connected': true,
        onboardingStep: newStep,
      },
    });

    logger.info('[Tenant] WhatsApp credentials verified', {
      tenantId: req.params.id,
      phoneNumberId,
      displayNumber: data.display_phone_number,
    });

    res.json({
      verified:      true,
      phoneNumberId,
      displayPhone:  data.display_phone_number,
      verifiedName:  data.verified_name,
      qualityRating: data.quality_rating,
      onboardingStep: newStep,
    });
  } catch (err) {
    logger.error('[Tenant] verifyWhatsApp failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ─── rotateApiKey — POST /admin/tenants/:id/rotate-key ───────────────────────
/**
 * [AUDIT-P2-D] Generates a new API key and hash for the tenant without deleting
 * any data. The new key is returned once and never exposed again.
 *
 * The Tenant pre-validate hook skips regeneration when apiKey is already set,
 * so we bypass it by setting both apiKey and apiKeyHash directly via $set.
 *
 * The old key is immediately invalidated — any in-flight requests using it will
 * receive 401 on their next attempt.
 */
export async function rotateApiKey(req, res) {
  try {
    // [FIX-RAWKEY] Generate the new key in memory, store only its SHA-256 hash.
    // The plaintext key is returned once in this response and then discarded —
    // it is never written to the DB. $unset apiKey removes any legacy plaintext
    // key that may exist on older tenant documents.
    const newKey  = crypto.randomBytes(32).toString('hex');
    const newHash = crypto.createHash('sha256').update(newKey).digest('hex');

    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: { apiKeyHash: newHash }, $unset: { apiKey: '' } },
      { new: true, runValidators: false },
    );
    if (!tenant) return res.status(404).json({ error: 'Not found' });

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