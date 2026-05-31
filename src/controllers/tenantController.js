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
    // [FIX-WA-1] Do NOT assign a fake SIM_ phoneNumberId when none is provided.
    // A fake ID stored in whatsapp.phoneNumberId (unique sparse index) meant:
    //  a) receiveWebhook's Tenant.findOne({ 'whatsapp.phoneNumberId': realMetaId })
    //     could never match this tenant until the real ID was entered, silently
    //     dropping all incoming messages.
    //  b) The tenant setup page showed the fake SIM_ value in the "Phone Number ID"
    //     checklist field, misleading admins.
    // Fix: leave phoneNumberId absent until the admin provides the real Meta
    // phone_number_id via PATCH /admin/tenants/:id (Update WhatsApp Credentials).
    const whatsappData = { apiVersion: whatsapp.apiVersion || 'v21.0' };
    if (whatsapp.phoneNumberId) whatsappData.phoneNumberId = whatsapp.phoneNumberId;
    if (whatsapp.accessToken)   whatsappData.accessToken   = whatsapp.accessToken;
    if (whatsapp.verifyToken)   whatsappData.verifyToken   = whatsapp.verifyToken;
    if (whatsapp.wabaId)        whatsappData.wabaId        = whatsapp.wabaId;

    const tenant = await Tenant.create({
      name: name.trim(), adminPhone,
      businessMode: normalizedMode,
      whatsapp: whatsappData,
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

    // [FIX-WA-5] Added whatsapp.connected to the select projection so the admin
    // panel can display per-tenant WhatsApp connection status without a separate
    // getTenant call. Previously the connected boolean was silently omitted, so the
    // admin list always showed every tenant as disconnected regardless of actual state.
    const tenants = await Tenant.find(filter)
      .select('name status createdAt whatsapp.phoneNumberId whatsapp.connected plan adminPhone businessMode')
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

    // [FIX-WA-6] .lean() bypasses the Tenant toJSON transform that strips
    // whatsapp.accessToken and apiKey. Manually redact them here so the
    // access token is never sent to the frontend (it's a permanent Meta token —
    // exposing it in API responses is a serious security risk).
    if (tenant.whatsapp) delete tenant.whatsapp.accessToken;
    delete tenant.apiKey;
    delete tenant.__v;

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

    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true },
    );
    if (!tenant) return res.status(404).json({ error: 'Not found' });

    // [FIX-WA-2] After saving WhatsApp credentials, verify them against the Meta API
    // and set whatsapp.connected accordingly. Previously connected was never set to
    // true by any code path — the field stayed false forever, so the tenant dashboard
    // always showed "WhatsApp not yet connected" even with valid credentials.
    //
    // We verify when any WhatsApp credential was updated AND we have both
    // phoneNumberId and accessToken available (either just saved or already on doc).
    const whatsappFieldsChanged = Object.keys(updates).some(k => k.startsWith('whatsapp.'));
    if (whatsappFieldsChanged) {
      const phoneId    = tenant.whatsapp?.phoneNumberId;
      // [FIX-SHARED-APP] Fall back to global META_WHATSAPP_TOKEN — operators using
      // one system-user token for all tenants don't need to save per-tenant accessToken.
      const token      = tenant.whatsapp?.accessToken || process.env.META_WHATSAPP_TOKEN;
      const apiVersion = tenant.whatsapp?.apiVersion || process.env.META_API_VERSION || 'v21.0';

      if (phoneId && token) {
        // Validate phoneNumberId is a real numeric Meta ID (not a leftover SIM_ fake)
        const looksNumeric = /^\d{10,20}$/.test(phoneId.trim());
        if (!looksNumeric) {
          logger.warn('[Tenant] phoneNumberId does not look like a valid Meta numeric ID — skipping verification', { phoneId, tenantId: tenant._id });
          await Tenant.findByIdAndUpdate(req.params.id, { $set: { 'whatsapp.connected': false } });
        } else {
          // Call Meta API to verify the phone number ID is real and the token has access
          try {
            const ctrl  = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 8000);
            const resp  = await fetch(
              `https://graph.facebook.com/${apiVersion}/${phoneId}?fields=id,display_phone_number,verified_name`,
              {
                headers: { Authorization: `Bearer ${token}` },
                signal: ctrl.signal,
              },
            );
            clearTimeout(timer);
            const connected = resp.ok;
            if (!connected) {
              const errText = await resp.text().catch(() => '');
              logger.warn('[Tenant] WhatsApp credential verification failed', {
                tenantId: tenant._id, status: resp.status, err: errText.slice(0, 200),
              });
            } else {
              logger.info('[Tenant] WhatsApp credentials verified — marking connected', { tenantId: tenant._id, phoneId });
            }
            await Tenant.findByIdAndUpdate(req.params.id, { $set: { 'whatsapp.connected': connected } });
            // Return updated connected status to the caller
            tenant.whatsapp = { ...tenant.whatsapp, connected };
          } catch (verifyErr) {
            logger.warn('[Tenant] Meta credential check network error (marking disconnected)', {
              tenantId: tenant._id, err: verifyErr.message,
            });
            await Tenant.findByIdAndUpdate(req.params.id, { $set: { 'whatsapp.connected': false } });
          }
        }
      } else if (Object.keys(updates).some(k => k === 'whatsapp.phoneNumberId' || k === 'whatsapp.accessToken')) {
        // One of the two required creds was cleared — mark disconnected
        await Tenant.findByIdAndUpdate(req.params.id, { $set: { 'whatsapp.connected': false } });
        if (tenant.whatsapp) tenant.whatsapp.connected = false;
      }
    }

    logger.info('[Tenant] Updated', { tenantId: tenant._id, fields: Object.keys(updates) });

    // [FIX-WA-7] Keep BusinessConfig in sync when adminPhone or businessMode changes
    // on the Tenant doc. Previously editing the tenant in the Admin panel updated
    // Tenant.adminPhone but left BusinessConfig.adminPhone stale — the bot and
    // dashboard would show different phone numbers, and admin-command lookups
    // (isAdminPhone) use BusinessConfig, so the admin's new phone would be ignored.
    const bizSync = {};
    if (updates.adminPhone !== undefined) bizSync.adminPhone = updates.adminPhone;
    if (updates.businessMode !== undefined) bizSync.businessMode = updates.businessMode;
    if (updates.name !== undefined) bizSync.name = updates.name;
    if (Object.keys(bizSync).length) {
      await BusinessConfig.findOneAndUpdate(
        { tenantId: String(req.params.id) },
        { $set: bizSync },
      ).catch(err => logger.warn('[Tenant] BusinessConfig sync failed (non-fatal)', { err: err.message }));
    }

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

/**
 * verifyWhatsAppConnection — POST /admin/tenants/:id/whatsapp/verify
 *
 * [FIX-WA-8] On-demand WhatsApp credential verification triggered by the tenant
 * setup page "Setup Checklist" or after the admin saves credentials.
 *
 * Calls the Meta Graph API to verify the stored phoneNumberId + accessToken,
 * updates whatsapp.connected on the Tenant doc, and returns the result so the
 * frontend can immediately update the "Not Connected" / "Connected" badge.
 */
export async function verifyWhatsAppConnection(req, res) {
  try {
    const tenant = await Tenant.findById(req.params.id).select('+whatsapp.accessToken').lean();
    if (!tenant) return res.status(404).json({ error: 'Not found' });

    const phoneId    = tenant.whatsapp?.phoneNumberId;
    // [FIX-SHARED-APP] Use per-tenant token if saved, otherwise global system-user token.
    const token      = tenant.whatsapp?.accessToken || process.env.META_WHATSAPP_TOKEN;
    const apiVersion = tenant.whatsapp?.apiVersion || process.env.META_API_VERSION || 'v21.0';

    if (!phoneId) {
      return res.status(422).json({
        connected: false,
        error: 'Missing phoneNumberId — get it from Meta Developer Console → WhatsApp → API Setup and save it via the admin panel.',
      });
    }

    if (!token) {
      return res.status(422).json({
        connected: false,
        error: 'No access token available. Set META_WHATSAPP_TOKEN in your Railway environment variables (your Meta system-user permanent token).',
      });
    }

    // Reject obviously fake SIM_ phone IDs created by the old bug
    if (!/^\d{10,20}$/.test(phoneId.trim())) {
      await Tenant.findByIdAndUpdate(req.params.id, { $set: { 'whatsapp.connected': false } });
      return res.status(422).json({
        connected: false,
        error: `phoneNumberId "${phoneId}" is not a valid Meta numeric phone number ID. ` +
               'Get the correct value from Meta Developer Console → WhatsApp → API Setup.',
      });
    }

    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp  = await fetch(
        `https://graph.facebook.com/${apiVersion}/${phoneId}?fields=id,display_phone_number,verified_name,code_verification_status`,
        { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal },
      );
      clearTimeout(timer);

      const connected = resp.ok;
      let metaData = null;
      if (resp.ok) {
        metaData = await resp.json().catch(() => null);
      } else {
        const errText = await resp.text().catch(() => '');
        logger.warn('[Tenant] WhatsApp verify — Meta rejected credentials', {
          tenantId: tenant._id, status: resp.status, err: errText.slice(0, 300),
        });
      }

      await Tenant.findByIdAndUpdate(req.params.id, { $set: { 'whatsapp.connected': connected } });
      logger.info('[Tenant] verifyWhatsAppConnection', { tenantId: tenant._id, connected });

      return res.json({
        connected,
        phoneNumber: metaData?.display_phone_number || null,
        verifiedName: metaData?.verified_name || null,
        ...(connected ? {} : { error: `Meta API returned HTTP ${resp.status} — check phoneNumberId and accessToken.` }),
      });
    } catch (fetchErr) {
      await Tenant.findByIdAndUpdate(req.params.id, { $set: { 'whatsapp.connected': false } });
      return res.status(502).json({ connected: false, error: `Network error contacting Meta: ${fetchErr.message}` });
    }
  } catch (err) {
    logger.error('[Tenant] verifyWhatsAppConnection failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}
