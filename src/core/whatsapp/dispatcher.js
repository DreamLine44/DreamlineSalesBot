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
import { logAudit } from '../../services/admin/auditService.js';

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

    // [FIX-LIST-CAP-2] The previous [FIX-LIST-TRUNC] logic assumed WhatsApp
    // allows 10 rows PER SECTION with up to 10 sections (100 rows total) and
    // chunked overflowing sections into "Category (cont.)" siblings. That
    // assumption is wrong — Meta's actual limit is 10 ROWS TOTAL across ALL
    // sections combined for a single interactive list message. Sending more
    // returns a hard 400 from the Graph API:
    //   (#131009) Parameter value is not valid — "Total row count exceed
    //   max allowed count: 10"
    // which is exactly what was happening for any menu/category/list with
    // more than 10 entries (production incident 2026-07-22, YM Store menu).
    // Fixed here: rows are collected across sections IN ORDER and hard-capped
    // at 10 total, never chunked past that ceiling. Anything beyond row 10 is
    // dropped from the payload (never sent — a truncated list beats a
    // rejected message), and if truncation happened we surface it via the
    // footer so the customer knows to narrow their search instead of
    // silently losing options.
    const MAX_TOTAL_ROWS = 10;

    let rawSections;
    if (ui.sections && ui.sections.length) {
      // Multi-section format (e.g. time picker with Morning/Afternoon/Evening)
      rawSections = ui.sections.map(sec => ({
        title: sec.title ? String(sec.title).slice(0, 24) : undefined,
        rows:  (sec.rows || []).map(normalizeRow),
      }));
    } else {
      // Flat rows format (used by every module's product/menu list)
      rawSections = [{ title: undefined, rows: (ui.rows || []).map(normalizeRow) }];
    }

    let remaining = MAX_TOTAL_ROWS;
    let truncated = false;
    const sections = [];
    for (const sec of rawSections) {
      if (remaining <= 0) {
        if (sec.rows.length) truncated = true;
        continue;
      }
      if (sec.rows.length > remaining) truncated = true;
      const rows = sec.rows.slice(0, remaining);
      remaining -= rows.length;
      if (rows.length) sections.push({ title: sec.title, rows });
    }

    if (!sections.length || !sections[0].rows.length) return null;

    let listFooter = ui.footer ? String(ui.footer).slice(0, 60) : undefined;
    if (truncated && !ui.footer) {
      listFooter = "Showing 10 items — type what you're looking for to see more";
    }

    return {
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'interactive',
      interactive: {
        type: 'list',
        ...(ui.header ? { header: { type: 'text', text: String(ui.header).slice(0, 60) } } : {}),
        body:   { text: String(ui.body || '').slice(0, 1024) },
        ...(listFooter ? { footer: { text: listFooter } } : {}),
        action: {
          button: String(ui.button || ui.buttonLabel || 'Choose option').slice(0, 20),
          sections,
        },
      },
    };
  }

  // ── WA Catalog messages ────────────────────────────────────────────────────
  // [CATALOG-DISPATCH-1] Meta interactive message types for the Commerce
  // Catalog integration (see modules/catalog/*). Both are refused (null
  // payload, never sent malformed) when required fields are missing —
  // consistent with the 'list'/'image' guards above.
  if (type === 'catalog_message') {
    // [FIX-CATALOG-MSG-PARAM] catalog_id is NOT a valid field anywhere on a
    // catalog_message action — confirmed against Meta's own Cloud API
    // reference and matching 360dialog/CM.com implementations. The only
    // documented key under action.parameters for this message type is
    // thumbnail_product_retailer_id (optional). WhatsApp always renders
    // whichever catalog is linked to the SENDING PHONE NUMBER in Commerce
    // Manager — that binding lives in Meta's system, not in this payload —
    // so ui.catalogId can never select a catalog here. It's kept below only
    // as the pre-existing "does this tenant have a catalog configured at
    // all" guard, exactly as before; it is deliberately never put on the
    // wire. If Meta's schema validation rejects unrecognized action.parameters
    // keys, this was also the direct cause of the tenant 400s.
    if (!ui.catalogId) return null;
    return {
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'interactive',
      interactive: {
        type: 'catalog_message',
        body: { text: String(ui.body || '').slice(0, 1024) },
        action: {
          name: 'catalog_message',
          ...(ui.thumbnailProductRetailerId
            ? { parameters: { thumbnail_product_retailer_id: String(ui.thumbnailProductRetailerId) } }
            : {}),
        },
      },
    };
  }

  if (type === 'product_list') {
    // [FIX-PRODLIST-CAP] Meta's real limit for a multi-product interactive
    // message is 30 product items TOTAL across the whole message, not 30
    // per section — the same "per-section" misreading that caused the
    // list-row 400s (see [FIX-LIST-CAP-2] above). The only current caller
    // (waCatalogService.sendCatalogMessage) already self-limits to this
    // threshold before choosing product_list over catalog_message, but that
    // discipline lived in a caller, not the transport adapter — exactly the
    // gap that let the list-row bug happen in the first place. Enforcing it
    // here too means no future caller can ever trigger a 400 by passing
    // multiple sections that individually look fine (e.g. 4 sections of 10
    // items = 40 total) but blow the combined ceiling.
    const MAX_TOTAL_PRODUCT_ITEMS = 30;
    const rawSections = ui.sections || [];
    let remainingItems = MAX_TOTAL_PRODUCT_ITEMS;
    const sections = rawSections
      .map(sec => {
        const ids = (sec.productRetailerIds || []).slice(0, remainingItems);
        remainingItems -= ids.length;
        return {
          title: sec.title ? String(sec.title).slice(0, 24) : undefined,
          product_items: ids.map(id => ({ product_retailer_id: String(id) })),
        };
      })
      .filter(sec => sec.product_items.length > 0);

    // [FIX-CATALOG-HEADER-1] Unlike 'list' above, Meta's Cloud API REQUIRES
    // interactive.header on a 'product_list' (multi_product) message. If a
    // caller supplies valid catalog sections but omits the header, downgrade
    // to catalog_message instead of returning null and sending the customer
    // into the ordinary text-menu fallback. catalog_message is the native
    // browse-all experience and does not require a header or product IDs.
    if (!ui.catalogId) return null;
    if (!sections.length || !ui.header) {
      return {
        messaging_product: 'whatsapp', recipient_type: 'individual',
        to, type: 'interactive',
        interactive: {
          type: 'catalog_message',
          body: { text: String(ui.body || '').slice(0, 1024) },
          action: { name: 'catalog_message' },
        },
      };
    }

    return {
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'interactive',
      interactive: {
        type: 'product_list',
        header: { type: 'text', text: String(ui.header).slice(0, 60) },
        body: { text: String(ui.body || '').slice(0, 1024) },
        action: {
          catalog_id: String(ui.catalogId),
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

  // ── WhatsApp Flow message (calendar date picker, forms, etc.) ───────────────
  // ui.type === 'flow' → interactive.type: "flow" with flow_id + navigate payload
  if (type === 'flow') {
    if (!ui.flowId) return null;
    const parameters = {
      flow_message_version: '3',
      flow_token:           String(ui.flowToken || 'unused'),
      flow_id:              String(ui.flowId),
      flow_cta:             String(ui.flowCta || 'Open').slice(0, 20),
      flow_action:          'navigate',
    };
    if (ui.flowMode === 'draft') parameters.mode = 'draft';
    if (ui.flowScreen) {
      parameters.flow_action_payload = {
        screen: String(ui.flowScreen),
        ...(ui.flowData && typeof ui.flowData === 'object' ? { data: ui.flowData } : {}),
      };
    }
    return {
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'interactive',
      interactive: {
        type: 'flow',
        ...(ui.header ? { header: { type: 'text', text: String(ui.header).slice(0, 60) } } : {}),
        body:   { text: String(ui.body || '').slice(0, 1024) },
        ...(ui.footer ? { footer: { text: String(ui.footer).slice(0, 60) } } : {}),
        action: { name: 'flow', parameters },
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

// [FIX-LIST-FALLBACK] When a list payload is malformed or Meta rejects it,
// degrade to up to 3 reply buttons (first rows) plus a numbered text listing
// so "View Menu" / Order Food never goes fully silent.
function _collectListRows(ui) {
  if (ui?.sections?.length) {
    return ui.sections.flatMap(sec => sec.rows || []);
  }
  return ui?.rows || [];
}

function _buildListButtonsFallbackUI(ui) {
  const rows = _collectListRows(ui);
  if (!rows.length) return null;
  const buttons = rows.slice(0, 3).map(r => ({
    id:    String(r.id),
    title: String(r.title).slice(0, 20),
  }));
  let body = String(ui.body || '').slice(0, 800);
  if (rows.length > 3) {
    const lines = rows.slice(0, 10).map((r, i) => `${i + 1}. ${r.title}`);
    body = `${body}\n\n${lines.join('\n')}`;
    if (rows.length > 10) body += '\n\n_(Type an item name to find more.)_';
  }
  return {
    type:    'buttons',
    body:    body.slice(0, 1024),
    buttons,
    footer:  ui.footer,
  };
}

async function _postPayloadToMeta(url, payload, token) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    return await fetch(url, {
      method:  'POST',
      signal:  ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(payload),
    });
  } finally {
    clearTimeout(timer);
  }
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
  let payload = buildPayload(to, ui);

  // [FIX-SILENT-DROP] buildPayload() intentionally returns null for a handful of
  // malformed-message guards (list with zero rows after normalisation, catalog
  // message with no catalogId, image with no url, etc.) so a broken payload is
  // never sent to Meta. Previously that null propagated straight back out of
  // dispatchMessage with a bare `return` — no log line, no message to the
  // customer, nothing. From the customer's side a tap (e.g. "View Menu") simply
  // produced no reply at all, which reads as the bot being broken or hung.
  // Now: log loudly (so this is diagnosable instead of a silent no-op) and, if
  // the original ui had any body/text, fall back to sending that as a plain
  // text message so the customer always gets *something* rather than silence.
  if (!payload) {
    logger.warn('[Dispatch] ✗ buildPayload returned null — message payload was malformed, falling back', {
      to,
      type: ui.type,
      hadBody: !!(ui.body || ui.text),
      tenantId: tenant?._id,
    });
    if (ui.type === 'list') {
      const fbUi = _buildListButtonsFallbackUI(ui);
      if (fbUi) payload = buildPayload(to, fbUi);
    }
    if (!payload) {
      const fallbackText = ui.body || ui.text;
      if (!fallbackText) return;
      payload = buildPayload(to, { type: 'text', body: fallbackText });
      if (!payload) return;
    }
  }

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
    let resp = await _postPayloadToMeta(url, payload, token);
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      logger.error('[Dispatch] ✗ Meta API returned error', {
        status: resp.status,
        to,
        msgType: ui.type,
        err: err.slice(0, 300),
        tenantId: tenant?._id,
      });

      // [FIX-FLOW-FALLBACK] Flow sends fail when Flow ID is invalid/unpublished.
      // Fall back to the day-list UI so the customer always gets a reply.
      if (ui.type === 'flow' && ui.fallbackUi) {
        const fbPayload = buildPayload(to, ui.fallbackUi);
        if (fbPayload) {
          logger.warn('[Dispatch] Retrying failed flow send as day-list fallback', { to, tenantId: tenant?._id });
          resp = await _postPayloadToMeta(url, fbPayload, token);
          if (resp.ok) {
            logger.debug('[Dispatch] ✓ Flow fallback (day list) sent via Meta API', { to, tenantId: tenant?._id });
            return resp;
          }
        }
        const textPayload = buildPayload(to, { type: 'text', body: ui.body || ui.fallbackUi.body || 'Please pick a date below.' });
        if (textPayload) {
          resp = await _postPayloadToMeta(url, textPayload, token);
          if (resp.ok) return resp;
        }
      }

      // [FIX-LIST-FALLBACK] List sends are the most common failure (row limits,
      // header issues). Retry as buttons, then plain text, before giving up.
      if (ui.type === 'list') {
        const fbUi = _buildListButtonsFallbackUI(ui);
        if (fbUi) {
          const fbPayload = buildPayload(to, fbUi);
          if (fbPayload) {
            logger.warn('[Dispatch] Retrying failed list send as buttons fallback', { to, tenantId: tenant?._id });
            resp = await _postPayloadToMeta(url, fbPayload, token);
            if (resp.ok) {
              logger.debug('[Dispatch] ✓ List fallback (buttons) sent via Meta API', { to, tenantId: tenant?._id });
              return resp;
            }
          }
        }
        const textPayload = buildPayload(to, { type: 'text', body: ui.body || ui.text || 'Please type what you would like to order.' });
        if (textPayload) {
          logger.warn('[Dispatch] Retrying failed list send as text fallback', { to, tenantId: tenant?._id });
          resp = await _postPayloadToMeta(url, textPayload, token);
          if (resp.ok) {
            logger.debug('[Dispatch] ✓ List fallback (text) sent via Meta API', { to, tenantId: tenant?._id });
            return resp;
          }
        }
      }

      // [AUDIT-FIX-CATALOG-DOWNGRADE] product_list references specific
      // product_retailer_ids (built from waCatalog.syncedRetailerIds — see
      // waCatalogService.js). That snapshot is only re-verified against
      // Meta's LIVE catalog once an hour (RECONCILE_INTERVAL_MS in
      // syncMenuToCatalog()) — so a single product falling out of Meta's
      // catalog between reconciliation runs (removed there directly,
      // rejected on a later re-check, temporarily deindexed, etc.) leaves
      // this tenant's syncedRetailerIds stale for up to that long. Every
      // product_list send in that window references at least one dead ID,
      // Meta rejects the WHOLE interactive message (not just that row —
      // there is no partial-success shape for this message type), and
      // — unlike 'list'/'flow' above — there was previously NO retry here
      // at all: the customer saw "temporarily unavailable" and "Try Again"
      // just re-ran the exact same doomed request every time, with the
      // underlying catalog, WABA connection, and credentials all perfectly
      // fine the whole time. catalog_message is the fix: it opens Meta's
      // own live catalog UI directly and references zero specific
      // product_retailer_ids, so it can never fail for this reason — the
      // same "safe, ID-agnostic" type sendCatalogMessage() already falls
      // back to on its own for a tenant with >30 items (see waCatalogService.js).
      if (ui.type === 'product_list' && ui.catalogId) {
        const fbPayload = buildPayload(to, { type: 'catalog_message', catalogId: ui.catalogId, body: ui.body });
        if (fbPayload) {
          logger.warn('[Dispatch] Retrying failed product_list send as catalog_message fallback', { to, tenantId: tenant?._id });
          resp = await _postPayloadToMeta(url, fbPayload, token);
          if (resp.ok) {
            logger.debug('[Dispatch] ✓ Catalog fallback (catalog_message) sent via Meta API', { to, tenantId: tenant?._id });
            return resp;
          }
        }
      }

      // [FIX-CATALOG-SEND-HEALTH] Catalog-type sends previously failed
      // silently from the dashboard's point of view — the error above only
      // ever reached server logs, so a tenant whose Commerce Manager sync
      // looked perfectly healthy had no way to see WHY "Browse Catalog" kept
      // looping to the "temporarily unavailable" retry message. Persist the
      // real Graph error onto waCatalog.lastSendError (fire-and-forget, never
      // blocks or throws into the send path) so getWaCatalogHealth() can
      // surface it directly. Common cause at this exact point: the catalog
      // exists and is synced, but isn't CONNECTED to this WABA in WhatsApp
      // Manager (a separate step from Commerce Manager's Data sources
      // sharing) — Meta then rejects the send itself, not the sync.
      if ((ui.type === 'catalog_message' || ui.type === 'product_list') && tenant?._id) {
        (async () => {
          try {
            const { default: BusinessConfig } = await import('../../models/BusinessConfig.js');
            await BusinessConfig.updateOne(
              { tenantId: tenant._id },
              { $set: {
                'waCatalog.lastSendError': {
                  reason: `GRAPH_ERROR (${resp.status})`,
                  detail: err.slice(0, 500),
                  at: new Date(),
                },
              } },
            );
          } catch (writeErr) {
            logger.debug('[Dispatch] lastSendError write failed (non-fatal)', { err: writeErr.message });
          }
        })();
      }

      // [FIX-DISPATCH-CATALOG-LAST-RESORT] Everything above this point (the
      // catalog_message downgrade for product_list, or a straight failure
      // for catalog_message itself) can still end in a genuine Meta-side
      // rejection — not a payload-building bug, an actual 4xx/5xx from
      // Graph (catalog disconnected from the WABA, rate limiting, etc.).
      // Previously this just returned null right here with NOTHING further
      // attempted — sendAndArmCatalog() (waCatalogFlow.js) treats null as
      // "nothing sent" and its own retry loop (CATALOG_MAX_ATTEMPTS) retries
      // the exact same doomed catalog send 3 times, then gives up. If
      // browseCatalogExplicit's own text/list ORDER menu fallback also isn't
      // reached for some reason (or the caller is offerCatalogOnStartOrder,
      // which has no such fallback at all — see waCatalogFlow.js), the
      // customer got total silence: no catalog, no text, nothing. One last
      // attempt at the simplest possible message type — plain text, no
      // header, no catalog reference, nothing Meta could reject for a
      // catalog-specific reason — guarantees the customer gets SOMETHING
      // before this function ever gives up.
      if (ui.type === 'catalog_message' || ui.type === 'product_list') {
        const lastResortBody = String(ui.body || '').trim()
          || 'Please type what you would like to order.';
        const lastResortPayload = buildPayload(to, { type: 'text', body: lastResortBody });
        if (lastResortPayload) {
          logger.warn('[Dispatch] Catalog send exhausted — retrying as plain text last resort', {
            to, tenantId: tenant?._id, originalType: ui.type,
          });
          const lastResp = await _postPayloadToMeta(url, lastResortPayload, token);
          if (lastResp.ok) {
            logger.debug('[Dispatch] ✓ Catalog last-resort (text) sent via Meta API', { to, tenantId: tenant?._id });
            return lastResp;
          }
        }
      }

      // [FIX-DISPATCH-FALSE-SUCCESS] A Meta 4xx/5xx must not be handed back to
      // callers as a truthy value — sendCatalogMessage() and friends treat any
      // truthy return as "message actually sent" and skip fallback behavior.
      return null;
    }

    // [FIX-CATALOG-SEND-HEALTH] A successful send after a previously-recorded
    // failure means whatever was wrong got fixed — clear the stale error so
    // the dashboard doesn't keep showing a resolved problem as current.
    if ((ui.type === 'catalog_message' || ui.type === 'product_list') && tenant?._id) {
      (async () => {
        try {
          const { default: BusinessConfig } = await import('../../models/BusinessConfig.js');
          await BusinessConfig.updateOne(
            { tenantId: tenant._id, 'waCatalog.lastSendError.reason': { $ne: null } },
            { $set: { 'waCatalog.lastSendError': { reason: null, detail: null, at: null } } },
          );
        } catch { /* non-fatal */ }
      })();
    }
    logger.debug('[Dispatch] ✓ Message sent via Meta API', {
      to,
      type: ui.type,
      status: resp.status,
    });

    // [AUDIT-FIX-AUDITLOG-WIRE] customer_notified — documented in AuditLog.js as
    // "a customer-facing message was dispatched" but logAudit() was never called
    // anywhere. dispatchMessage() is the single choke point every outbound customer
    // message passes through (dispatchText/dispatchTemplate both call this function
    // too), so one call here — right after a real Meta send actually succeeds —
    // covers every customer notification in the app instead of needing a call site
    // at each of the dozens of places that build a UI payload. Deliberately placed
    // AFTER the success check (not in the SIM_MODE early-return above) so simulated/
    // test sends that never reach a real customer don't get logged. tenantId is
    // read defensively since dispatcher.js only ever receives whatever tenant doc
    // its caller passed in.
    if (tenant?._id) {
      logAudit({
        tenantId: tenant._id,
        actor:    'system',
        action:   'customer_notified',
        metadata: { to, type: ui.type },
      });
    }

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
