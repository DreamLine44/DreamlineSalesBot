/**
 * controllers/whatsappOnboardingController.js
 *
 * Handles all HTTP request/response logic for the WhatsApp onboarding system.
 * Delegates all business logic to whatsappOnboardingService.js.
 *
 * Controller map:
 *
 * TENANT-FACING
 *   submitConnectionRequest()      POST /api/whatsapp/request
 *   getTenantRequestStatus()       GET  /api/whatsapp/request/status
 *
 * ADMIN-FACING (super-admin key required)
 *   getAllConnectionRequests()     GET  /admin/whatsapp/requests
 *   getConnectionRequestById()     GET  /admin/whatsapp/requests/:id
 *   updateConnectionRequestStatus() PATCH /admin/whatsapp/requests/:id/status
 *   saveTenantWhatsAppCredentials() POST /admin/whatsapp/connect/:tenantId
 *   testTenantWhatsAppConnection()  POST /admin/whatsapp/test/:tenantId
 *
 * ISOLATION: This controller does NOT import or reference any existing bot
 * controller, flow engine, session service, or webhook handler.
 */
import mongoose from 'mongoose';
import WhatsAppConnectionRequest from '../models/WhatsAppConnectionRequest.js';
import Tenant from '../models/Tenant.js';
import {
  saveCredentials,
  verifyCredentials,
  markConnected,
  updateStatus,
} from '../services/whatsappOnboardingService.js';
import { notifyAdminNewRequest } from '../services/whatsappNotificationService.js';
import logger from '../config/logger.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// ── Tenant-facing controllers ─────────────────────────────────────────────────

/**
 * submitConnectionRequest
 *
 * Tenant submits a new WhatsApp connection request.
 * Enforces: one active (non-rejected) request per tenant.
 *
 * POST /api/whatsapp/request
 * Auth: requireApiKey (tenant key)
 *
 * Body: { businessName, businessCategory, whatsappNumber,
 *         contactPerson, contactEmail, notes? }
 */
export async function submitConnectionRequest(req, res, next) {
  try {
    const tenantId = req.tenantId || (req.tenant && String(req.tenant._id));
    if (!tenantId) {
      return res.status(401).json({ error: 'Tenant identity could not be resolved from API key' });
    }

    // Enforce one active request per tenant
    const existing = await WhatsAppConnectionRequest.findOne({
      tenantId,
      status: { $nin: ['rejected'] },
    });

    if (existing) {
      return res.status(409).json({
        error:   'A connection request already exists for this tenant',
        status:  existing.status,
        requestId: String(existing._id),
      });
    }

    const { businessName, businessCategory, whatsappNumber, contactPerson, contactEmail, notes } = req.body;

    const request = await WhatsAppConnectionRequest.create({
      tenantId,
      businessName:     businessName.trim(),
      businessCategory: businessCategory.trim(),
      whatsappNumber:   whatsappNumber.trim(),
      contactPerson:    contactPerson.trim(),
      contactEmail:     contactEmail.trim().toLowerCase(),
      notes:            (notes || '').trim(),
      status:           'pending',
    });

    logger.info('[OnboardingCtrl] New connection request created', {
      requestId: String(request._id),
      tenantId,
    });

    // Notify admin (fire-and-forget)
    notifyAdminNewRequest(request).catch(() => {});

    return res.status(201).json({
      message:   'Connection request submitted successfully. Our team will contact you shortly.',
      requestId: String(request._id),
      status:    request.status,
    });

  } catch (err) {
    next(err);
  }
}

/**
 * getTenantRequestStatus
 *
 * Tenant polls the status of their own connection request.
 *
 * GET /api/whatsapp/request/status
 * Auth: requireApiKey (tenant key)
 */
export async function getTenantRequestStatus(req, res, next) {
  try {
    const tenantId = req.tenantId || (req.tenant && String(req.tenant._id));
    if (!tenantId) {
      return res.status(401).json({ error: 'Tenant identity could not be resolved' });
    }

    const request = await WhatsAppConnectionRequest
      .findOne({ tenantId })
      .sort({ createdAt: -1 })
      .select('-adminNotes') // never expose admin notes to tenant
      .lean();

    if (!request) {
      return res.status(404).json({ error: 'No connection request found for this tenant' });
    }

    // Also surface the tenant's connection flag for convenience
    const tenant = await Tenant.findById(tenantId)
      .select('whatsapp.connected whatsapp.connectedAt status')
      .lean();

    return res.json({
      request: {
        id:               String(request._id),
        businessName:     request.businessName,
        whatsappNumber:   request.whatsappNumber,
        status:           request.status,
        submittedAt:      request.createdAt,
        lastUpdated:      request.updatedAt,
      },
      whatsappConnected: tenant?.whatsapp?.connected ?? false,
      connectedAt:       tenant?.whatsapp?.connectedAt ?? null,
    });

  } catch (err) {
    next(err);
  }
}

// ── Admin-facing controllers ──────────────────────────────────────────────────

/**
 * getAllConnectionRequests
 *
 * Super-admin lists all connection requests with optional filters.
 *
 * GET /admin/whatsapp/requests
 * Query: ?status=pending&page=1&limit=20
 * Auth: requireSuperAdminKey
 */
export async function getAllConnectionRequests(req, res, next) {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const filter = {};
    if (status) filter.status = status;

    const safeLimit = Math.min(Number(limit) || 20, 100);
    const safePage  = Math.max(Number(page)  || 1,  1);
    const skip      = (safePage - 1) * safeLimit;

    const [requests, total] = await Promise.all([
      WhatsAppConnectionRequest
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .populate('tenantId', 'name status businessMode')
        .lean(),
      WhatsAppConnectionRequest.countDocuments(filter),
    ]);

    return res.json({
      requests,
      total,
      page:  safePage,
      pages: Math.ceil(total / safeLimit),
      limit: safeLimit,
    });

  } catch (err) {
    next(err);
  }
}

/**
 * getConnectionRequestById
 *
 * Super-admin views a single connection request (full detail including adminNotes).
 *
 * GET /admin/whatsapp/requests/:id
 * Auth: requireSuperAdminKey
 */
export async function getConnectionRequestById(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid request ID' });
    }

    const request = await WhatsAppConnectionRequest
      .findById(id)
      .populate('tenantId', 'name email status businessMode whatsapp.connected')
      .lean();

    if (!request) return res.status(404).json({ error: 'Connection request not found' });

    return res.json({ request });

  } catch (err) {
    next(err);
  }
}

/**
 * updateConnectionRequestStatus
 *
 * Super-admin updates status and optional admin notes on a request.
 *
 * PATCH /admin/whatsapp/requests/:id/status
 * Body: { status, adminNotes? }
 * Auth: requireSuperAdminKey
 */
export async function updateConnectionRequestStatus(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid request ID' });
    }

    const { status, adminNotes } = req.body;

    const result = await updateStatus(id, status, {
      adminNotes: adminNotes || '',
      reviewedBy: 'super-admin', // Can be extended to store admin email/user if needed
    });

    if (!result.ok) {
      return res.status(404).json({ error: result.error });
    }

    logger.info('[OnboardingCtrl] Request status updated', {
      requestId: id,
      status,
    });

    return res.json({
      message: 'Status updated successfully',
      request: result.request,
    });

  } catch (err) {
    next(err);
  }
}

/**
 * saveTenantWhatsAppCredentials
 *
 * Super-admin saves WhatsApp credentials for a tenant.
 * Does NOT immediately mark the tenant as connected — use testTenantWhatsAppConnection
 * or call this endpoint with verifyFirst=true to auto-verify.
 *
 * POST /admin/whatsapp/connect/:tenantId
 * Body: { phoneNumberId, wabaId, accessToken, verifyToken, apiVersion?, verifyFirst? }
 * Auth: requireSuperAdminKey
 */
export async function saveTenantWhatsAppCredentials(req, res, next) {
  try {
    const { tenantId } = req.params;
    if (!isValidObjectId(tenantId)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }

    const {
      phoneNumberId,
      wabaId,
      accessToken,
      verifyToken,
      apiVersion,
      verifyFirst = false,
    } = req.body;

    // Optional: verify before saving
    let verifyResult = null;
    if (verifyFirst) {
      verifyResult = await verifyCredentials({ phoneNumberId, wabaId, accessToken, apiVersion });
      if (verifyResult.status !== 'CONNECTED') {
        return res.status(422).json({
          error:          'Credential verification failed — credentials not saved',
          verifyStatus:   verifyResult.status,
          verifyMessage:  verifyResult.message,
          details:        verifyResult.details,
        });
      }
    }

    const saveResult = await saveCredentials(tenantId, {
      phoneNumberId,
      wabaId,
      accessToken,
      verifyToken,
      apiVersion,
    });

    if (!saveResult.ok) {
      return res.status(404).json({ error: saveResult.error });
    }

    // If credentials were verified, also mark tenant connected
    if (verifyFirst && verifyResult?.status === 'CONNECTED') {
      await markConnected(tenantId);

      // Update the most recent pending request to "connected" (best-effort)
      const latestRequest = await WhatsAppConnectionRequest.findOne({
        tenantId,
        status: { $nin: ['connected', 'rejected'] },
      }).sort({ createdAt: -1 });

      if (latestRequest) {
        await updateStatus(String(latestRequest._id), 'connected', {
          adminNotes: 'Credentials saved and verified automatically',
          reviewedBy: 'super-admin',
        });
      }
    }

    return res.status(200).json({
      message:       verifyFirst
        ? 'Credentials saved and verified. Tenant is now CONNECTED.'
        : 'Credentials saved. Run POST /admin/whatsapp/test/:tenantId to verify.',
      tenantId,
      phoneNumberId,
      verified:      verifyFirst ? true : false,
      verifyDetails: verifyResult?.details || null,
    });

  } catch (err) {
    next(err);
  }
}

/**
 * testTenantWhatsAppConnection
 *
 * Verifies a tenant's stored credentials against the Meta Graph API.
 * On success, marks the tenant as CONNECTED and transitions the
 * latest non-rejected request to "connected".
 *
 * POST /admin/whatsapp/test/:tenantId
 * Auth: requireSuperAdminKey
 *
 * Returns: { verifyStatus: 'CONNECTED'|'INVALID_TOKEN'|'INVALID_PHONE_NUMBER'|'META_ERROR', ... }
 */
export async function testTenantWhatsAppConnection(req, res, next) {
  try {
    const { tenantId } = req.params;
    if (!isValidObjectId(tenantId)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }

    // Load tenant credentials
    const tenant = await Tenant.findById(tenantId)
      .select('whatsapp name status')
      .lean();

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { phoneNumberId, wabaId, accessToken, apiVersion } = tenant.whatsapp || {};

    if (!phoneNumberId || !accessToken) {
      return res.status(422).json({
        error:        'No WhatsApp credentials found for this tenant. Save credentials first.',
        verifyStatus: 'META_ERROR',
      });
    }

    // Verify against Meta
    const result = await verifyCredentials({ phoneNumberId, wabaId, accessToken, apiVersion });

    logger.info('[OnboardingCtrl] Credential test result', {
      tenantId,
      verifyStatus: result.status,
    });

    if (result.status === 'CONNECTED') {
      // Mark tenant connected
      const connResult = await markConnected(tenantId);
      if (!connResult.ok) {
        logger.warn('[OnboardingCtrl] markConnected failed after successful verify', { tenantId });
      }

      // Advance the latest request to "connected" (best-effort)
      const latestRequest = await WhatsAppConnectionRequest.findOne({
        tenantId,
        status: { $nin: ['connected', 'rejected'] },
      }).sort({ createdAt: -1 });

      if (latestRequest) {
        await updateStatus(String(latestRequest._id), 'connected', {
          adminNotes: `Verified via admin test on ${new Date().toISOString()}`,
          reviewedBy: 'super-admin',
        });
      }
    }

    return res.json({
      verifyStatus:  result.status,
      message:       result.message,
      details:       result.details || null,
      tenantId,
      tenantName:    tenant.name,
    });

  } catch (err) {
    next(err);
  }
}
