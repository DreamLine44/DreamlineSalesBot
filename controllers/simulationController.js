/**
 * controllers/simulationController.js — DreamLine SalesBot v23.0
 *
 * LOCAL TESTING ENGINE — Simulates WhatsApp conversations without Meta.
 *
 * This implements Phase 2 of the build spec:
 *   POST /api/messages   → simulate an inbound WhatsApp message
 *   GET  /api/session    → inspect current session state
 *   DELETE /api/session  → clear session (simulate conversation reset)
 *   GET  /api/history    → get conversation history for a user
 *   POST /api/reset      → hard reset a user's state
 *   GET  /api/businesses → list available test businesses
 *
 * The simulation layer:
 *  1. Accepts { userId, message, businessId?, mediaType? }
 *  2. Looks up (or creates) a test tenant / business config
 *  3. Routes through the EXACT same pipeline as the real webhook:
 *     think() → handleFlow() → dispatch() intercept
 *  4. Returns the bot's reply as JSON instead of calling Meta API
 *
 * This means ANY bug found in simulation is a real bug — not a test artifact.
 * The simulation is not a mock; it is the real engine with Meta replaced.
 *
 * SECURITY:
 *  - Only active when SIMULATION_MODE=true
 *  - Protected by SIMULATION_SECRET header (x-sim-key)
 *  - Auto-disabled in production unless explicitly re-enabled
 */

import { getSession, createSession, clearSession } from '../services/sessionService.js';
import { think }                                   from '../services/brainService.js';
import { handleFlow, startOrderFlow, startBookingFlow, handleEnquiry } from '../services/flowService.js';
import { buildWelcomeUI, buildSmartFallbackUI }    from '../utils/messageBuilders.js';
import { getAIReply }                               from '../services/aiService.js';
import { getLabel }                                 from '../config/modes.js';
import BusinessConfig                               from '../models/BusinessConfig.js';
import Tenant                                       from '../models/Tenant.js';
import Session                                      from '../models/Session.js';
import UserProfile                                  from '../models/UserProfile.js';
import logger                                       from '../config/logger.js';
import mongoose                                     from 'mongoose';

// ── Conversation history store (in-process, cleared on restart) ───────────────
// For a production-grade test harness you'd persist this, but for local testing
// an in-memory map is sufficient and much simpler.
const _histories = new Map(); // key: `${userId}_${tenantId}` → [{role, content}]

function addToHistory(userId, tenantId, role, content) {
  const key = `${userId}_${tenantId}`;
  const hist = _histories.get(key) || [];
  hist.push({ role, content, ts: new Date().toISOString() });
  // Keep last 40 turns
  if (hist.length > 40) hist.splice(0, hist.length - 40);
  _histories.set(key, hist);
}

function getHistory(userId, tenantId) {
  return _histories.get(`${userId}_${tenantId}`) || [];
}

function clearHistory(userId, tenantId) {
  _histories.delete(`${userId}_${tenantId}`);
}

// ── Message capture (replaces real dispatch) ──────────────────────────────────
// The simulation intercepts messages that would normally go to Meta API.
// We store them here and return them in the response.
const _pendingReplies = new Map(); // key: sessionKey → [ui objects]

export function captureReply(customerPhone, tenantId, uiObject) {
  const key = `${customerPhone}_${tenantId}`;
  const replies = _pendingReplies.get(key) || [];
  replies.push(uiObject);
  _pendingReplies.set(key, replies);
}

function flushReplies(customerPhone, tenantId) {
  const key = `${customerPhone}_${tenantId}`;
  const replies = _pendingReplies.get(key) || [];
  _pendingReplies.delete(key);
  return replies;
}

// ── Tenant lookup / auto-create ───────────────────────────────────────────────
const SIM_TENANT_SUFFIX = '_sim_tenant';

async function getOrCreateSimTenant(businessId) {
  // If businessId is a real MongoDB ObjectId, use it directly
  if (businessId && mongoose.Types.ObjectId.isValid(businessId)) {
    const business = await BusinessConfig.findById(businessId).lean();
    if (business) {
      const tenant = await Tenant.findById(business.tenantId).lean();
      return { business, tenant };
    }
  }

  // Otherwise look up / create a default simulation tenant
  const simEmail = `sim_${businessId || 'default'}@dreamline.local`;
  let tenant = await Tenant.findOne({ email: simEmail });

  if (!tenant) {
    // Create a demo simulation tenant
    const crypto = await import('crypto');
    tenant = await Tenant.create({
      name:      'Simulation Business',
      email:     simEmail,
      apiKey:    crypto.randomBytes(16).toString('hex'),
      status:    'ACTIVE',
      botEnabled: true,
      whatsapp: {
        phone:         '+0000000000',
        phoneNumberId: `sim_${Date.now()}`,
        wabaId:        'sim_waba',
        accessToken:   'sim_token',
      },
    });
    logger.info('[Sim] Created simulation tenant', { id: tenant._id });
  }

  // Find or create business config for this tenant
  let business = await BusinessConfig.findOne({ tenantId: tenant._id });

  if (!business) {
    business = await BusinessConfig.create({
      tenantId:     tenant._id,
      phoneNumberId: tenant.whatsapp?.phoneNumberId,
      name:         'Demo Restaurant',
      description:  'A demonstration restaurant for testing the bot locally.',
      businessMode: 'RESTAURANT',
      mode:         'BOTH',
      menu: [
        { name: 'Jollof Rice',   price: 150, description: 'West African classic with tomato base', available: true },
        { name: 'Grilled Fish',  price: 200, description: 'Fresh catch of the day with spices',   available: true },
        { name: 'Chicken Yassa', price: 180, description: 'Marinated chicken with onion sauce',   available: true },
        { name: 'Domoda',        price: 160, description: 'Groundnut stew with rice',             available: true },
        { name: 'Chapman',       price:  50, description: 'Refreshing fruit cocktail',            available: true },
        { name: 'Soft Drink',    price:  30, description: 'Coke, Fanta or Sprite',                available: true },
      ],
      tone: { style: 'FRIENDLY', industry: 'RESTAURANT' },
    });
    logger.info('[Sim] Created simulation business config', { id: business._id });
  }

  return { business, tenant };
}

// ── Simulate dispatch (instead of calling Meta API) ───────────────────────────
// We monkey-patch by registering a capture callback the message service checks.
// Simpler than mocking the entire axios call chain.
let _simMode = false;
let _lastCapture = null;

export function setSimulationCapture(enabled) { _simMode = enabled; }
export function getLastCapture()               { return _lastCapture; }
export function clearLastCapture()             { _lastCapture = null; }

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER — POST /api/messages
// ═══════════════════════════════════════════════════════════════════════════════
export async function simulateMessage(req, res) {
  const { userId, message, businessId, mediaType } = req.body;

  if (!userId || userId.trim() === '') {
    return res.status(400).json({ error: 'userId is required', hint: 'e.g. "customer_001"' });
  }
  if (!message || message.trim() === '') {
    return res.status(400).json({ error: 'message is required', hint: 'e.g. "I want to order"' });
  }

  const customerPhone = `sim_${userId.replace(/[^a-z0-9]/gi, '_')}`;

  try {
    const { business, tenant } = await getOrCreateSimTenant(businessId);
    const tenantId = tenant._id.toString();

    // Build WhatsApp-like message object
    const waMessage = {
      type: mediaType || 'text',
      text: { body: message.trim() },
      timestamp: Math.floor(Date.now() / 1000).toString(),
    };

    // Get / create session
    let session = await getSession(customerPhone, tenantId);
    const isNew = !session;
    if (!session) {
      session = await createSession(customerPhone, tenantId, {
        phoneNumberId: business.phoneNumberId || tenant.whatsapp?.phoneNumberId,
      });
    }

    // Add to conversation history
    addToHistory(userId, tenantId, 'user', message.trim());

    // ── BRAIN — intent detection ─────────────────────────────────────────────
    let result;
    let botReply = null;

    if (isNew) {
      // First message — always show welcome
      const welcomeUi = buildWelcomeUI(business);
      botReply = uiToText(welcomeUi);
      addToHistory(userId, tenantId, 'assistant', botReply);
      return res.json(formatResponse(userId, message, botReply, welcomeUi, session, 'WELCOME'));
    }

    // Run brain for intent
    const brainResult = await think({
      message: message.trim(),
      session,
      business,
      customerPhone,
      tenantId,
    });

    let uiResult = null;

    // ── FLOW — execute action ────────────────────────────────────────────────
    switch (brainResult.action) {
      case 'WELCOME':
        uiResult = buildWelcomeUI(business);
        break;

      case 'ORDER':
        uiResult = await startOrderFlow({ session, business, customerPhone, tenantId });
        break;

      case 'BOOKING':
        uiResult = await startBookingFlow({ session, business, customerPhone, tenantId });
        break;

      case 'CONTINUE_FLOW':
        uiResult = await handleFlow({ message: message.trim(), session, business, customerPhone, tenantId });
        break;

      case 'ENQUIRY': {
        const aiText = await getAIReply({
          customerMessage: message.trim(),
          business,
          session,
          intent: 'ENQUIRY',
          history: getHistory(userId, tenantId).slice(0, -1).map(h => ({ role: h.role, content: h.content })),
        });
        uiResult = { type: 'text', body: aiText };
        break;
      }

      case 'SHOW_MENU': {
        const { buildMenuUI, buildServicesUI } = await import('../utils/messageBuilders.js');
        const cfg = (await import('../config/modes.js')).getModeConfig(business);
        if (cfg.flows.includes('ORDER') && business.menu?.length > 0) {
          uiResult = buildMenuUI(business);
        } else if (cfg.flows.includes('BOOKING') && business.services?.length > 0) {
          uiResult = buildServicesUI(business);
        } else {
          uiResult = buildWelcomeUI(business);
        }
        break;
      }

      case 'CANCEL': {
        const { buildCancelUI } = await import('../utils/messageBuilders.js');
        uiResult = buildCancelUI(business);
        await clearSession(customerPhone, tenantId);
        break;
      }

      case 'FALLBACK':
      default: {
        // Try AI for natural conversation
        const aiText = await getAIReply({
          customerMessage: message.trim(),
          business,
          session,
          intent: 'FALLBACK',
          history: getHistory(userId, tenantId).slice(0, -1).map(h => ({ role: h.role, content: h.content })),
        });
        uiResult = aiText ? { type: 'text', body: aiText } : buildSmartFallbackUI(business, session);
        break;
      }
    }

    const text = uiToText(uiResult);
    addToHistory(userId, tenantId, 'assistant', text);

    return res.json(formatResponse(userId, message, text, uiResult, session, brainResult.action));

  } catch (err) {
    logger.error('[Sim] simulateMessage error', { err: err.message, stack: err.stack });
    return res.status(500).json({
      error:   'Simulation engine error',
      message: err.message,
      hint:    'Check server logs for stack trace',
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/session — inspect current session
// ═══════════════════════════════════════════════════════════════════════════════
export async function getSimSession(req, res) {
  const { userId, businessId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId query param required' });

  const customerPhone = `sim_${userId.replace(/[^a-z0-9]/gi, '_')}`;

  try {
    const { tenant } = await getOrCreateSimTenant(businessId);
    const session = await getSession(customerPhone, tenant._id.toString());
    const history = getHistory(userId, tenant._id.toString());

    res.json({
      userId,
      customerPhone,
      session: session || null,
      historyLength: history.length,
      history,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/session — clear session
// ═══════════════════════════════════════════════════════════════════════════════
export async function clearSimSession(req, res) {
  const { userId, businessId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const customerPhone = `sim_${userId.replace(/[^a-z0-9]/gi, '_')}`;

  try {
    const { tenant } = await getOrCreateSimTenant(businessId);
    await clearSession(customerPhone, tenant._id.toString());
    clearHistory(userId, tenant._id.toString());
    res.json({ success: true, message: `Session cleared for ${userId}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/history — get conversation history
// ═══════════════════════════════════════════════════════════════════════════════
export async function getSimHistory(req, res) {
  const { userId, businessId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId query param required' });

  try {
    const { tenant } = await getOrCreateSimTenant(businessId);
    const history = getHistory(userId, tenant._id.toString());
    res.json({ userId, turns: history.length, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/businesses — list available businesses for testing
// ═══════════════════════════════════════════════════════════════════════════════
export async function listSimBusinesses(req, res) {
  try {
    const businesses = await BusinessConfig.find({})
      .select('_id name businessMode mode menu services')
      .lean();

    res.json({
      count: businesses.length,
      businesses: businesses.map(b => ({
        id:      b._id,
        name:    b.name,
        mode:    b.businessMode,
        legacy:  b.mode,
        menuItems:    b.menu?.length || 0,
        serviceItems: b.services?.length || 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/reset — full reset for a user
// ═══════════════════════════════════════════════════════════════════════════════
export async function resetSimUser(req, res) {
  const { userId, businessId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const customerPhone = `sim_${userId.replace(/[^a-z0-9]/gi, '_')}`;

  try {
    const { tenant } = await getOrCreateSimTenant(businessId);
    const tenantId = tenant._id.toString();

    await clearSession(customerPhone, tenantId);
    clearHistory(userId, tenantId);

    // Also clear UserProfile for a truly clean slate
    await UserProfile.deleteOne({ phone: customerPhone, tenantId });

    res.json({ success: true, message: `Full reset for ${userId} — session, history, and profile cleared` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uiToText(ui) {
  if (!ui) return 'Sorry, something went wrong. Please try again.';
  if (typeof ui === 'string') return ui;

  let text = ui.body || ui.text || '';
  if (ui.header) text = `*${ui.header}*\n\n${text}`;

  if (ui.type === 'buttons' && ui.buttons?.length > 0) {
    text += '\n\n' + ui.buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
  } else if (ui.type === 'list' && ui.rows?.length > 0) {
    text += '\n\n' + ui.rows.map((r, i) => `${i + 1}. ${r.title}${r.description ? ` — ${r.description}` : ''}`).join('\n');
  }

  if (ui.footer) text += `\n\n_${ui.footer}_`;
  return text.trim();
}

function formatResponse(userId, input, replyText, uiObject, session, action) {
  return {
    userId,
    input,
    reply: replyText,
    ui: uiObject,
    meta: {
      action,
      flow:    session?.currentFlow || null,
      step:    session?.step        || null,
      intent:  action,
      timestamp: new Date().toISOString(),
    },
  };
}
