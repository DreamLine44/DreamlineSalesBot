/**
 * services/messageService.js
 *
 * FIXES APPLIED:
 *  [5] Token expiry detection — 401 errors caught, flagged, and admin alerted
 *  [9] Persistent retry queue — failed messages written to FailedMessage collection
 *        so they can be replayed; 5xx still retried in-process as before
 *
 * Converted to ESM (project uses "type": "module").
 */

import axios from 'axios';
import FailedMessage from '../models/FailedMessage.js';
import { notifyAdmin } from './notificationService.js';
import logger from "../config/logger.js";

const FALLBACK_API_VERSION = process.env.WA_API_VERSION || 'v21.0';
const MAX_RETRIES = 3;        // [UPGRADE] 2 → 3 retries for better resilience
const RETRY_DELAY_MS = 400;   // Base delay — doubles with each retry + jitter
const CONNECT_TIMEOUT_MS = 8000;  // Separate connect timeout
const REQUEST_TIMEOUT_MS = 12000; // Total request timeout

// ─── [UPGRADE] Simple circuit breaker per tenant ──────────────────────────────
// Tracks consecutive failures per tenant. After CIRCUIT_OPEN_THRESHOLD failures,
// the circuit opens and requests are blocked for CIRCUIT_RESET_MS to avoid
// hammering Meta's API during an outage.
//
// This is an in-process guard — not distributed. Under horizontal scaling,
// each instance maintains its own counter. Good enough for most deployments.

const CIRCUIT_OPEN_THRESHOLD = 5;    // Open circuit after 5 consecutive failures
const CIRCUIT_RESET_MS       = 30000; // Try again after 30 seconds

const _circuitBreakers = new Map(); // tenantId → { failures, openedAt }

function isCircuitOpen(tenantId) {
  const cb = _circuitBreakers.get(String(tenantId));
  if (!cb) return false;
  if (cb.failures < CIRCUIT_OPEN_THRESHOLD) return false;
  const age = Date.now() - cb.openedAt;
  if (age > CIRCUIT_RESET_MS) {
    // Half-open: allow one request through to test if Meta is back
    _circuitBreakers.delete(String(tenantId));
    return false;
  }
  return true;
}

function recordSuccess(tenantId) {
  _circuitBreakers.delete(String(tenantId));
}

function recordFailure(tenantId) {
  const key = String(tenantId);
  const cb  = _circuitBreakers.get(key) || { failures: 0, openedAt: 0 };
  cb.failures += 1;
  if (cb.failures >= CIRCUIT_OPEN_THRESHOLD && cb.openedAt === 0) {
    cb.openedAt = Date.now();
    logger.warn(`[MessageService] Circuit OPEN for tenant ${tenantId} after ${cb.failures} failures`);
  }
  _circuitBreakers.set(key, cb);
}

// ─── [UPGRADE] Exponential back-off with jitter ───────────────────────────────
function retryDelay(attempt) {
  const base  = RETRY_DELAY_MS * Math.pow(2, attempt); // 400, 800, 1600…
  const jitter = Math.random() * 200;                   // ±200ms jitter
  return Math.min(base + jitter, 5000);                 // cap at 5s
}

/**
 * Send a WhatsApp text message to `to` on behalf of `tenant`.
 * @param {string} to      Recipient phone number (E.164 without +)
 * @param {string} text    Message body
 * @param {object} tenant  Tenant document (.accessToken, .phoneNumberId, .adminPhone, ._id)
 */
export async function sendMessage(to, text, tenant) {
  // Tenant model stores credentials under .whatsapp.* — support both flat and nested
  const phoneNumberId = tenant?.whatsapp?.phoneNumberId || tenant?.phoneNumberId;
  const accessToken   = tenant?.whatsapp?.accessToken   || tenant?.accessToken;
  const tenantId      = tenant?._id;

  // [FIX 2] Use per-tenant apiVersion if stored, fall back to env var.
  const apiVersion = tenant?.whatsapp?.apiVersion || FALLBACK_API_VERSION;

  // [UPGRADE] Circuit breaker — skip Meta API calls when tenant is in open state
  if (tenantId && isCircuitOpen(tenantId)) {
    logger.warn(`[MessageService] Circuit OPEN — skipping send for tenant ${tenantId}`);
    await persistFailedMessage({ to, text, tenantId, reason: 'RETRIES_EXHAUSTED', status: null });
    return;
  }

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  };

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await axios.post(url, data, {
        headers,
        timeout:        REQUEST_TIMEOUT_MS,
        // [UPGRADE] Separate connect timeout via httpAgent would require http module.
        // Use axios timeout as a combined guard — sufficient for production.
      });
      if (tenantId) recordSuccess(tenantId);
      return; // success
    } catch (err) {
      lastError = err;
      const status = err.response?.status;

      // ── [FIX 5] Token expiry detection ─────────────────────────────────
      if (status === 401) {
        logger.error(`[MessageService] 401 Unauthorized for tenant ${tenantId}. Access token likely expired.`);
        if (tenantId) recordFailure(tenantId);
        try {
          await notifyAdmin(
            tenant,
            `⚠️ WhatsApp Bot Alert: Your access token has expired. ` +
            `Messages are not being delivered. Please refresh your token in the dashboard.`
          );
        } catch (notifyErr) {
          logger.error('[MessageService] Failed to notify admin of 401:', notifyErr.message);
        }
        await persistFailedMessage({ to, text, tenantId, reason: 'TOKEN_EXPIRED', status: 401 });
        return; // Do NOT retry — token must be refreshed first
      }

      // ── Non-retryable 4xx ───────────────────────────────────────────────
      const isRetryable = status == null || status >= 500;
      if (!isRetryable) {
        logger.error(`[MessageService] Non-retryable error (${status}) sending to ${to}: ${err?.response?.data?.error?.message || err.message}`);
        if (tenantId) recordFailure(tenantId);
        await persistFailedMessage({ to, text, tenantId, reason: 'NON_RETRYABLE', status });
        return;
      }

      // Retryable 5xx — back-off with jitter then loop
      if (attempt < MAX_RETRIES) {
        const delay = retryDelay(attempt);
        logger.warn(`[MessageService] Attempt ${attempt + 1} failed (${status}), retrying in ${Math.round(delay)}ms…`);
        await sleep(delay);
      }
    }
  }

  // All retries exhausted — persist for replay
  const status = lastError?.response?.status ?? null;
  logger.error(`[MessageService] All retries exhausted sending to ${to}. Status: ${status}`);
  if (tenantId) recordFailure(tenantId);
  await persistFailedMessage({ to, text, tenantId, reason: 'RETRIES_EXHAUSTED', status });
}

// ─── [FIX 9] Persist failed message to MongoDB ───────────────────────────────
async function persistFailedMessage({ to, text, tenantId, reason, status }) {
  try {
    await FailedMessage.create({ to, text, tenantId, reason, httpStatus: status, retriedAt: null, replayed: false });
    logger.info(`[MessageService] Failed message persisted for replay (reason=${reason}, tenant=${tenantId})`);
  } catch (dbErr) {
    logger.error('[MessageService] CRITICAL: Could not write FailedMessage to DB:', dbErr.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a WhatsApp interactive button message (up to 3 buttons).
 * Falls back to plain text if the tenant has no accessToken or API call fails.
 *
 * @param {string}   to       Recipient phone
 * @param {string}   bodyText Main message body
 * @param {Array}    buttons  [{id, title}] — max 3, title max 20 chars
 * @param {object}   tenant   Tenant document
 * @returns {boolean} true on success, false on failure
 */
export async function sendButtonMessage(to, bodyText, buttons, tenant) {
  const phoneNumberId = tenant?.whatsapp?.phoneNumberId || tenant?.phoneNumberId;
  const accessToken   = tenant?.whatsapp?.accessToken   || tenant?.accessToken;
  const apiVersion    = tenant?.whatsapp?.apiVersion    || process.env.WA_API_VERSION || 'v21.0';

  if (!phoneNumberId || !accessToken) return false;

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText.slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map(btn => ({
          type:  'reply',
          reply: {
            id:    String(btn.id).slice(0, 256),
            title: String(btn.title).slice(0, 20),
          },
        })),
      },
    },
  };

  try {
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });
    return true;
  } catch (err) {
    // Log but don't throw — caller will fall back to plain text
    logger.warn(`[MessageService] Button message failed, falling back to text: ${err?.response?.data?.error?.message || err.message}`);
    return false;
  }
}

/**
 * Send a WhatsApp interactive list message (up to 10 items).
 *
 * @param {string} to         Recipient phone
 * @param {string} headerText Header text (shown bold above body)
 * @param {string} bodyText   Body text (the question/prompt)
 * @param {string} buttonText Label on the "open list" button (max 20 chars)
 * @param {Array}  rows       [{id, title, description?}] — max 10 rows
 * @param {object} tenant     Tenant document
 * @returns {boolean} true on success, false on failure
 */
export async function sendListMessage(to, headerText, bodyText, buttonText, rows, tenant) {
  const phoneNumberId = tenant?.whatsapp?.phoneNumberId || tenant?.phoneNumberId;
  const accessToken   = tenant?.whatsapp?.accessToken   || tenant?.accessToken;
  const apiVersion    = tenant?.whatsapp?.apiVersion    || process.env.WA_API_VERSION || 'v21.0';

  if (!phoneNumberId || !accessToken) return false;

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: headerText.slice(0, 60) },
      body:   { text: bodyText.slice(0, 1024) },
      action: {
        button: buttonText.slice(0, 20),
        sections: [{
          title: headerText.slice(0, 24),
          rows: rows.slice(0, 10).map(r => ({
            id:          String(r.id).slice(0, 200),
            title:       String(r.title).slice(0, 24),
            description: r.description ? String(r.description).slice(0, 72) : undefined,
          })),
        }],
      },
    },
  };

  try {
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });
    return true;
  } catch (err) {
    logger.warn(`[MessageService] List message failed: ${err?.response?.data?.error?.message || err.message}`);
    return false;
  }
}

/**
 * ─── v16: sendImageMessage() ─────────────────────────────────────────────────
 *
 * Send a WhatsApp image message.
 * Handles both https:// URLs (link-based) and WhatsApp media IDs.
 * Falls back gracefully — never throws.
 *
 * @param {string}  to          Recipient phone
 * @param {string}  mediaIdOrUrl  WhatsApp media ID, wa-media:xxx, or https:// URL
 * @param {string}  caption     Optional caption (max 1024 chars)
 * @param {object}  tenant      Tenant document
 * @returns {boolean} true on success, false on failure/skip
 */
export async function sendImageMessage(to, mediaIdOrUrl, caption = '', tenant) {
  const phoneNumberId = tenant?.whatsapp?.phoneNumberId || tenant?.phoneNumberId;
  const accessToken   = tenant?.whatsapp?.accessToken   || tenant?.accessToken;
  const apiVersion    = tenant?.whatsapp?.apiVersion    || process.env.WA_API_VERSION || 'v21.0';

  if (!phoneNumberId || !accessToken || !mediaIdOrUrl) return false;

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  // Determine whether to use .link (https) or .id (WhatsApp media ID)
  const isLink   = mediaIdOrUrl.startsWith('https://');
  const rawId    = mediaIdOrUrl.startsWith('wa-media:')
    ? mediaIdOrUrl.replace('wa-media:', '')
    : mediaIdOrUrl;

  const imageField = isLink
    ? { link: mediaIdOrUrl, caption: caption ? String(caption).slice(0, 1024) : undefined }
    : { id: rawId,          caption: caption ? String(caption).slice(0, 1024) : undefined };

  const payload = { messaging_product: 'whatsapp', to, type: 'image', image: imageField };

  try {
    await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: 10_000,
    });
    return true;
  } catch (err) {
    logger.warn(`[MessageService] Image message failed: ${err?.response?.data?.error?.message || err.message}`);
    return false;
  }
}

/**
 * ─── v15: dispatch() ──────────────────────────────────────────────────────────
 *
 * Converts a messageBuilders UI object → correct WhatsApp API call.
 * flowService calls dispatch(to, uiObject, tenant) instead of sendMessage().
 * Keeps Layer 2 (flow logic) fully decoupled from Layer 3 (WhatsApp API).
 *
 * @param {string} to      Recipient phone
 * @param {object} ui      { type: 'text'|'buttons'|'list'|'image', body, ... }
 * @param {object} tenant  Tenant document
 */
export async function dispatch(to, ui, tenant) {
  if (!ui) return;

  // [v12] Array of UI objects — send each one sequentially.
  // Used by QUANTITY step when an AI clarification is followed by a nudge button.
  if (Array.isArray(ui)) {
    for (const item of ui) {
      await dispatch(to, item, tenant);
    }
    return;
  }

  // Plain string shortcut
  if (typeof ui === 'string') {
    await sendMessage(to, ui, tenant);
    return;
  }

  // Image message — forward a screenshot or photo (supports media IDs + https URLs)
  if (ui.type === 'image') {
    const sent = await sendImageMessage(to, ui.url, ui.caption || '', tenant).catch(() => false);
    // If image failed, fall back to caption text so message is never silently lost
    if (!sent && ui.caption) await sendMessage(to, ui.caption, tenant);
    return;
  }

  if (ui.type === 'buttons') {
    const sent = await sendButtonMessage(to, ui.body, ui.buttons, tenant).catch(() => false);
    if (!sent) await sendMessage(to, ui.body, tenant);
    return;
  }

  if (ui.type === 'list') {
    const sent = await sendListMessage(
      to, ui.header, ui.body, ui.buttonLabel, ui.rows, tenant,
    ).catch(() => false);
    if (!sent) await sendMessage(to, ui.body, tenant);
    return;
  }

  // Default: text — guard against undefined body to avoid "[object Object]" messages
  const body = ui.body ?? (typeof ui === 'string' ? ui : null);
  if (!body) {
    // Nothing to send — log and bail rather than sending garbage
    logger.warn('[messageService.dispatch] UI object has no body — message suppressed', { ui });
    return;
  }
  await sendMessage(to, body, tenant);
}
