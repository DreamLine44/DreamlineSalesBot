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
 * [FIX-BM]       createTenant now passes businessMode to the Tenant document AND
 *                normalises / validates it before writing, so listTenants returns
 *                the mode without a BusinessConfig join.
 *
 * [FIX-LIST]     listTenants now selects businessMode so TenantRow never shows
 *                "undefined" for the Mode column.
 *
 * [FIX-E11000]   createTenant and updateTenant return a clean 409 JSON response
 *                instead of a raw 500 when a duplicate-key error occurs (e.g.
 *                duplicate email or phoneNumberId).
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

export async function createTenant(req, res) {
  try {
    const {
      name, businessMode = 'RESTAURANT', adminPhone,
      whatsapp = {}, menuItems = [], services = [], payment = {},
      leadCapture = {}, faq = [], description = '',
    } = req.body;

    // [FIX-TENANT-2] Return a clean 400 before Mongoose throws a ValidationError
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    // Validate businessMode against the BusinessConfig enum
    const VALID_MODES = ['RESTAURANT', 'SALON', 'BARBERSHOP', 'RETAIL', 'BAKERY', 'SUPERMARKET', 'FASHION', 'COSMETICS', 'ELECTRONICS', 'PHARMACY', 'DELIVERY'];
    const normalizedMode = (businessMode || 'RESTAURANT').toUpperCase();
    if (!VALID_MODES.includes(normalizedMode)) {
      return res.status(400).json({ error: `Invalid businessMode. Must be one of: ${VALID_MODES.join(', ')}` });
    }

    // [FIX #6]  No status:'ACTIVE' — the Tenant schema default is 'PENDING'.
    // [FIX #8]  No manual apiKey generation — the Tenant pre-validate hook handles it
    //           (randomBytes(32), 64 hex chars). We read the key back from the saved doc.
    // [FIX-BM]  Pass businessMode to Tenant so listTenants can return it directly.
    const tenant = await Tenant.create({
      name: name.trim(), adminPhone,
      businessMode: normalizedMode,
      whatsapp: {
        phoneNumberId: whatsapp.phoneNumberId || `SIM_${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        accessToken:   whatsapp.accessToken   || null,
        apiVersion:    whatsapp.apiVersion    || 'v21.0',
      },
    });

    const business = await BusinessConfig.create({
      tenantId:     String(tenant._id),
      name:         name.trim(), businessMode: normalizedMode, adminPhone,
      description,  menuItems,    services,
      payment, leadCapture, faq,
      addOns: [],
    });

    logger.info('[Tenant] Created', { tenantId: tenant._id, name: tenant.name, status: tenant.status, businessMode: normalizedMode });
    res.status(201).json({
      // apiKey is only exposed here (plaintext) — omitted from all subsequent GET responses
      // via the Tenant toJSON transform.
      tenant:   { _id: tenant._id, name: tenant.name, status: tenant.status, businessMode: tenant.businessMode, apiKey: tenant.apiKey },
      business: { _id: business._id, businessMode, name: business.name },
      next:     `Use x-api-key: ${tenant.apiKey} for business / dashboard routes. Activate via PATCH /admin/tenants/${tenant._id}/status`,
    });
  } catch (err) {
    // [FIX-E11000] Return a clean 409 instead of a raw 500 for duplicate key errors
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || 'field';
      return res.status(409).json({ error: `A tenant with that ${field} already exists.` });
    }
    logger.error('[Tenant] createTenant failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function listTenants(req, res) {
  try {
    // [FIX #12] Support ?name= and ?status= filters.
    const filter = {};
    if (req.query.name)   filter.name   = { $regex: req.query.name, $options: 'i' };
    if (req.query.status) filter.status = req.query.status;

    // [FIX-LIST] Include businessMode so TenantRow on the frontend can display it
    const tenants = await Tenant.find(filter)
      .select('name status createdAt whatsapp.phoneNumberId plan adminPhone businessMode')
      .lean();
    res.json({ tenants, count: tenants.length });
  } catch (err) {
    logger.error('[Tenant] listTenants failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function getTenant(req, res) {
  try {
    const tenant = await Tenant.findById(req.params.id).lean();
    if (!tenant) return res.status(404).json({ error: 'Not found' });
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
 * [FIX #7] Allows updating tenant credentials/metadata post-creation.
 * Allowlist excludes _id, apiKey, apiKeyHash, status (use /status route for that).
 * Supports both nested-object body ({ whatsapp: { accessToken: '...' } }) and
 * flat dot-notation body ({ 'whatsapp.accessToken': '...' }).
 * Also exposes limits.* fields (v2 addition).
 */
export async function updateTenant(req, res) {
  try {
    const ALLOWED = [
      'name', 'adminPhone', 'email', 'plan', 'notes', 'onboardingStep',
      'whatsapp.phone', 'whatsapp.phoneNumberId', 'whatsapp.wabaId',
      'whatsapp.accessToken', 'whatsapp.verifyToken', 'whatsapp.apiVersion',
      'whatsapp.connected',
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

    // Mark tokenUpdatedAt when the access token is rotated
    if (updates['whatsapp.accessToken']) {
      updates['whatsapp.tokenUpdatedAt'] = new Date();
    }

    // [FIX-BIZ-5] Auto-set connected=true when both phoneNumberId AND accessToken are present.
    // Previously whatsapp.connected was never set to true on credential save, so the frontend
    // always showed "not connected" even though the admin panel showed "2 WhatsApp Connected".
    if (updates['whatsapp.accessToken'] || updates['whatsapp.phoneNumberId']) {
      const existing = await Tenant.findById(req.params.id).select('whatsapp').lean();
      const finalPhoneId = updates['whatsapp.phoneNumberId'] || existing?.whatsapp?.phoneNumberId;
      const finalToken   = updates['whatsapp.accessToken']   || existing?.whatsapp?.accessToken;
      updates['whatsapp.connected'] = !!(finalPhoneId && finalToken);
    }

    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true },
    );
    if (!tenant) return res.status(404).json({ error: 'Not found' });

    logger.info('[Tenant] Updated', { tenantId: tenant._id, fields: Object.keys(updates) });
    res.json({ ok: true, tenant });
  } catch (err) {
    // [FIX-E11000] Return a clean 409 instead of a raw 500 for duplicate key errors
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || 'field';
      return res.status(409).json({ error: `A tenant with that ${field} already exists.` });
    }
    logger.error('[Tenant] updateTenant failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function updateTenantStatus(req, res) {
  try {
    const { status } = req.body;
    // [FIX-G] PENDING added — lets admins revert a suspended tenant to onboarding state
    if (!['ACTIVE', 'SUSPENDED', 'INACTIVE', 'PENDING'].includes(status)) {
      return res.status(400).json({
        error: 'Invalid status. Must be one of: ACTIVE, PENDING, SUSPENDED, INACTIVE',
      });
    }

    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true },
    );
    if (!tenant) return res.status(404).json({ error: 'Not found' });

    logger.info('[Tenant] Status updated', { tenantId: tenant._id, status });
    res.json({ ok: true, status: tenant.status });
  } catch (err) {
    logger.error('[Tenant] updateTenantStatus failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

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
