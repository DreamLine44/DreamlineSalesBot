/**
 * core/whatsapp/dispatcher.js — WhatSalesAgent2
 *
 * ISOLATED TRANSPORT ADAPTER — the ONLY file that talks to Meta API.
 * Business logic never imports this directly except via dispatchMessage().
 *
 * In SIMULATION_MODE, stores the outbound payload in a per-user slot
 * that simulateController reads synchronously instead of calling Meta.
 *
 * To swap to a different transport: edit this file ONLY.
 *
 * [AUDIT-P2-A] Access tokens are decrypted via decryptToken() before use.
 *              Plaintext tokens (pre-encryption-migration) pass through unchanged.
 */

import logger from '../../config/logger.js';
import { decryptToken } from '../../controllers/tenantController.js';

const SIM_MODE = () => process.env.SIMULATION_MODE === 'true';

// ── Simulation reply store ────────────────────────────────────────────────────
// userId → { resolve, timer }
const _simSlots = new Map();

export function _registerSimSlot(userId, resolve) {
  const timer = setTimeout(() => {
    _simSlots.delete(userId);
    resolve(null); // timeout — no reply within 10s
  }, 10000);
  _simSlots.set(userId, { resolve, timer });
}

/**
 * Called by simulateController AFTER handleIncomingMessage completes,
 * to resolve any slot that was never resolved (e.g. human mode, guard bail-out).
 * Prevents the endpoint from hanging for the full timeout.
 */
export function _resolveSimSlotIfPending(userId) {
  const slot = _simSlots.get(userId);
  if (slot) {
    clearTimeout(slot.timer);
    _simSlots.delete(userId);
    slot.resolve(null);
  }
}

function _resolveSlot(userId, payload) {
  const slot = _simSlots.get(userId);
  if (!slot) return;
  clearTimeout(slot.timer);
  _simSlots.delete(userId);
  slot.resolve(payload);
}

// ── Build Meta API payload ────────────────────────────────────────────────────
function buildPayload(to, ui) {
  if (!ui || !to) return null;
  const type = ui.type || 'text';

  if (type === 'text') {
    return {
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'text', text: { body: String(ui.body || '') },
    };
  }

  if (type === 'buttons') {
    const buttons = (ui.buttons || []).slice(0, 3).map(b => ({
      type: 'reply',
      reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) },
    }));
    if (!buttons.length) {
      return {
        messaging_product: 'whatsapp', recipient_type: 'individual',
        to, type: 'text', text: { body: String(ui.body || '') },
      };
    }
    return {
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: String(ui.body || '').slice(0, 1024) },
        action: { buttons },
      },
    };
  }

  if (type === 'list') {
    const normalizeRow = r => ({
      id:          String(r.id).slice(0, 200),
      title:       String(r.title).slice(0, 24),
      description: r.description ? String(r.description).slice(0, 72) : undefined,
    });

    let sections;
    if (ui.sections && ui.sections.length) {
      // Multi-section format (e.g. time picker with Morning/Afternoon/Evening)
      sections = ui.sections.map(sec => ({
        title: sec.title ? String(sec.title).slice(0, 24) : undefined,
        rows:  (sec.rows || []).slice(0, 10).map(normalizeRow),
      })).filter(sec => sec.rows.length > 0);
    } else {
      // Flat rows format (legacy — single unlabelled section)
      const rows = (ui.rows || []).slice(0, 10).map(normalizeRow);
      sections = [{ rows }];
    }

    if (!sections.length || !sections[0].rows.length) return null;

    return {
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'interactive',
      interactive: {
        type: 'list',
        ...(ui.header ? { header: { type: 'text', text: String(ui.header).slice(0, 60) } } : {}),
        body:   { text: String(ui.body || '').slice(0, 1024) },
        ...(ui.footer ? { footer: { text: String(ui.footer).slice(0, 60) } } : {}),
        action: {
          button: String(ui.button || ui.buttonLabel || 'Choose option').slice(0, 20),
          sections,
        },
      },
    };
  }

  // ── Image message ─────────────────────────────────────────────────────────
  // ui.type === 'image' → { type: 'image', url: '...', caption?: '...' }
  if (type === 'image') {
    if (!ui.url) return null;
    return {
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'image',
      image: {
        link:    String(ui.url),
        ...(ui.caption ? { caption: String(ui.caption).slice(0, 1024) } : {}),
      },
    };
  }

  // ── Template message ──────────────────────────────────────────────────────
  // ui.type === 'template' → { type: 'template', name: '...', language: '...', components: [...] }
  // Used by schedulerService for 24h+ outbound messages that require pre-approved templates.
  if (type === 'template') {
    if (!ui.name) return null;
    return {
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'template',
      template: {
        name:       String(ui.name),
        language:   { code: String(ui.language || 'en_US') },
        components: ui.components || [],
      },
    };
  }

  // Fallback: plain text
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual',
    to, type: 'text', text: { body: String(ui.body || ui.text || '') },
  };
}

// ── Main dispatch ─────────────────────────────────────────────────────────────
export async function dispatchMessage(to, ui, tenant) {
  if (!ui) return;

  // Simulation mode: resolve the waiting slot instead of calling Meta.
  if (SIM_MODE()) {
    const payload = buildPayload(to, ui);
    logger.info('[Dispatch:SIM]', {
      to,
      type: ui.type,
      body: (ui.body || '').slice(0, 100),
    });
    // For image-only messages, don't resolve the slot yet — the quantity-prompt
    // buttons message arrives next and is more useful to the simulate endpoint.
    if (ui.type !== 'image') {
      _resolveSlot(to, ui);
    }
    return { simulated: true, payload };
  }

  // Live Meta API
  const payload = buildPayload(to, ui);
  if (!payload) return;

  // [AUDIT-P2-A] Decrypt token before use — transparently handles both encrypted
  // (enc: prefix) and plaintext tokens (pre-migration / dev environments).
  const rawToken = tenant?.whatsapp?.accessToken;
  const token    = decryptToken(rawToken);
  const phoneId  = tenant?.whatsapp?.phoneNumberId;
  const version  = tenant?.whatsapp?.apiVersion || process.env.META_API_VERSION || 'v21.0';

  if (!token || !phoneId) {
    logger.warn('[Dispatch] Missing WhatsApp credentials', { tenantId: tenant?._id });
    return;
  }

  // Guard: don't dispatch to simulation placeholder phone IDs in production
  if (phoneId.startsWith('SIM_')) {
    logger.warn('[Dispatch] Refusing to call Meta with placeholder phoneNumberId', {
      tenantId: tenant?._id, phoneId,
    });
    return;
  }

  const url = `https://graph.facebook.com/${version}/${phoneId}/messages`;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const resp  = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      logger.error('[Dispatch] Meta error', { status: resp.status, err: err.slice(0, 200) });
    }
    return resp;
  } catch (err) {
    logger.error('[Dispatch] Network error', { err: err.message, to });
  }
}

export const dispatchText = (to, text, tenant) =>
  dispatchMessage(to, { type: 'text', body: text }, tenant);

/**
 * dispatchTemplate — send a pre-approved WhatsApp template message.
 * Required for outbound messages to users who haven't interacted in 24+ hours.
 * See schedulerService.js for usage context.
 *
 * @param {string} to           - Customer phone number
 * @param {string} templateName - Meta-approved template name (e.g. 'abandoned_cart_v1')
 * @param {string} language     - Template language code (default: 'en_US')
 * @param {Array}  components   - Template parameter components array
 * @param {object} tenant       - Tenant document with whatsapp credentials
 */
export const dispatchTemplate = (to, templateName, language = 'en_US', components = [], tenant) =>
  dispatchMessage(to, { type: 'template', name: templateName, language, components }, tenant);
