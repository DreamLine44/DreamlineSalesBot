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

import { Tenant, BusinessConfig, Session, Order, Booking, UserProfile, Analytics, ProcessedMessage, WhatsAppConnectionRequest } from '../models/index.js';
import crypto           from 'crypto';
import logger           from '../config/logger.js';
import { applyAdminPhonesUpdate } from '../utils/adminPhones.js';

// [AUDIT-FIX-9] Same fix as dashboardController.getCustomers — listTenants'
// ?name= search was interpolated directly into a $regex filter. An unescaped
// metacharacter (e.g. a name search containing "+", "(", or "*") either
// throws a MongoDB regex-compile error or risks a catastrophic-backtracking
// pattern. Escape before building the filter so the search behaves as a
// literal case-insensitive substring match.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  // [FIX-SIG-3] Trim before encrypting. A secret copy-pasted from the Meta
  // dashboard (or a form/textarea) very commonly carries a trailing newline
  // or space. Once that whitespace is baked into the ciphertext there is no
  // way to recover the "clean" value later — every HMAC computed against the
  // real secret will permanently mismatch the one computed against the
  // whitespace-padded stored value, with nothing in the logs to indicate why
  // (hadTenantSecret reads true; the comparison just silently never matches).
  // Trimming here means the secret we encrypt is always the same one Meta
  // itself uses to sign, regardless of how it was pasted in.
  plaintext = String(plaintext).trim();
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
 * [FIX-SIG-FINGERPRINT] Non-reversible fingerprint of a secret, safe to log.
 *
 * The webhook signature mismatches seen in production (see webhookController.js
 * _verifyTenantWebhookSignature) all share one root-cause pattern: a secret is
 * stored, it decrypts fine (hadTenantSecret: true), and it STILL never matches
 * what Meta signs with — because the wrong value was pasted in (a copy from
 * the wrong Meta App, a truncated paste, the App ID pasted where the App
 * Secret belongs, etc). Every log line up to now could say "a secret exists"
 * but never "whether it's the RIGHT secret," which left operators guessing.
 *
 * This fingerprint (first 12 hex chars of sha256(trimmed-plaintext)) lets an
 * operator answer that conclusively without ever exposing/transmitting the
 * real secret twice: log this fingerprint at save time, then independently
 * compute the same fingerprint of the value shown in the Meta App Dashboard
 * (via POST /admin/webhook-secret-fingerprint — see adminRoutes.js) and
 * compare the two 12-char strings. Match → stored secret is correct, the
 * mismatch has some other cause (second Meta App subscribed, wrong
 * phoneNumberId routing, etc). No match → the stored secret is simply wrong;
 * re-enter it.
 */
export function fingerprintSecret(plaintext) {
  if (!plaintext) return null;
  return crypto.createHash('sha256').update(String(plaintext).trim(), 'utf8').digest('hex').slice(0, 12);
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

    // [FEAT-MULTI-ADMIN] adminPhone may hold up to 2 numbers separated by
    // ',' '/' or ';' — parse into adminPhone (primary) + adminPhones (full list).
    const adminPhoneFields = applyAdminPhonesUpdate(adminPhone) || { adminPhone: null, adminPhones: [] };

    const tenant = await Tenant.create({
      name: name.trim(),
      ...adminPhoneFields,
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
      businessMode,  ...adminPhoneFields,  description,
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
// [IMPROVE-PAGINATION] Added optional ?page=&limit= pagination, same pattern used
// elsewhere in the app (Math.min/Math.max guarded, capped at 100). Existing callers
// that don't send page/limit still get a working response — defaults to page 1,
// limit 100 (comfortably above current tenant counts), and the response still
// includes the original `tenants` + `count` keys so nothing that already reads
// this endpoint breaks. New `total`, `page`, `pages`, `limit` keys are additive.
export async function listTenants(req, res) {
  try {
    const filter = {};
    if (req.query.name)   filter.name   = { $regex: escapeRegex(req.query.name), $options: 'i' };
    if (req.query.status) filter.status = req.query.status;

    const safeLimit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const safePage  = Math.max(Number(req.query.page) || 1, 1);
    const skip      = (safePage - 1) * safeLimit;

    const [tenants, total] = await Promise.all([
      Tenant.find(filter)
        .select('name status createdAt email adminPhone plan onboardingStep whatsapp.phoneNumberId whatsapp.connected whatsapp.phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      Tenant.countDocuments(filter),
    ]);

    if (tenants.length > 0) {
      const ids     = tenants.map(t => String(t._id));
      const configs = await BusinessConfig.find(
        { tenantId: { $in: ids } },
        { tenantId: 1, businessMode: 1 },
      ).lean();
      const modeMap = Object.fromEntries(configs.map(c => [String(c.tenantId), c.businessMode]));
      for (const t of tenants) t.businessMode = modeMap[String(t._id)] || null;
    }

    res.json({
      tenants,
      count: tenants.length,
      total,
      page:  safePage,
      pages: Math.ceil(total / safeLimit),
      limit: safeLimit,
    });
  } catch (err) {
    logger.error('[Tenant] listTenants failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ─── getPlatformStats — GET /admin/tenants/stats ─────────────────────────────
// [IMPROVE-STATS] New endpoint so the super-admin dashboard doesn't have to
// fetch and aggregate the entire tenant table client-side (which the frontend
// was doing before this existed — fine at a handful of tenants, wasteful and
// slow once the platform has dozens/hundreds). Single aggregation query per
// collection, all run in parallel.
export async function getPlatformStats(req, res) {
  try {
    const [
      totalTenants,
      statusCounts,
      waConfiguredCount,
      waConnectedCount,
      pendingRequestsCount,
      requestStatusCounts,
    ] = await Promise.all([
      Tenant.countDocuments({}),
      Tenant.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Tenant.countDocuments({ 'whatsapp.accessToken': { $ne: null } }),
      Tenant.countDocuments({ 'whatsapp.connected': true }),
      WhatsAppConnectionRequest.countDocuments({ status: 'pending' }),
      WhatsAppConnectionRequest.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);

    const byStatus = { ACTIVE: 0, PENDING: 0, SUSPENDED: 0, INACTIVE: 0 };
    for (const row of statusCounts) {
      if (row._id in byStatus) byStatus[row._id] = row.count;
    }

    const requestsByStatus = { pending: 0, contacted: 0, connecting: 0, connected: 0, rejected: 0 };
    for (const row of requestStatusCounts) {
      if (row._id in requestsByStatus) requestsByStatus[row._id] = row.count;
    }

    res.json({
      tenants: {
        total: totalTenants,
        byStatus,
      },
      whatsapp: {
        credentialsSaved: waConfiguredCount,
        fullyConnected:   waConnectedCount,
      },
      connectionRequests: {
        pending: pendingRequestsCount,
        byStatus: requestsByStatus,
      },
    });
  } catch (err) {
    logger.error('[Tenant] getPlatformStats failed', { err: err.message });
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

    // [FIX-CATALOGID-BUSINESSCONFIG-SYNC] waCatalog.catalogId is deliberately
    // NOT in ALLOWED above — it isn't a Tenant schema field at all, it lives
    // on BusinessConfig (see models/BusinessConfig.js). Admin-panel UX puts it
    // on this same "save credentials" screen/request (AUDIT-FIX-CATALOG-ADMIN-1,
    // frontend AdminTenantsPage.jsx), so this endpoint still accepts it — it's
    // just written to BusinessConfig below (mirroring the phoneNumberId sync
    // block, [AUDIT-P1-A]) instead of being forced onto the Tenant document,
    // where it would either be silently dropped (Mongoose strict mode) or sit
    // as a stray untyped field nothing ever reads.
    //
    // Previously this field wasn't recognized ANYWHERE in this handler, so it
    // was silently discarded from `updates` with no error — a save request
    // would return 200 "success" while the catalog ID was never persisted to
    // any collection. That silent-drop is exactly what CROSS_MODEL_FIELDS +
    // findIgnoredFields() below now catch generally, for this field and any
    // future one like it.
    const CROSS_MODEL_FIELDS = ['waCatalog.catalogId'];

    // [FIX-SILENT-DROP-1] Any request field that isn't in ALLOWED, isn't a
    // known cross-model field, and isn't `activate` is currently just thrown
    // away with zero signal to the caller — a save can "succeed" (200) while
    // silently changing nothing. That's exactly the bug that let the catalog
    // ID vanish above. Rather than relying on every future field being added
    // to ALLOWED correctly, this surfaces anything unrecognized in the
    // response as `ignored`, so a silent drop is visible immediately instead
    // of requiring another debugging session.
    const KNOWN_NESTED_SUBFIELDS = {
      whatsapp: ['phone', 'phoneNumberId', 'wabaId', 'accessToken', 'verifyToken', 'webhookSecret', 'apiVersion'],
      meta:     ['appId', 'appSecret'],
      waCatalog: ['catalogId'],
      limits:   ['messagesPerMonth', 'maxMenuItems', 'maxAdmins'],
    };
    function findIgnoredFields(body) {
      const knownTop = new Set([
        'name', 'adminPhone', 'email', 'plan', 'notes', 'activate',
        ...Object.keys(KNOWN_NESTED_SUBFIELDS),
        ...ALLOWED, ...CROSS_MODEL_FIELDS, // flat dotted forms, e.g. 'whatsapp.accessToken'
      ]);
      const ignored = [];
      for (const key of Object.keys(body)) {
        if (KNOWN_NESTED_SUBFIELDS[key] && body[key] && typeof body[key] === 'object') {
          for (const subKey of Object.keys(body[key])) {
            if (!KNOWN_NESTED_SUBFIELDS[key].includes(subKey)) ignored.push(`${key}.${subKey}`);
          }
          continue;
        }
        if (!knownTop.has(key)) ignored.push(key);
      }
      return ignored;
    }
    const ignoredFields = findIgnoredFields(req.body);

    // [FIX-CRED-BLANK-GUARD] Every field below is a real Meta/WhatsApp
    // credential — there is no legitimate product reason to ever SET one of
    // these to an empty string (see catalogIdUpdate above, which already
    // treats a blank value as "no change" rather than "clear this field," for
    // the exact same reason). Before this fix, the loop below only checked
    // `!== undefined`, so any request that included e.g.
    // `whatsapp: { accessToken: '' }` — trivial to trigger from an admin-panel
    // form that resubmits every field on the screen, including ones the
    // operator never touched and whose real (encrypted) value it never held
    // locally in the first place — would pass '' straight through: '' is
    // falsy, so the encryption block just below (`if (updates['whatsapp.
    // accessToken'])`) skips it, and Tenant.findByIdAndUpdate's `$set` then
    // overwrites the real, working, encrypted secret with a plain empty
    // string. That silently breaks WhatsApp sending/receiving and webhook
    // signature verification for the tenant on a save that had nothing to do
    // with credentials, with no error surfaced anywhere. Any field on this
    // list is now only accepted into `updates` when it's a non-blank string
    // after trimming — a blank/whitespace-only value is treated as "not
    // supplied," exactly like leaving the field out of the request entirely.
    const BLANK_GUARDED_FIELDS = new Set([
      'whatsapp.phone', 'whatsapp.phoneNumberId', 'whatsapp.wabaId',
      'whatsapp.accessToken', 'whatsapp.verifyToken', 'whatsapp.webhookSecret', 'whatsapp.apiVersion',
      'meta.appId', 'meta.appSecret',
    ]);
    function isBlank(v) {
      return typeof v === 'string' && !v.trim();
    }

    // Accept both nested { whatsapp: { accessToken } } and flat { 'whatsapp.accessToken': '...' }
    const updates = {};
    for (const field of ALLOWED) {
      const parts = field.split('.');
      if (parts.length === 1) {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      } else {
        const [top, sub] = parts;
        const nestedVal = req.body[top]?.[sub];
        const flatVal   = req.body[field];
        if (nestedVal !== undefined && !(BLANK_GUARDED_FIELDS.has(field) && isBlank(nestedVal))) {
          updates[`${top}.${sub}`] = nestedVal;
        }
        if (flatVal !== undefined && !(BLANK_GUARDED_FIELDS.has(field) && isBlank(flatVal))) {
          updates[field] = flatVal;
        }
      }
    }

    // [FEAT-MULTI-ADMIN] 'adminPhone' may hold up to 2 numbers separated by
    // ',' '/' or ';'. Expand it into the adminPhone (primary) + adminPhones
    // (full list) pair the schema stores — same helper used by createTenant.
    if (updates.adminPhone !== undefined) {
      Object.assign(updates, applyAdminPhonesUpdate(updates.adminPhone));
    }

    // [FIX-CATALOGID-BUSINESSCONFIG-SYNC] Read the catalog ID out separately —
    // supports both nested { waCatalog: { catalogId } } and flat
    // { 'waCatalog.catalogId': '...' }, same convention as every other field
    // above. Trimmed and only kept if non-empty, matching the frontend's own
    // "don't send blank — use the explicit clear affordance" guard, so an
    // accidental empty save can't wipe out a previously-set catalog ID.
    const catalogIdRaw = req.body.waCatalog?.catalogId ?? req.body['waCatalog.catalogId'];
    const catalogIdUpdate = typeof catalogIdRaw === 'string' && catalogIdRaw.trim()
      ? catalogIdRaw.trim()
      : undefined;

    const wantsActivate = req.body.activate === true;

    if (!Object.keys(updates).length && !wantsActivate && !catalogIdUpdate) {
      return res.status(400).json({ error: 'No valid fields to update', allowed: [...ALLOWED, ...CROSS_MODEL_FIELDS] });
    }

    // Encrypt sensitive tokens before they reach the DB
    if (updates['whatsapp.accessToken']) {
      updates['whatsapp.accessToken']    = encryptToken(updates['whatsapp.accessToken']);
      updates['whatsapp.tokenUpdatedAt'] = new Date();
    }
    if (updates['whatsapp.verifyToken'])   updates['whatsapp.verifyToken']   = encryptToken(updates['whatsapp.verifyToken']);
    // [FIX-SIG-FINGERPRINT] Log the fingerprint of each webhook-signing secret
    // at the moment it's saved — BEFORE encryption, using the same trimmed
    // plaintext that will actually be used for HMAC verification. This is the
    // one point in the whole system where we still hold the real value; once
    // it's encrypted+stored, the only way to check "is this the secret Meta
    // is actually signing with" is to compare fingerprints (see
    // POST /admin/webhook-secret-fingerprint in adminRoutes.js). Never logs
    // the plaintext secret itself, only its 12-char fingerprint.
    if (updates['whatsapp.webhookSecret']) {
      logger.info('[TenantCtrl] whatsapp.webhookSecret saved', {
        tenantId: req.params.id,
        fingerprint: fingerprintSecret(updates['whatsapp.webhookSecret']),
      });
      updates['whatsapp.webhookSecret'] = encryptToken(updates['whatsapp.webhookSecret']);
    }
    if (updates['meta.appSecret']) {
      logger.info('[TenantCtrl] meta.appSecret saved', {
        tenantId: req.params.id,
        fingerprint: fingerprintSecret(updates['meta.appSecret']),
      });
      updates['meta.appSecret'] = encryptToken(updates['meta.appSecret']);
    }

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

    // [FIX-CATALOGID-BUSINESSCONFIG-SYNC] waCatalog.catalogId lives on
    // BusinessConfig, not Tenant, so it's written here directly rather than
    // via the ALLOWED/Tenant.findByIdAndUpdate path above — mirrors the
    // phoneNumberId sync block immediately above. Also clears any stale
    // waCatalog.lastSyncError: a newly-set catalog ID makes a previous sync
    // failure (which may well have been caused by the missing/wrong ID)
    // moot, and leaving it in place would keep showing an old GRAPH_ERROR on
    // the tenant's Catalog page even after the real problem is fixed.
    let updatedBusiness = null;
    if (catalogIdUpdate) {
      try {
        updatedBusiness = await BusinessConfig.findOneAndUpdate(
          { tenantId: String(req.params.id) },
          {
            $set: {
              'waCatalog.catalogId':    catalogIdUpdate,
              'waCatalog.lastSyncError': { reason: null, detail: null, at: null },
            },
          },
          { new: true },
        ).lean();
        logger.info('[Tenant] Synced waCatalog.catalogId to BusinessConfig', {
          tenantId: req.params.id,
        });
      } catch (syncErr) {
        logger.warn('[Tenant] BusinessConfig waCatalog.catalogId sync failed (non-fatal)', {
          tenantId: req.params.id,
          err: syncErr.message,
        });
      }
    }

    logger.info('[Tenant] Updated', {
      tenantId:  tenant._id,
      fields:    Object.keys(updates),
      catalogIdUpdated: !!catalogIdUpdate,
      ignoredFields: ignoredFields.length ? ignoredFields : undefined,
      activated: wantsActivate,
    });

    // [AUDIT-FIX-2] Delete apiKeyHash after toJSON() as defence-in-depth
    const tenantOut = tenant.toJSON();
    delete tenantOut.apiKeyHash;

    res.json({
      ok:     true,
      tenant: tenantOut,
      // [FIX-CATALOGID-BUSINESSCONFIG-SYNC] Included whenever a catalog ID
      // write was attempted, so the frontend can confirm — rather than
      // assume — that it actually landed, instead of trusting a bare 200.
      ...(updatedBusiness ? { business: { waCatalog: updatedBusiness.waCatalog } } : {}),
      // [FIX-SILENT-DROP-1] Any request field that wasn't recognized (typo,
      // wrong nesting, or simply not yet wired up) is surfaced here instead
      // of vanishing with no trace.
      ...(ignoredFields.length ? { ignored: ignoredFields } : {}),
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
