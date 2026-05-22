/**
 * controllers/tenantController.js — WhatSalesAgent2
 *
 * FIXES:
 * [FIX-G] updateTenantStatus accepted ACTIVE/SUSPENDED/INACTIVE but not PENDING.
 *         Admins need PENDING to un-suspend a tenant back to an onboarding state.
 *         PENDING added to the valid status list.
 * [FIX-G] All handlers now wrapped in try/catch — unhandled promise rejections
 *         were crashing the process instead of returning a clean 500 JSON response.
 */
import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import crypto         from 'crypto';

export async function createTenant(req, res) {
  try {
    const {
      name, businessMode = 'RESTAURANT', adminPhone,
      whatsapp = {}, menuItems = [], services = [], payment = {},
      leadCapture = {}, faq = [], description = '',
    } = req.body;

    if (!name) return res.status(400).json({ error: 'name required' });

    const rawKey = crypto.randomBytes(16).toString('hex');
    const apiKey = 'wsa_' + rawKey;

    const tenant = await Tenant.create({
      name, adminPhone, status: 'ACTIVE',
      whatsapp: {
        phoneNumberId: whatsapp.phoneNumberId || `SIM_${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        accessToken:   whatsapp.accessToken   || null,
        apiVersion:    whatsapp.apiVersion    || 'v21.0',
      },
      apiKey,
    });

    const business = await BusinessConfig.create({
      tenantId:     String(tenant._id),
      name,         businessMode, adminPhone,
      description,  menuItems,    services,
      payment, leadCapture, faq,
      addOns: [],
    });

    res.status(201).json({
      tenant:   { _id: tenant._id, name, status: 'ACTIVE', apiKey },
      business: { _id: business._id, businessMode, name },
      next:     `Use x-api-key: ${apiKey} for business / dashboard routes`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function listTenants(_req, res) {
  try {
    const tenants = await Tenant.find().select('name status createdAt whatsapp.phoneNumberId').lean();
    res.json({ tenants, count: tenants.length });
  } catch (err) {
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
    res.status(500).json({ error: err.message });
  }
}

export async function updateTenantStatus(req, res) {
  try {
    const { status } = req.body;
    // [FIX-G] Added PENDING — lets admins revert a suspended tenant to onboarding state
    if (!['ACTIVE', 'SUSPENDED', 'INACTIVE', 'PENDING'].includes(status))
      return res.status(400).json({ error: 'Invalid status. Must be one of: ACTIVE, PENDING, SUSPENDED, INACTIVE' });

    const tenant = await Tenant.findByIdAndUpdate(req.params.id, { $set: { status } }, { new: true });
    if (!tenant) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, status: tenant.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function deleteTenant(req, res) {
  try {
    await Tenant.findByIdAndDelete(req.params.id);
    await BusinessConfig.deleteOne({ tenantId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
