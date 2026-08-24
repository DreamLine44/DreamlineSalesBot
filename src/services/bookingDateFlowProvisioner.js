/**
 * bookingDateFlowProvisioner.js
 *
 * Creates/publishes the booking-date WhatsApp Flow on Meta and stores the Flow ID
 * on the tenant + business config so the calendar picker works without manual setup.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Tenant from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { decryptToken } from '../controllers/tenantController.js';
import { resolveBookingDateFlowId } from './bookingDateFlow.js';
import logger from '../config/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLOW_JSON_PATH = path.join(__dirname, '../../flows/booking-date-picker.json');
const FLOW_NAME = process.env.BOOKING_DATE_FLOW_NAME || 'dreamline_booking_date_picker';

const _inFlight = new Map();

function readFlowJsonString() {
  return fs.readFileSync(FLOW_JSON_PATH, 'utf8');
}

async function graphFetch(url, { method = 'GET', token, body } = {}) {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || JSON.stringify(data).slice(0, 300));
  }
  return data;
}

async function findExistingFlowId(wabaId, token, apiVersion) {
  const data = await graphFetch(
    `https://graph.facebook.com/${apiVersion}/${wabaId}/flows?fields=id,name,status`,
    { token },
  );
  const match = (data.data || []).find(
    (f) => f.name === FLOW_NAME && f.status !== 'DEPRECATED',
  );
  return match?.id || null;
}

async function createAndPublishFlow(wabaId, token, apiVersion) {
  const flowJson = readFlowJsonString();
  const created = await graphFetch(
    `https://graph.facebook.com/${apiVersion}/${wabaId}/flows`,
    {
      method: 'POST',
      token,
      body: {
        name:       FLOW_NAME,
        categories: ['APPOINTMENT_BOOKING'],
        flow_json:  flowJson,
        publish:    true,
      },
    },
  );
  return created.id;
}

async function persistFlowId(tenantId, flowId) {
  await Promise.all([
    Tenant.updateOne(
      { _id: tenantId },
      { $set: { 'whatsapp.bookingDateFlowId': flowId } },
    ),
    BusinessConfig.updateOne(
      { tenantId },
      { $set: { 'whatsappFlows.bookingDateFlowId': flowId } },
    ),
  ]);
}

/**
 * Ensure a published booking-date Flow exists for this tenant.
 * Returns Flow ID or null if Meta credentials are missing / publish failed.
 */
export async function ensureBookingDateFlow({ business, tenant, force = false } = {}) {
  const tenantId = tenant?._id;
  if (!tenantId) return null;

  const existing = resolveBookingDateFlowId(business, tenant);
  if (existing && !force) return existing;

  const wabaId = tenant?.whatsapp?.wabaId;
  const rawToken = tenant?.whatsapp?.accessToken;
  const token = decryptToken(rawToken);
  const apiVersion = tenant?.whatsapp?.apiVersion || process.env.META_API_VERSION || 'v21.0';

  if (!wabaId || !token) {
    logger.debug('[BookingDateFlow] Skip provision — missing wabaId or accessToken', { tenantId });
    return existing || process.env.BOOKING_DATE_FLOW_ID?.trim() || null;
  }

  const cacheKey = String(tenantId);
  if (_inFlight.has(cacheKey)) return _inFlight.get(cacheKey);

  const work = (async () => {
    try {
      let flowId = await findExistingFlowId(wabaId, token, apiVersion);
      if (!flowId) {
        logger.info('[BookingDateFlow] Publishing calendar flow to Meta…', { tenantId, wabaId });
        flowId = await createAndPublishFlow(wabaId, token, apiVersion);
      }
      if (flowId) {
        await persistFlowId(tenantId, flowId);
        logger.info('[BookingDateFlow] Calendar flow ready', { tenantId, flowId });
      }
      return flowId;
    } catch (err) {
      logger.warn('[BookingDateFlow] Auto-provision failed — using list fallback', {
        tenantId,
        err: err.message,
      });
      return existing || process.env.BOOKING_DATE_FLOW_ID?.trim() || null;
    } finally {
      _inFlight.delete(cacheKey);
    }
  })();

  _inFlight.set(cacheKey, work);
  return work;
}

/** Boot-time: provision flows only when calendar Flow is explicitly enabled. */
export async function provisionBookingDateFlowsOnStartup() {
  if (process.env.BOOKING_DATE_FLOW_ENABLED !== 'true') return;
  if (process.env.BOOKING_DATE_FLOW_AUTO_PROVISION === 'false') return;

  try {
    const tenants = await Tenant.find({
      status: 'ACTIVE',
      'whatsapp.connected': true,
      'whatsapp.wabaId': { $exists: true, $ne: null },
      'whatsapp.accessToken': { $exists: true, $ne: null },
      $or: [
        { 'whatsapp.bookingDateFlowId': { $in: [null, ''] } },
        { 'whatsapp.bookingDateFlowId': { $exists: false } },
      ],
    }).lean();

    for (const tenant of tenants) {
      const business = await BusinessConfig.findOne({ tenantId: tenant._id }).lean();
      if (business?.whatsappFlows?.bookingDateFlowId) continue;
      ensureBookingDateFlow({ business, tenant }).catch(() => {});
    }
  } catch (err) {
    logger.warn('[BookingDateFlow] Startup provision scan failed', { err: err.message });
  }
}
