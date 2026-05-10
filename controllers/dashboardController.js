/**
 * controllers/dashboardController.js — Dreamline Sales Bot v6.0
 *
 * Client self-service dashboard API.
 * All routes require x-api-key (tenant auth).
 *
 * GET  /dashboard              → overview summary
 * GET  /dashboard/profile      → tenant profile
 * PUT  /dashboard/profile      → update name/email/adminPhone
 * GET  /dashboard/bot          → business config
 * PUT  /dashboard/bot          → update menu/hours/faq/messages
 * POST /dashboard/bot/menu     → add a single menu item
 * DELETE /dashboard/bot/menu/:itemId → remove a menu item
 * PUT  /dashboard/bot/hours    → update business hours
 * POST /dashboard/bot/faq      → add FAQ entry
 * DELETE /dashboard/bot/faq/:faqId → remove FAQ entry
 * GET  /dashboard/stats        → orders/bookings counts
 * POST /dashboard/rotate-key   → generate new API key
 */

import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import logger         from '../config/logger.js';
import crypto         from 'crypto';

// ─── Overview ─────────────────────────────────────────────────────────────────
export const getOverview = async (req, res) => {
  try {
    const tenant      = req.tenant;
    const phoneId     = tenant.whatsapp?.phoneNumberId;
    const business    = phoneId
      ? await BusinessConfig.findOne({ phoneNumberId: phoneId }).lean()
      : null;

    const now         = new Date();
    const monthStart  = new Date(now.getFullYear(), now.getMonth(), 1);

    const tenantId = tenant._id;
    const [orderCount, bookingCount] = await Promise.all([
      Order.countDocuments({ tenantId, createdAt: { $gte: monthStart } }),
      Booking.countDocuments({ tenantId, createdAt: { $gte: monthStart } }),
    ]);

    const setupSteps = {
      accountCreated:    true,
      botConfigured:     !!(business?.name && business?.adminPhone),
      menuAdded:         Array.isArray(business?.menu) && business.menu.length > 0,
      whatsappConnected: tenant.whatsapp?.connected === true,
      hoursConfigured:   business?.hours?.enabled === true,
      faqAdded:          Array.isArray(business?.faq) && business.faq.length > 0,
    };

    const setupScore = Math.round(
      (Object.values(setupSteps).filter(Boolean).length / Object.keys(setupSteps).length) * 100
    );

    res.json({
      success: true,
      data: {
        tenant: {
          name:   tenant.name,
          email:  tenant.email,
          plan:   tenant.plan,
          status: tenant.status,
        },
        bot: {
          name:        business?.name || null,
          mode:        business?.businessMode || null,
          botEnabled:  business?.botEnabled !== false,
          menuItems:   business?.menu?.length || 0,
          faqEntries:  business?.faq?.length || 0,
        },
        whatsapp: {
          connected:     tenant.whatsapp?.connected === true,
          phone:         tenant.whatsapp?.phone || null,
          phoneNumberId: tenant.whatsapp?.phoneNumberId || null,
        },
        thisMonth: {
          orders:   orderCount,
          bookings: bookingCount,
        },
        setup: {
          score: setupScore,
          steps: setupSteps,
          complete: setupScore === 100,
        },
      },
    });
  } catch (err) {
    logger.error('[Dashboard] getOverview error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Profile ──────────────────────────────────────────────────────────────────
export const getProfile = async (req, res) => {
  try {
    const tenant = req.tenant;
    res.json({
      success: true,
      data: {
        tenantId:   tenant._id,
        name:       tenant.name,
        email:      tenant.email,
        plan:       tenant.plan,
        status:     tenant.status,
        adminPhone: tenant.adminPhone,
        whatsapp: {
          connected:     tenant.whatsapp?.connected,
          phone:         tenant.whatsapp?.phone,
          phoneNumberId: tenant.whatsapp?.phoneNumberId,
          apiVersion:    tenant.whatsapp?.apiVersion,
          tokenUpdatedAt: tenant.whatsapp?.tokenUpdatedAt,
        },
        limits: tenant.limits,
        usage:  tenant.usage,
        createdAt: tenant.createdAt,
      },
    });
  } catch (err) {
    logger.error('[Dashboard] getProfile error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const tenant = req.tenant;
    const { name, adminPhone } = req.body;

    // Email change intentionally NOT allowed — it's a unique identifier.
    // If needed, add a verification flow.
    const allowed = {};
    if (name?.trim())       allowed.name       = name.trim();
    if (adminPhone?.trim()) allowed.adminPhone = adminPhone.trim();

    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least one of: name, adminPhone',
      });
    }

    const updated = await Tenant.findByIdAndUpdate(
      tenant._id,
      { $set: allowed },
      { new: true, runValidators: true }
    );

    res.json({ success: true, message: 'Profile updated.', data: { name: updated.name, adminPhone: updated.adminPhone } });
  } catch (err) {
    logger.error('[Dashboard] updateProfile error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Helper: resolve BusinessConfig by phoneId first, tenantId fallback ───────
// PENDING tenants (WhatsApp not yet connected) have no phoneId, but they may
// have already completed onboarding step 2 (POST /register/business), which
// creates a BusinessConfig scoped by tenantId. This helper finds it either way.
async function resolveBusiness(tenant) {
  const phoneId = tenant.whatsapp?.phoneNumberId;
  if (phoneId) {
    const biz = await BusinessConfig.findOne({ phoneNumberId: phoneId });
    if (biz) return biz;
  }
  // Fallback: PENDING tenant with step-2 config but no WhatsApp yet
  return BusinessConfig.findOne({ tenantId: tenant._id });
}

// ─── Bot config ───────────────────────────────────────────────────────────────
export const getBotConfig = async (req, res) => {
  try {
    const business = await resolveBusiness(req.tenant);

    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'No bot configuration found. Complete onboarding step 2 first.',
        hint:    'POST /register/business',
      });
    }

    res.json({ success: true, data: business });
  } catch (err) {
    logger.error('[Dashboard] getBotConfig error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateBotConfig = async (req, res) => {
  try {
    const tenant  = req.tenant;
    const phoneId = tenant.whatsapp?.phoneNumberId;

    const ALLOWED = [
      'name', 'description', 'botEnabled', 'adminPhone', 'tone',
      'customMessages', 'settings', 'payment', 'nlp',
    ];

    const patch = {};
    for (const field of ALLOWED) {
      if (req.body[field] !== undefined) patch[field] = req.body[field];
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, message: 'No updatable fields provided.' });
    }

    // Find by phoneId first, then fall back to tenantId (PENDING tenants)
    const filter = phoneId
      ? { phoneNumberId: phoneId }
      : { tenantId: tenant._id };

    const updated = await BusinessConfig.findOneAndUpdate(
      filter,
      { $set: patch },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Bot config not found. Complete onboarding step 2 first.',
        hint: 'POST /register/business',
      });
    }

    res.json({ success: true, message: 'Bot configuration updated.', data: updated });
  } catch (err) {
    logger.error('[Dashboard] updateBotConfig error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Menu management ──────────────────────────────────────────────────────────
export const addMenuItem = async (req, res) => {
  try {
    const { name, price, description, available } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'Menu item name is required.' });
    }

    const business = await resolveBusiness(req.tenant);
    if (!business) return res.status(404).json({ success: false, message: 'Bot config not found. Complete onboarding step 2 first.' });

    // Check plan limits
    const maxItems = req.tenant.limits?.maxMenuItems || 10;
    if (business.menu.length >= maxItems) {
      return res.status(403).json({
        success: false,
        message: `Menu limit reached (${maxItems} items). Upgrade your plan to add more.`,
        currentPlan: req.tenant.plan,
      });
    }

    business.menu.push({
      name:        name.trim(),
      price:       Number(price) || 0,
      description: description?.trim() || '',
      available:   available !== false,
    });

    await business.save();

    res.status(201).json({
      success: true,
      message: `"${name.trim()}" added to menu.`,
      data: { menu: business.menu },
    });
  } catch (err) {
    logger.error('[Dashboard] addMenuItem error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const removeMenuItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    const business   = await resolveBusiness(req.tenant);
    if (!business) return res.status(404).json({ success: false, message: 'Bot config not found.' });

    const before = business.menu.length;
    business.menu = business.menu.filter(i => String(i._id) !== itemId);

    if (business.menu.length === before) {
      return res.status(404).json({ success: false, message: 'Menu item not found.' });
    }

    await business.save();
    res.json({ success: true, message: 'Menu item removed.', data: { menu: business.menu } });
  } catch (err) {
    logger.error('[Dashboard] removeMenuItem error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateMenuItems = async (req, res) => {
  try {
    const tenant  = req.tenant;
    const { menu } = req.body;
    if (!Array.isArray(menu)) {
      return res.status(400).json({ success: false, message: '"menu" must be an array.' });
    }

    const maxItems = tenant.limits?.maxMenuItems || 10;
    if (menu.length > maxItems) {
      return res.status(403).json({
        success: false,
        message: `Menu limit is ${maxItems} items for your plan. Upgrade to add more.`,
      });
    }

    const phoneId = tenant.whatsapp?.phoneNumberId;
    const filter  = phoneId ? { phoneNumberId: phoneId } : { tenantId: tenant._id };

    const updated = await BusinessConfig.findOneAndUpdate(
      filter,
      { $set: { menu } },
      { new: true, runValidators: true }
    );

    if (!updated) return res.status(404).json({ success: false, message: 'Bot config not found. Complete onboarding step 2 first.' });

    res.json({ success: true, message: 'Menu updated.', data: { menu: updated.menu } });
  } catch (err) {
    logger.error('[Dashboard] updateMenuItems error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Hours management ─────────────────────────────────────────────────────────
export const updateHours = async (req, res) => {
  try {
    const tenant  = req.tenant;
    const { enabled, open, close, timezone, days } = req.body;
    const patch = {};
    if (enabled  !== undefined) patch['hours.enabled']  = enabled;
    if (open     !== undefined) patch['hours.open']     = Number(open);
    if (close    !== undefined) patch['hours.close']    = Number(close);
    if (timezone !== undefined) patch['hours.timezone'] = timezone;
    if (days     !== undefined) patch['hours.days']     = days;

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, message: 'No hours fields provided.' });
    }

    const phoneId = tenant.whatsapp?.phoneNumberId;
    const filter  = phoneId ? { phoneNumberId: phoneId } : { tenantId: tenant._id };

    const updated = await BusinessConfig.findOneAndUpdate(
      filter,
      { $set: patch },
      { new: true, runValidators: true }
    );

    if (!updated) return res.status(404).json({ success: false, message: 'Bot config not found. Complete onboarding step 2 first.' });

    res.json({ success: true, message: 'Business hours updated.', data: { hours: updated.hours } });
  } catch (err) {
    logger.error('[Dashboard] updateHours error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── FAQ management ───────────────────────────────────────────────────────────
export const addFaqEntry = async (req, res) => {
  try {
    const { trigger, reply } = req.body;
    if (!trigger?.trim() || !reply?.trim()) {
      return res.status(400).json({ success: false, message: 'Both "trigger" and "reply" are required.' });
    }

    const business = await resolveBusiness(req.tenant);
    if (!business) return res.status(404).json({ success: false, message: 'Bot config not found. Complete onboarding step 2 first.' });

    business.faq.push({ trigger: trigger.trim(), reply: reply.trim() });
    await business.save();

    res.status(201).json({
      success: true,
      message: 'FAQ entry added.',
      data: { faq: business.faq },
    });
  } catch (err) {
    logger.error('[Dashboard] addFaqEntry error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const removeFaqEntry = async (req, res) => {
  try {
    const { faqId }  = req.params;
    const business   = await resolveBusiness(req.tenant);
    if (!business) return res.status(404).json({ success: false, message: 'Bot config not found.' });

    const before = business.faq.length;
    business.faq = business.faq.filter(f => String(f._id) !== faqId);

    if (business.faq.length === before) {
      return res.status(404).json({ success: false, message: 'FAQ entry not found.' });
    }

    await business.save();
    res.json({ success: true, message: 'FAQ entry removed.', data: { faq: business.faq } });
  } catch (err) {
    logger.error('[Dashboard] removeFaqEntry error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Stats ────────────────────────────────────────────────────────────────────
export const getStats = async (req, res) => {
  try {
    const tenantId = req.tenant._id;
    if (!req.tenant.whatsapp?.phoneNumberId) {
      return res.json({ success: true, data: { orders: { total:0, month:0, week:0, pending:0 }, bookings: { total:0, month:0, week:0, pending:0 }, revenue: { total:0, month:0, week:0 } } });
    }

    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekStart  = new Date(now - 7 * 24 * 60 * 60 * 1000);

    // Revenue aggregation helper
    const sumRevenue = async (matchExtra = {}) => {
      const result = await Order.aggregate([
        { $match: { tenantId, paymentStatus: 'paid', ...matchExtra } },
        { $group: { _id: null, total: { $sum: '$totalPrice' } } },
      ]);
      return result[0]?.total ?? 0;
    };

    const [
      ordersTotal, ordersMonth, ordersWeek,
      bookingsTotal, bookingsMonth, bookingsWeek,
      pendingOrders, pendingBookings,
      revenueTotal, revenueMonth, revenueWeek,
    ] = await Promise.all([
      Order.countDocuments({ tenantId }),
      Order.countDocuments({ tenantId, createdAt: { $gte: monthStart } }),
      Order.countDocuments({ tenantId, createdAt: { $gte: weekStart } }),
      Booking.countDocuments({ tenantId }),
      Booking.countDocuments({ tenantId, createdAt: { $gte: monthStart } }),
      Booking.countDocuments({ tenantId, createdAt: { $gte: weekStart } }),
      Order.countDocuments({ tenantId, status: 'pending' }),
      Booking.countDocuments({ tenantId, status: 'pending' }),
      sumRevenue(),
      sumRevenue({ createdAt: { $gte: monthStart } }),
      sumRevenue({ createdAt: { $gte: weekStart } }),
    ]);

    res.json({
      success: true,
      data: {
        orders: {
          total:   ordersTotal,
          month:   ordersMonth,
          week:    ordersWeek,
          pending: pendingOrders,
        },
        bookings: {
          total:   bookingsTotal,
          month:   bookingsMonth,
          week:    bookingsWeek,
          pending: pendingBookings,
        },
        revenue: {
          total: revenueTotal,
          month: revenueMonth,
          week:  revenueWeek,
        },
      },
    });
  } catch (err) {
    logger.error('[Dashboard] getStats error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Rotate API key ───────────────────────────────────────────────────────────
export const rotateApiKey = async (req, res) => {
  try {
    const newKey  = crypto.randomBytes(32).toString('hex');
    // [FIX] findByIdAndUpdate bypasses Mongoose middleware, so the pre-validate
    // hook that keeps apiKeyHash in sync never fires. Hash the new key here and
    // write both fields atomically so authMiddleware's hash-first lookup works
    // immediately after rotation — without this the new key fails auth until
    // the plaintext fallback path is hit (which may be disabled via APIKEY_MIGRATION_DONE).
    const newHash = crypto.createHash('sha256').update(newKey).digest('hex');

    await Tenant.findByIdAndUpdate(req.tenant._id, { $set: { apiKey: newKey, apiKeyHash: newHash } });

    res.json({
      success: true,
      message: 'API key rotated. Update your x-api-key header with the new key immediately — your old key is now invalid.',
      data: { apiKey: newKey },
    });
  } catch (err) {
    logger.error('[Dashboard] rotateApiKey error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
