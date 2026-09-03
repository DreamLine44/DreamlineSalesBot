/**
 * controllers/simulateController.js — WhatSalesAgent2
 *
 * Local testing — no Meta account needed.
 *
 * POST /api/message    → send message as customer, get bot reply
 * POST /api/reset      → clear session
 * GET  /api/session/:userId  → inspect session
 * GET  /api/businesses → list seeded businesses
 */

import { handleIncomingMessage } from './webhookController.js';
import { getSession, clearSession } from '../core/sessions/sessionService.js';
import { _registerSimSlot, _resolveSimSlotIfPending } from '../core/whatsapp/dispatcher.js';
import { BusinessConfig, Tenant } from '../models/index.js';
import logger         from '../config/logger.js';

// ── POST /api/message ─────────────────────────────────────────────────────────
export async function simulateMessage(req, res) {
  const { userId, tenantId: bodyTenantId, message, type = 'text', buttonId, listId, flowReply } = req.body;

  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!message && !buttonId && !listId && !flowReply) {
    return res.status(400).json({ error: 'message, buttonId, listId, or flowReply required' });
  }

  try {
    // Resolve tenant
    let tenant = bodyTenantId
      ? await Tenant.findById(bodyTenantId).lean()
      : await Tenant.findOne({ status: 'ACTIVE' }).lean();
    if (!tenant) tenant = await Tenant.findOne().lean();
    if (!tenant) return res.status(400).json({ error: 'No tenants found — run: npm run seed' });

    const tenantId      = String(tenant._id);
    const phoneNumberId = tenant.whatsapp?.phoneNumberId || 'SIM';

    // Build fake WhatsApp message object
    let msgObj;
    if (buttonId) {
      msgObj = {
        id: `sim_${Date.now()}`, type: 'interactive', from: userId,
        interactive: { type: 'button_reply', button_reply: { id: buttonId, title: buttonId } },
      };
    } else if (listId || type === 'list_reply') {
      const val = listId || message;
      msgObj = {
        id: `sim_${Date.now()}`, type: 'interactive', from: userId,
        interactive: { type: 'list_reply', list_reply: { id: val, title: val } },
      };
    } else if (flowReply || type === 'flow_reply') {
      const payload = typeof flowReply === 'object' ? flowReply : { booking_date: message };
      msgObj = {
        id: `sim_${Date.now()}`, type: 'interactive', from: userId,
        interactive: {
          type: 'nfm_reply',
          nfm_reply: {
            name: 'flow',
            response_json: JSON.stringify(payload),
          },
        },
      };
    } else if (type === 'image') {
      msgObj = {
        id: `sim_${Date.now()}`, type: 'image', from: userId,
        image: { id: `sim_img_${Date.now()}` },
      };
    } else {
      msgObj = {
        id: `sim_${Date.now()}`, type: 'text', from: userId,
        text: { body: String(message) },
      };
    }

    // Register slot BEFORE processing so dispatcher can resolve into it
    const replyPromise = new Promise(resolve => _registerSimSlot(userId, resolve));

    // Process — this will call dispatchMessage which resolves the slot
    await handleIncomingMessage({ tenantId, tenantDoc: tenant, from: userId, msgObj, phoneNumberId });

    // If the bot was silent (human mode, guard bail-out, duplicate),
    // resolve the slot immediately instead of waiting for the 10s timeout.
    _resolveSimSlotIfPending(userId);

    const ui = await replyPromise;

    if (!ui) {
      // No reply (human mode, duplicate, guard silenced it)
      return res.json({ reply: '(no reply — bot silent or human mode active)', type: 'silent', userId, tenantId });
    }

    res.json({
      reply:   ui.body || ui.text || '',
      type:    ui.type || 'text',
      buttons: ui.buttons || null,
      rows:    ui.rows    || null,
      header:  ui.header  || null,
      flowId:  ui.flowId  || null,
      flowCta: ui.flowCta || null,
      userId,
      tenantId,
    });
  } catch (err) {
    logger.error('[Simulate] Error', { err: err.message, stack: err.stack?.slice(0, 300) });
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/reset ───────────────────────────────────────────────────────────
export async function simulateReset(req, res) {
  const { userId, tenantId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  let tid = tenantId;
  if (!tid) {
    const t = await Tenant.findOne({ status: 'ACTIVE' }).lean();
    tid = t ? String(t._id) : null;
  }
  if (!tid) return res.status(400).json({ error: 'No tenant found' });

  await clearSession(userId, tid);
  res.json({ ok: true, message: `Session cleared for ${userId}` });
}

// ── GET /api/session/:userId ──────────────────────────────────────────────────
export async function simulateGetSession(req, res) {
  const { userId } = req.params;
  let   { tenantId } = req.query;

  if (!tenantId) {
    const t = await Tenant.findOne({ status: 'ACTIVE' }).lean();
    tenantId = t ? String(t._id) : null;
  }
  const session = await getSession(userId, tenantId);
  res.json({ session: session || null, tenantId });
}

// ── GET /api/businesses ───────────────────────────────────────────────────────
export async function listBusinesses(_req, res) {
  const businesses = await BusinessConfig.find()
    .select('name businessMode adminPhone description')
    .lean();
  const tenants = await Tenant.find().select('_id name whatsapp.phoneNumberId').lean();
  const merged  = businesses.map(b => {
    const t = tenants.find(t => String(t._id) === String(b.tenantId));
    return { ...b, simPhoneId: t?.whatsapp?.phoneNumberId };
  });
  res.json({ businesses: merged, count: merged.length });
}
