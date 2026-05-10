/**
 * controllers/platformController.js — Dreamline Sales Bot v6.0
 *
 * Platform-owner (super-admin) management routes.
 * All routes require SUPER_ADMIN_API_KEY.
 *
 * GET  /platform/tenants           → list all tenants with summary
 * GET  /platform/tenants/:id       → single tenant detail
 * PUT  /platform/tenants/:id/plan  → change a tenant's plan
 * PUT  /platform/tenants/:id/status → suspend or activate a tenant
 * GET  /platform/stats             → platform-wide stats
 * POST /platform/reset-usage       → reset monthly usage counters
 * POST /platform/tenants/:id/notify → send WhatsApp message to a tenant's admin
 */

import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import { dispatch }   from '../services/messageService.js';
import logger         from '../config/logger.js';

const VALID_PLANS    = ['FREE', 'STARTER', 'PRO', 'ENTERPRISE'];
const VALID_STATUSES = ['ACTIVE', 'SUSPENDED', 'PENDING'];

// Plan limits — adjust to match your pricing
const PLAN_LIMITS = {
  FREE:       { messagesPerMonth: 500,   maxMenuItems: 10,  maxAdmins: 1 },
  STARTER:    { messagesPerMonth: 2000,  maxMenuItems: 30,  maxAdmins: 2 },
  PRO:        { messagesPerMonth: 10000, maxMenuItems: 100, maxAdmins: 5 },
  ENTERPRISE: { messagesPerMonth: 99999, maxMenuItems: 999, maxAdmins: 20 },
};

// ─── List all tenants ─────────────────────────────────────────────────────────
export const listTenants = async (req, res) => {
  try {
    const {
      status, plan,
      page  = 1,
      limit = 20,
      search,
    } = req.query;

    const query = {};
    if (status) query.status = status.toUpperCase();
    if (plan)   query.plan   = plan.toUpperCase();
    if (search) {
      query.$or = [
        { name:  { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Tenant.countDocuments(query);

    const tenants = await Tenant.find(query)
      .select('-whatsapp.accessToken -apiKey')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    res.json({
      success: true,
      data: {
        tenants,
        pagination: {
          total,
          page:  Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (err) {
    logger.error('[Platform] listTenants error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Single tenant detail ─────────────────────────────────────────────────────
export const getTenantDetail = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id)
      .select('-whatsapp.accessToken -apiKey')
      .lean();

    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found.' });
    }

    const phoneId  = tenant.whatsapp?.phoneNumberId;
    const business = phoneId
      ? await BusinessConfig.findOne({ phoneNumberId: phoneId })
          .select('name businessMode botEnabled menu faq hours payment adminPhone description')
          .lean()
      : null;

    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const tenantId = tenant._id;
    const [ordersMonth, bookingsMonth] = await Promise.all([
      Order.countDocuments({ tenantId, createdAt: { $gte: monthStart } }),
      Booking.countDocuments({ tenantId, createdAt: { $gte: monthStart } }),
    ]);

    res.json({
      success: true,
      data: {
        tenant,
        business,
        thisMonth: { orders: ordersMonth, bookings: bookingsMonth },
      },
    });
  } catch (err) {
    logger.error('[Platform] getTenantDetail error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Change plan ──────────────────────────────────────────────────────────────
export const changePlan = async (req, res) => {
  try {
    const { plan, note } = req.body;

    if (!plan || !VALID_PLANS.includes(plan.toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: `Invalid plan. Valid options: ${VALID_PLANS.join(', ')}`,
      });
    }

    const resolvedPlan = plan.toUpperCase();
    const limits       = PLAN_LIMITS[resolvedPlan];

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          plan: resolvedPlan,
          limits,
          ...(note ? { notes: note } : {}),
        },
      },
      { new: true, select: '-whatsapp.accessToken -apiKey' }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Tenant not found.' });
    }

    logger.info('[Platform] Plan changed', { tenantId: req.params.id, plan: resolvedPlan });

    res.json({
      success: true,
      message: `Plan updated to ${resolvedPlan}.`,
      data: { plan: updated.plan, limits: updated.limits },
    });
  } catch (err) {
    logger.error('[Platform] changePlan error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Change status (suspend / activate) ──────────────────────────────────────
export const changeStatus = async (req, res) => {
  try {
    const { status, reason } = req.body;

    if (!status || !VALID_STATUSES.includes(status.toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Valid options: ${VALID_STATUSES.join(', ')}`,
      });
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: status.toUpperCase(),
          ...(reason ? { notes: reason } : {}),
        },
      },
      { new: true, select: '-whatsapp.accessToken -apiKey' }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Tenant not found.' });
    }

    logger.info('[Platform] Status changed', { tenantId: req.params.id, status: status.toUpperCase() });

    res.json({
      success: true,
      message: `Tenant ${status.toUpperCase() === 'SUSPENDED' ? 'suspended' : 'activated'}.`,
      data: { status: updated.status },
    });
  } catch (err) {
    logger.error('[Platform] changeStatus error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Platform-wide stats ──────────────────────────────────────────────────────
export const getPlatformStats = async (req, res) => {
  try {
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekStart  = new Date(now - 7 * 24 * 60 * 60 * 1000);

    // Platform-wide revenue aggregation (paid orders only)
    const revenueAgg = (matchExtra = {}) =>
      Order.aggregate([
        { $match: { paymentStatus: 'paid', ...matchExtra } },
        { $group: { _id: null, total: { $sum: '$totalPrice' } } },
      ]).then(r => r[0]?.total ?? 0);

    const [
      totalTenants,
      activeTenants,
      pendingTenants,
      suspendedTenants,
      planBreakdown,
      ordersThisMonth,
      bookingsThisMonth,
      newTenantsWeek,
      newTenantsMonth,
      revenueTotal,
      revenueThisMonth,
    ] = await Promise.all([
      Tenant.countDocuments(),
      Tenant.countDocuments({ status: 'ACTIVE' }),
      Tenant.countDocuments({ status: 'PENDING' }),
      Tenant.countDocuments({ status: 'SUSPENDED' }),
      Tenant.aggregate([
        { $group: { _id: '$plan', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      Order.countDocuments({ createdAt: { $gte: monthStart } }),
      Booking.countDocuments({ createdAt: { $gte: monthStart } }),
      Tenant.countDocuments({ createdAt: { $gte: weekStart } }),
      Tenant.countDocuments({ createdAt: { $gte: monthStart } }),
      revenueAgg(),
      revenueAgg({ createdAt: { $gte: monthStart } }),
    ]);

    res.json({
      success: true,
      data: {
        tenants: {
          total:     totalTenants,
          active:    activeTenants,
          pending:   pendingTenants,
          suspended: suspendedTenants,
          byPlan:    Object.fromEntries(planBreakdown.map(p => [p._id, p.count])),
          newThisWeek:  newTenantsWeek,
          newThisMonth: newTenantsMonth,
        },
        activity: {
          ordersThisMonth,
          bookingsThisMonth,
        },
        // Platform-wide revenue (sum of all paid orders across all tenants)
        revenue: {
          total:        revenueTotal,
          thisMonth:    revenueThisMonth,
        },
        generatedAt: now.toISOString(),
      },
    });
  } catch (err) {
    logger.error('[Platform] getPlatformStats error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Reset usage counters (monthly cron) ─────────────────────────────────────
export const resetUsageCounters = async (req, res) => {
  try {
    const result = await Tenant.updateMany(
      {},
      {
        $set: {
          'usage.messagesThisMonth': 0,
          'usage.resetDate':         new Date(),
        },
      }
    );

    logger.info('[Platform] Usage counters reset', { modified: result.modifiedCount });

    res.json({
      success: true,
      message: `Usage counters reset for ${result.modifiedCount} tenants.`,
    });
  } catch (err) {
    logger.error('[Platform] resetUsageCounters error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Notify tenant admin via WhatsApp ────────────────────────────────────────
export const notifyTenant = async (req, res) => {
  try {
    const { message } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ success: false, message: 'message body is required.' });
    }

    const tenant = await Tenant.findById(req.params.id).lean();
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found.' });
    }

    if (!tenant.whatsapp?.connected || !tenant.whatsapp?.phoneNumberId) {
      return res.status(400).json({
        success: false,
        message: 'Tenant has no connected WhatsApp number — cannot send notification.',
      });
    }

    const adminPhone = tenant.adminPhone;
    if (!adminPhone) {
      return res.status(400).json({
        success: false,
        message: 'Tenant has no adminPhone configured — cannot send notification.',
      });
    }

    await dispatch(adminPhone, { type: 'text', body: message.trim() }, tenant);

    logger.info('[Platform] Tenant notified', { tenantId: req.params.id, adminPhone });

    res.json({
      success: true,
      message: `Notification sent to ${adminPhone}.`,
    });
  } catch (err) {
    logger.error('[Platform] notifyTenant error', { err: err.message });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
