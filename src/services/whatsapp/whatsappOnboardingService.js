/**
 * services/whatsappOnboardingService.js
 *
 * Business-logic layer for the WhatsApp onboarding module.
 *
 * ISOLATION CONTRACT:
 *   Imports only: Mongoose models, Node built-ins, internal logger.
 *   Does NOT import: flowEngine, moduleRouter, intentEngine, sessionService,
 *   dispatcher, webhookController, or any existing bot service.
 *
 * [FIX-ONBOARD-1] saveCredentials now encrypts accessToken and verifyToken
 *   via encryptToken() from tenantController before writing to DB.
 *   Previously credentials were stored plaintext here, bypassing the
 *   AES-256-GCM encryption applied by the tenantController PATCH path.
 *   Any token saved via the onboarding service would fail decryptToken()
 *   in the dispatcher (no enc: prefix → passthrough, but inconsistent with
 *   encrypted tokens stored via PATCH).  Now both paths encrypt identically.
 *
 * [FIX-ONBOARD-2] verifyCredentials uses the same Authorization: Bearer
 *   header pattern as verifyCredentialsWithMeta() in tenantController.
 *   The old debug_token approach requires the token to be both input_token
 *   AND access_token, which fails for System User tokens (they cannot
 *   self-introspect without an App access token). Calling the phone number
 *   endpoint directly with an Authorization header is the correct and
 *   consistent approach used throughout the rest of the codebase.
 *
 * [FIX-ONBOARD-3] markConnected no longer force-sets status = 'ACTIVE'.
 *   Marking connected and activating are separate admin decisions.
 *   Only whatsapp.connected and whatsapp.lastVerifiedAt are set here.
 *   Activation (status → ACTIVE) happens via PATCH /admin/tenants/:id/status
 *   or the ONE-SHOT activate:true path.
 */
import Tenant from '../../models/Tenant.js';
import WhatsAppConnectionRequest from '../../models/WhatsAppConnectionRequest.js';
import { encryptToken, decryptToken } from '../../controllers/tenantController.js';
import { notifyStatusChange } from './whatsappNotificationService.js';
import logger from '../../config/logger.js';

// ── Meta Graph API verification ──────────────────────────────────────────────

/**
 * verifyCredentials
 *
 * Validates a phoneNumberId + accessToken pair against the Meta Graph API.
 * Uses Authorization: Bearer header (matches tenantController pattern).
 * Never throws — always returns a structured result.
 *
 * @param {object} params
 * @param {string} params.phoneNumberId
 * @param {string} params.accessToken   plaintext token (not yet encrypted)
 * @param {string} [params.wabaId]      informational only — not used in verification
 * @param {string} [params.apiVersion]  default "v21.0"
 *
 * @returns {Promise<{
 *   status: 'CONNECTED'|'INVALID_TOKEN'|'INVALID_PHONE_NUMBER'|'META_ERROR',
 *   message: string,
 *   details?: object
 * }>}
 */
export async function verifyCredentials({ phoneNumberId, wabaId, accessToken, apiVersion = 'v21.0' }) {
  // Pre-flight: reject SIM_ placeholders immediately
  if (!phoneNumberId || phoneNumberId.startsWith('SIM_')) {
    return {
      status:  'INVALID_PHONE_NUMBER',
      message: 'phoneNumberId is a simulation placeholder — set a real Meta Phone Number ID first.',
    };
  }

  if (!accessToken) {
    return {
      status:  'INVALID_TOKEN',
      message: 'accessToken is required for verification.',
    };
  }

  const url  = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(phoneNumberId)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);

  let resp;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal:  ctrl.signal,
    });
    clearTimeout(timer);
  } catch (fetchErr) {
    clearTimeout(timer);
    const isTimeout = fetchErr.name === 'AbortError';
    logger.warn('[OnboardingService] Meta API fetch failed', { err: fetchErr.message });
    return {
      status:  'META_ERROR',
      message: isTimeout
        ? 'Request to Meta API timed out (10 s).'
        : `Network error reaching Meta API: ${fetchErr.message}`,
    };
  }

  if (!resp.ok) {
    const errBody  = await resp.json().catch(() => ({}));
    const metaMsg  = errBody?.error?.message || 'Meta API rejected the credentials';
    const metaCode = errBody?.error?.code;

    if (metaCode === 190 || metaMsg.toLowerCase().includes('access token')) {
      return {
        status:  'INVALID_TOKEN',
        message: `Access token rejected by Meta: ${metaMsg}`,
        details: errBody?.error || {},
      };
    }

    return {
      status:  'INVALID_PHONE_NUMBER',
      message: `Phone number ID not found or inaccessible: ${metaMsg}`,
      details: errBody?.error || {},
    };
  }

  const data = await resp.json().catch(() => ({}));

  logger.info('[OnboardingService] Credential verification PASSED', {
    phoneNumberId,
    wabaId,
    displayNumber: data.display_phone_number,
    status:        data.status,
  });

  return {
    status:  'CONNECTED',
    message: 'Credentials verified successfully',
    details: {
      displayPhoneNumber: data.display_phone_number ?? null,
      verifiedName:       data.verified_name        ?? null,
      phoneStatus:        data.status               ?? null,
    },
  };
}

// ── Credential persistence ────────────────────────────────────────────────────

/**
 * saveCredentials
 *
 * Persists WhatsApp credentials onto the tenant document.
 * [FIX-ONBOARD-1] Encrypts accessToken and verifyToken before writing.
 *
 * @param {string} tenantId
 * @param {object} credentials  { phoneNumberId, wabaId, accessToken, verifyToken, apiVersion }
 * @returns {Promise<{ ok: boolean, tenant?: object, error?: string }>}
 */
export async function saveCredentials(tenantId, credentials) {
  const { phoneNumberId, wabaId, accessToken, verifyToken, apiVersion } = credentials;

  try {
    const update = {
      'whatsapp.phoneNumberId':  phoneNumberId,
      'whatsapp.wabaId':         wabaId || null,
      // [FIX-ONBOARD-1] Encrypt before storing — consistent with tenantController
      'whatsapp.accessToken':    accessToken ? encryptToken(accessToken) : null,
      'whatsapp.verifyToken':    verifyToken ? encryptToken(verifyToken) : null,
      'whatsapp.tokenUpdatedAt': new Date(),
    };
    if (apiVersion) update['whatsapp.apiVersion'] = apiVersion;

    const tenant = await Tenant.findByIdAndUpdate(
      tenantId,
      { $set: update },
      { new: true, runValidators: false },
    ).lean();

    if (!tenant) return { ok: false, error: 'Tenant not found' };

    logger.info('[OnboardingService] Credentials saved', { tenantId, phoneNumberId });
    return { ok: true, tenant };

  } catch (err) {
    logger.error('[OnboardingService] saveCredentials failed', { tenantId, err: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * markConnected
 *
 * Sets whatsapp.connected = true and stamps lastVerifiedAt.
 * [FIX-ONBOARD-3] Does NOT force status = 'ACTIVE' — activation is a
 * separate admin decision handled by PATCH /admin/tenants/:id/status.
 *
 * @param {string} tenantId
 * @returns {Promise<{ ok: boolean, tenant?: object, error?: string }>}
 */
export async function markConnected(tenantId) {
  try {
    const now = new Date();

    const tenant = await Tenant.findByIdAndUpdate(
      tenantId,
      {
        $set: {
          'whatsapp.connected':      true,
          'whatsapp.lastVerifiedAt': now,
        },
      },
      { new: true, runValidators: false },
    );

    if (!tenant) return { ok: false, error: 'Tenant not found' };

    // Stamp connectedAt only the first time
    if (!tenant.whatsapp?.connectedAt) {
      await Tenant.findByIdAndUpdate(tenantId, { $set: { 'whatsapp.connectedAt': now } });
    }

    logger.info('[OnboardingService] Tenant marked CONNECTED', { tenantId });

    // Auto-publish booking calendar Flow only when explicitly enabled
    if (process.env.BOOKING_DATE_FLOW_ENABLED === 'true') {
      (async () => {
        try {
          const { ensureBookingDateFlow } = await import('./bookingDateFlowProvisioner.js');
          await ensureBookingDateFlow({ tenant: tenant.toObject() });
        } catch { /* non-fatal */ }
      })();
    }

    return { ok: true, tenant: tenant.toObject() };

  } catch (err) {
    logger.error('[OnboardingService] markConnected failed', { tenantId, err: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * updateStatus
 *
 * Updates a WhatsAppConnectionRequest status and fires a notification.
 *
 * @param {string} requestId
 * @param {string} newStatus
 * @param {object} [meta]
 * @returns {Promise<{ ok: boolean, request?: object, error?: string }>}
 */
export async function updateStatus(requestId, newStatus, meta = {}) {
  try {
    const update = {
      status:     newStatus,
      reviewedAt: new Date(),
    };
    if (meta.adminNotes !== undefined) update.adminNotes = meta.adminNotes;
    if (meta.reviewedBy)               update.reviewedBy = meta.reviewedBy;

    const request = await WhatsAppConnectionRequest.findByIdAndUpdate(
      requestId,
      { $set: update },
      { new: true },
    );

    if (!request) return { ok: false, error: 'Connection request not found' };

    notifyStatusChange(request, newStatus, meta.adminNotes || '').catch(() => {});

    return { ok: true, request };

  } catch (err) {
    logger.error('[OnboardingService] updateStatus failed', { requestId, err: err.message });
    return { ok: false, error: err.message };
  }
}

