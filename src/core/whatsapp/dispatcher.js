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
        // [FIX-25] footer is valid on button interactive messages (WhatsApp API supports it).
        // Previously footer was only serialised for 'list' type — so hints like
        // "Or type any date e.g. 25 June" from bookingFlow date/party-size pickers
        // were silently dropped and never reached the customer.
        ...(ui.footer ? { footer: { text: String(ui.footer).slice(0, 60) } } : {}),
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
      // [FIX-LIST-TRUNC] Flat rows format (legacy — the format every module in
      // src/modules uses). WhatsApp's real limit is 10 rows PER SECTION, up to
      // 10 sections (100 rows total) — not 10 rows overall. Previously
      // `.slice(0, 10)` silently dropped everything past the 10th row with no
      // error or log; a business with a 15-item menu only ever showed the
      // first 10. Now chunked across sections instead of truncated.
      const allRows = (ui.rows || []).slice(0, 100).map(normalizeRow);
      sections = [];
      for (let i = 0; i < allRows.length; i += 10) {
        sections.push({ rows: allRows.slice(i, i + 10) });
      }
      if (!sections.length) sections = [{ rows: [] }];
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

  // ── WA Catalog: catalog_message ───────────────────────────────────────────
  // [CATALOG-DISPATCH-1] ui.type === 'catalog_message' → Meta's full
  // searchable/scrollable Commerce Catalog browse UI, opened in one extra tap.
  if (type === 'catalog_message') {
    if (!ui.catalogId) return null;
    return {
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'interactive',
      interactive: {
        type: 'catalog_message',
        body: { text: String(ui.body || '').slice(0, 1024) },
        action: { name: 'catalog_message', parameters: { catalog_id: String(ui.catalogId) } },
      },
    };
  }

  // ── WA Catalog: product_list ──────────────────────────────────────────────
  // [CATALOG-DISPATCH-1] ui.type === 'product_list' → up-front, categorized
  // browse UI (see waCatalogService.sendCatalogMessage()). Meta caps each
  // section at 30 product_items.
  if (type === 'product_list') {
    if (!ui.catalogId || !ui.sections?.length) return null;
    const sections = ui.sections
      .map(sec => ({
        title:         sec.title ? String(sec.title).slice(0, 24) : undefined,
        product_items: (sec.productRetailerIds || []).slice(0, 30).map(id => ({ product_retailer_id: String(id) })),
      }))
      .filter(sec => sec.product_items.length > 0);
    if (!sections.length) return null;

    return {
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'interactive',
      interactive: {
        type: 'product_list',
        ...(ui.header ? { header: { type: 'text', text: String(ui.header).slice(0, 60) } } : {}),
        body:   { text: String(ui.body || '').slice(0, 1024) },
        action: { catalog_id: String(ui.catalogId), sections },
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
    logger.warn('[Dispatch] ✗ Cannot send — missing WhatsApp credentials on tenant', {
      tenantId: tenant?._id,
      hasToken: !!rawToken,
      hasPhoneId: !!phoneId,
      tip: 'Set whatsapp.accessToken and whatsapp.phoneNumberId on the tenant document',
    });
    return;
  }

  // Guard: don't dispatch to simulation placeholder phone IDs in production
  if (phoneId.startsWith('SIM_')) {
    logger.warn('[Dispatch] ✗ Refusing to call Meta — phoneNumberId is a placeholder (SIM_*)', {
      tenantId: tenant?._id,
      phoneId,
      tip: 'Replace SIM_* phoneNumberId with a real Meta phoneNumberId for this tenant',
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
      logger.error('[Dispatch] ✗ Meta API returned error', {
        status: resp.status,
        to,
        msgType: ui.type,
        err: err.slice(0, 300),
        tenantId: tenant?._id,
      });
      // [AUDIT-FIX-DISPATCH-FALSE-SUCCESS] Previously fell through to
      // `return resp;` unconditionally — a 4xx/5xx Response object is still
      // truthy, so every caller (sendCatalogMessage() and friends) read a
      // failed send as a success and never fell back for the customer.
      return null;
    }
    logger.debug('[Dispatch] ✓ Message sent via Meta API', {
      to,
      type: ui.type,
      status: resp.status,
    });
    return resp;
  } catch (err) {
    logger.error('[Dispatch] ✗ Network error sending to Meta API', {
      err: err.message,
      to,
      tenantId: tenant?._id,
    });
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
