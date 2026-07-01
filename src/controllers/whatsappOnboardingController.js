/**
 * controllers/whatsappOnboardingController.js
 *
 * Handles all HTTP request/response logic for the WhatsApp onboarding system.
 * Delegates all business logic to whatsappOnboardingService.js.
 *
 * Controller map:
 *
 * TENANT-FACING
 *   submitConnectionRequest()        POST /api/whatsapp/request
 *   getTenantRequestStatus()         GET  /api/whatsapp/request/status
 *
 * ADMIN-FACING (super-admin key required)
 *   getAllConnectionRequests()        GET    /admin/whatsapp/requests
 *   getConnectionRequestById()        GET    /admin/whatsapp/requests/:id
 *   updateConnectionRequestStatus()  PATCH  /admin/whatsapp/requests/:id/status
 *   saveTenantWhatsAppCredentials()  POST   /admin/whatsapp/connect/:tenantId
 *   testTenantWhatsAppConnection()   POST   /admin/whatsapp/test/:tenantId
 *
 * [FIX-ONBOARD-CTL-1] saveTenantWhatsAppCredentials now also advances
 *   onboardingStep to 2 (credentials saved) via Tenant.$set when credentials
 *   are stored — consistent with what PATCH /admin/tenants/:id does.
 *   Previously onboardingStep was never updated by the onboarding path.
 *
 * [FIX-ONBOARD-CTL-2] testTenantWhatsAppConnection now decrypts the stored
 *   accessToken via decryptToken() before passing it to verifyCredentials().
 *   Previously it passed the raw (possibly enc:-prefixed) stored value, which
 *   caused Meta to reject it with a 190 "invalid token" error even when the
 *   credentials were valid.
 *
 * [FIX-ONBOARD-CTL-3] testTenantWhatsAppConnection rejects SIM_ phoneNumberId
 *   with a clear 422 error before making any Meta network call.
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
import { decryptToken } from '../controllers/tenantController.js';
import { notifyAdminNewRequest } from '../services/whatsappNotificationService.js';
import logger from '../config/logger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// ── Tenant-facing controllers ─────────────────────────────────────────────────

/**
 * submitConnectionRequest
 * POST /api/whatsapp/request
 */
export async function submitConnectionRequest(req, res, next) {
  try {
    const tenantId = req.tenantId || (req.tenant && String(req.tenant._id));
    if (!tenantId) {
      return res.status(401).json({ error: 'Tenant identity could not be resolved from API key' });
    }

    const existing = await WhatsAppConnectionRequest.findOne({
      tenantId,
      status: { $nin: ['rejected'] },
    });

    if (existing) {
      return res.status(409).json({
        error:     'A connection request already exists for this tenant',
        status:    existing.status,
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
 * GET /api/whatsapp/request/status
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
      .select('-adminNotes')
      .lean();

    if (!request) {
      return res.status(404).json({ error: 'No connection request found for this tenant' });
    }

    const tenant = await Tenant.findById(tenantId)
      .select('whatsapp.connected whatsapp.connectedAt status')
      .lean();

    return res.json({
      request: {
        id:             String(request._id),
        businessName:   request.businessName,
        whatsappNumber: request.whatsappNumber,
        status:         request.status,
        submittedAt:    request.createdAt,
        lastUpdated:    request.updatedAt,
      },
      whatsappConnected: tenant?.whatsapp?.connected  ?? false,
      connectedAt:       tenant?.whatsapp?.connectedAt ?? null,
    });

  } catch (err) {
    next(err);
  }
}

// ── Admin-facing controllers ──────────────────────────────────────────────────

/**
 * getAllConnectionRequests
 * GET /admin/whatsapp/requests
 */
export async function getAllConnectionRequests(req, res, next) {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const filter = {};
    if (status) filter.status = status;

    // [AUDIT-FIX-10] Added Math.max(...,1) lower bound — same gap as
    // adminRoutes.js's sessions endpoint and the (already-fixed)
    // dashboardController.getCustomers. ?limit=-5 would otherwise pass straight
    // through to Mongoose's .limit() unguarded.
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
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
 * GET /admin/whatsapp/requests/:id
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
 * PATCH /admin/whatsapp/requests/:id/status
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
      reviewedBy: 'super-admin',
    });

    if (!result.ok) {
      return res.status(404).json({ error: result.error });
    }

    logger.info('[OnboardingCtrl] Request status updated', { requestId: id, status });

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
 * POST /admin/whatsapp/connect/:tenantId
 *
 * [FIX-ONBOARD-CTL-1] Also advances onboardingStep to 2 after saving credentials.
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
          error:         'Credential verification failed — credentials not saved',
          verifyStatus:  verifyResult.status,
          verifyMessage: verifyResult.message,
          details:       verifyResult.details,
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

    // [FIX-ONBOARD-CTL-1] Advance onboardingStep to 2 (credentials saved, awaiting verification)
    // when the tenant is still at step 0 or 1 — consistent with PATCH /admin/tenants/:id behaviour.
    const currentTenant = await Tenant.findById(tenantId).select('onboardingStep').lean();
    if (currentTenant && (currentTenant.onboardingStep ?? 0) <= 1) {
      await Tenant.findByIdAndUpdate(tenantId, { $set: { onboardingStep: 2 } });
      logger.info('[OnboardingCtrl] onboardingStep advanced to 2', { tenantId });
    }

    if (verifyFirst && verifyResult?.status === 'CONNECTED') {
      await markConnected(tenantId);

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
      message: verifyFirst
        ? 'Credentials saved and verified. Run PATCH /admin/tenants/:id/status with { "status": "ACTIVE" } to activate.'
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
 * POST /admin/whatsapp/test/:tenantId
 *
 * [FIX-ONBOARD-CTL-2] Decrypts stored accessToken before calling verifyCredentials().
 * [FIX-ONBOARD-CTL-3] Rejects SIM_ phoneNumberId before any Meta network call.
 */
export async function testTenantWhatsAppConnection(req, res, next) {
  try {
    const { tenantId } = req.params;
    if (!isValidObjectId(tenantId)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }

    const tenant = await Tenant.findById(tenantId)
      .select('whatsapp name status')
      .lean();

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { phoneNumberId, wabaId, accessToken: storedToken, apiVersion } = tenant.whatsapp || {};

    // [FIX-ONBOARD-CTL-3] Reject SIM_ before network call
    if (!phoneNumberId || phoneNumberId.startsWith('SIM_')) {
      return res.status(422).json({
        error:        'phoneNumberId is still a simulation placeholder. Save real credentials first via POST /admin/whatsapp/connect/:tenantId.',
        verifyStatus: 'INVALID_PHONE_NUMBER',
        phoneNumberId: phoneNumberId || null,
      });
    }

    if (!storedToken) {
      return res.status(422).json({
        error:        'No accessToken found for this tenant. Save credentials first via POST /admin/whatsapp/connect/:tenantId.',
        verifyStatus: 'INVALID_TOKEN',
      });
    }

    // [FIX-ONBOARD-CTL-2] Decrypt stored token before passing to verifyCredentials
    const plaintextToken = decryptToken(storedToken);

    const result = await verifyCredentials({
      phoneNumberId,
      wabaId,
      accessToken: plaintextToken,
      apiVersion,
    });

    logger.info('[OnboardingCtrl] Credential test result', {
      tenantId,
      verifyStatus: result.status,
    });

    if (result.status === 'CONNECTED') {
      const connResult = await markConnected(tenantId);
      if (!connResult.ok) {
        logger.warn('[OnboardingCtrl] markConnected failed after successful verify', { tenantId });
      }

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
      verifyStatus: result.status,
      message:      result.message,
      details:      result.details || null,
      tenantId,
      tenantName:   tenant.name,
    });

  } catch (err) {
    next(err);
  }
}
