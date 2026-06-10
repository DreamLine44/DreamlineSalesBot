/**
 * services/whatsappOnboardingService.js
 *
 * Business-logic layer for the WhatsApp onboarding module.
 * Responsible for:
 *   - Saving tenant WhatsApp credentials
 *   - Verifying credentials against Meta Graph API
 *   - Marking a tenant as connected / disconnected
 *   - Updating connection request status
 *
 * ISOLATION CONTRACT:
 *   This service imports only:
 *     - Mongoose models (Tenant, WhatsAppConnectionRequest)
 *     - Node built-ins (https)
 *     - Internal logger
 *   It does NOT import or touch:
 *     - flowEngine, moduleRouter, intentEngine
 *     - sessionService, dispatcher, webhookController
 *     - Any existing bot service
 *   The existing bot therefore continues operating exactly as before.
 */
import https from 'https';
import Tenant from '../models/Tenant.js';
import WhatsAppConnectionRequest from '../models/WhatsAppConnectionRequest.js';
import { notifyStatusChange } from './whatsappNotificationService.js';
import logger from '../config/logger.js';

// ── Meta Graph API verification ──────────────────────────────────────────────

const META_GRAPH_BASE = 'https://graph.facebook.com';

/**
 * verifyCredentials
 *
 * Calls the Meta Graph API to confirm that:
 *   1. The access token is valid (token debug endpoint).
 *   2. The phone number ID is reachable with the given token.
 *
 * Returns a structured result object — never throws.
 *
 * @param {object} params
 * @param {string} params.phoneNumberId
 * @param {string} params.wabaId
 * @param {string} params.accessToken
 * @param {string} [params.apiVersion]  default "v21.0"
 *
 * @returns {Promise<{
 *   status: 'CONNECTED'|'INVALID_TOKEN'|'INVALID_PHONE_NUMBER'|'META_ERROR',
 *   message: string,
 *   details?: object
 * }>}
 */
export async function verifyCredentials({ phoneNumberId, wabaId, accessToken, apiVersion = 'v21.0' }) {
  // ── 1. Validate token via debug_token ─────────────────────────────────────
  try {
    const tokenCheckUrl =
      `${META_GRAPH_BASE}/${apiVersion}/debug_token` +
      `?input_token=${encodeURIComponent(accessToken)}` +
      `&access_token=${encodeURIComponent(accessToken)}`;

    const tokenResult = await fetchJson(tokenCheckUrl);

    if (!tokenResult.data?.is_valid) {
      return {
        status:  'INVALID_TOKEN',
        message: 'Access token is invalid or expired',
        details: tokenResult.data || tokenResult.error || {},
      };
    }
  } catch (err) {
    logger.warn('[OnboardingService] Token debug call failed', { err: err.message });
    return { status: 'META_ERROR', message: `Meta API unreachable: ${err.message}` };
  }

  // ── 2. Validate phoneNumberId ─────────────────────────────────────────────
  try {
    const phoneUrl =
      `${META_GRAPH_BASE}/${apiVersion}/${encodeURIComponent(phoneNumberId)}` +
      `?fields=id,display_phone_number,verified_name,status` +
      `&access_token=${encodeURIComponent(accessToken)}`;

    const phoneResult = await fetchJson(phoneUrl);

    if (phoneResult.error) {
      const code = phoneResult.error.code;
      if (code === 190) {
        return { status: 'INVALID_TOKEN', message: 'Access token rejected by Meta', details: phoneResult.error };
      }
      return {
        status:  'INVALID_PHONE_NUMBER',
        message: `Phone number ID not found or inaccessible: ${phoneResult.error.message}`,
        details: phoneResult.error,
      };
    }

    logger.info('[OnboardingService] Credential verification PASSED', {
      phoneNumberId,
      wabaId,
      displayNumber: phoneResult.display_phone_number,
      status:        phoneResult.status,
    });

    return {
      status:  'CONNECTED',
      message: 'Credentials verified successfully',
      details: {
        displayPhoneNumber: phoneResult.display_phone_number,
        verifiedName:       phoneResult.verified_name,
        phoneStatus:        phoneResult.status,
      },
    };

  } catch (err) {
    logger.warn('[OnboardingService] Phone number ID check failed', { err: err.message });
    return { status: 'META_ERROR', message: `Meta API error: ${err.message}` };
  }
}

// ── Credential persistence ─────────────────────────────────────────────────────

/**
 * saveCredentials
 *
 * Persists WhatsApp credentials onto the tenant document.
 * Uses $set targeting only whatsapp.* fields — all other tenant fields untouched.
 *
 * @param {string} tenantId
 * @param {object} credentials
 * @returns {Promise<{ ok: boolean, tenant?: object, error?: string }>}
 */
export async function saveCredentials(tenantId, credentials) {
  const { phoneNumberId, wabaId, accessToken, verifyToken, apiVersion } = credentials;

  try {
    const update = {
      'whatsapp.phoneNumberId':  phoneNumberId,
      'whatsapp.wabaId':         wabaId,
      'whatsapp.accessToken':    accessToken,
      'whatsapp.verifyToken':    verifyToken,
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
 * Sets whatsapp.connected = true and activates the tenant.
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
          status:                    'ACTIVE',
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
    return { ok: true, tenant: tenant.toObject() };

  } catch (err) {
    logger.error('[OnboardingService] markConnected failed', { tenantId, err: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * updateStatus
 *
 * Updates a WhatsAppConnectionRequest status, then fires a notification.
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

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * fetchJson — lightweight HTTPS GET returning parsed JSON.
 * Uses Node's native https module — no external dependency.
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON from Meta: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}
