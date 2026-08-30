/**
 * services/leadCaptureService.js
 *
 * [FIX-BUG6] notifyAdmin flag is now honoured — when business.leadCapture.notifyAdmin=true
 *            the admin receives a WhatsApp message for every new lead captured.
 *            Previously the flag was stored but never checked here.
 * [FIX]      LEAD_SKIP button ID accepted at all steps (no typing "skip" required).
 * [FIX]      finaliseLead returns welcome buttons from mode config.
 */

import { updateSession, getSession } from '../../core/sessions/sessionService.js';
import { updateName }                from '../../core/memory/customerMemory.js';
import UserProfile from '../../models/UserProfile.js';
import Tenant      from '../../models/Tenant.js';
import mongoose    from 'mongoose';
import logger      from '../../config/logger.js';

const toOid = (id) => {
  if (!id) return id;
  if (id instanceof mongoose.Types.ObjectId) return id;
  try { return new mongoose.Types.ObjectId(String(id)); } catch { return id; }
}

// [FIX-NAME-7] Shared name validation — same rules as extractCustomerName in intentEngine.
// Keeps name-quality logic in one conceptual place.
// Returns the trimmed name if valid, null otherwise.
const NAME_NOISE = new Set([
  'hi','hey','hello','hiya','yo','ok','okay','sure','yes','no','nope',
  'thanks','thank','fine','done','good','great','nice','ready','here',
  'home','work','busy','free','waiting','coming','hungry','back','soon',
  'now','out','away','test','hhhh','lol','haha','hihi','hehe','aaaa',
]);
const validateCapturedName = (raw) => {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (!/^[a-zA-Z\s]+$/.test(cleaned)) return null;        // letters only
  if (NAME_NOISE.has(cleaned.toLowerCase())) return null;  // whole-name blocklist
  const words = cleaned.split(/\s+/);
  const valid  = words.every(w => {
    if (w.length < 3) return false;                        // min 3 chars per word
    if (!/[aeiou]/i.test(w)) return false;                 // must have a vowel
    if (NAME_NOISE.has(w.toLowerCase())) return false;     // per-word blocklist
    const freq = {};
    for (const c of w.toLowerCase()) freq[c] = (freq[c] || 0) + 1;
    if (Object.values(freq).some(v => v / w.length > 0.5)) return false; // repeated chars
    return true;
  });
  if (!valid) return null;
  if (cleaned.length < 3 || cleaned.length > 40) return null;
  return cleaned;
}

export async function shouldCaptureLead(business, session, trigger) {
  const cfg = business?.leadCapture;
  if (!cfg?.enabled) return false;
  if (cfg.triggerOn !== trigger) return false;
  if (session?.data?.leadCaptured) return false;
  try {
    const prof = await UserProfile.findOne({ phone: session.customerPhone, tenantId: toOid(session.tenantId) }).lean();
    if (prof?.lead?.capturedAt) return false;
  } catch { /* non-fatal */ }
  return true;
}

export async function startLeadCapture(session, business) {
  const cfg    = business?.leadCapture || {};
  const fields = cfg.fields?.length ? cfg.fields : ['name', 'email'];

  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'LEAD_CAPTURE',
    step:        'CAPTURE_NAME',
    postFlowAck: null,
    data:        { leadFields: fields, leadData: {} },
  });

  const bizName = business?.name || 'us';
  return {
    type:    'buttons',
    body:    cfg.promptMessage?.trim() ||
      `👋 One quick thing — may I have your *name*? This helps us serve you better at *${bizName}*.`,
    buttons: [{ id: 'LEAD_SKIP', title: '⏭ Skip' }],
  };
}

export async function handleLeadCapture(session, message, business, tenantDoc) {
  const raw    = String(message || '').trim();
  const skip   = /^(skip|no|nope|later|cancel|stop|lead_skip)$/i.test(raw);
  const step   = session.step || 'CAPTURE_NAME';
  const data   = session.data  || {};
  const fields = data.leadFields || ['name', 'email'];
  const lead   = data.leadData   || {};

  if (step === 'CAPTURE_NAME') {
    // [FIX-NAME-7] Validate the name before storing it.
    // Previously raw.slice(0, 60) was stored unconditionally — so a customer typing
    // "hi", "ok", "yes", or any short reply at the name prompt would be persisted
    // as their name and later appear in "You're welcome, Hi!" responses.
    // Now the name is validated with the same rules as extractCustomerName:
    // alphabetic only, min 3 chars per word, must have a vowel, not a noise word.
    const rawName = skip ? null : raw.trim().slice(0, 60);
    const name    = rawName ? validateCapturedName(rawName) : null;

    // If they sent something but it failed validation, ask again politely
    if (rawName && !name && !skip) {
      return {
        type:    'buttons',
        body:    `Sorry, I didn't catch a name there. Could you tell me your name? (e.g. "Lamin" or "Fatou")`,
        buttons: [{ id: 'LEAD_SKIP', title: '⏭ Skip' }],
      };
    }

    if (name) {
      await updateSession(session.customerPhone, session.tenantId, { customerName: name });
      updateName(session.customerPhone, session.tenantId, name).catch(() => {});
    }

    const needsEmail = fields.includes('email');
    if (needsEmail && !skip) {
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CAPTURE_EMAIL', data: { ...data, leadData: { ...lead, name } },
      });
      return {
        type:    'buttons',
        body:    `Thanks, *${name}*! 😊\n\nWhat's your *email address*? (optional)`,
        buttons: [{ id: 'LEAD_SKIP', title: '⏭ Skip' }],
      };
    }
    return finaliseLead({ session, lead: { ...lead, name }, business, tenantDoc });
  }

  if (step === 'CAPTURE_EMAIL') {
    const email = skip ? null : raw.toLowerCase().slice(0, 100);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return {
        type:    'buttons',
        body:    `That doesn't look like a valid email. Please try again, or tap Skip.`,
        buttons: [{ id: 'LEAD_SKIP', title: '⏭ Skip' }],
      };
    }
    return finaliseLead({ session, lead: { ...lead, email }, business, tenantDoc });
  }

  return finaliseLead({ session, lead, business, tenantDoc });
}

async function finaliseLead({ session, lead, business, tenantDoc }) {
  const bizName = business?.name || 'us';

  try {
    await UserProfile.findOneAndUpdate(
      { phone: session.customerPhone, tenantId: toOid(session.tenantId) },
      {
        $set: {
          'lead.name':       lead.name       || null,
          'lead.email':      lead.email      || null,
          'lead.capturedAt': new Date(),
          'lead.source':     'whatsapp',
          'lead.tenantId':   session.tenantId,
          'lead.captured':   true,
        },
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    logger.error('[LeadCapture] UserProfile update failed', { err: err.message });
  }

  // [FIX-BUG6] notifyAdmin — send admin a WhatsApp message when a new lead is captured
  const cfg = business?.leadCapture || {};
  if (cfg.notifyAdmin && tenantDoc) {
    try {
      const adminPhone = business?.adminPhone || tenantDoc?.adminPhone;
      if (adminPhone) {
        const { dispatchText } = await import('../core/whatsapp/dispatcher.js');
        const nameStr  = lead.name  ? `\n👤 Name: *${lead.name}*`    : '';
        const emailStr = lead.email ? `\n📧 Email: *${lead.email}*`   : '';
        dispatchText(
          adminPhone,
          `🎯 *New Lead Captured — ${bizName}*\n\n` +
          `📱 Phone: *${session.customerPhone}*${nameStr}${emailStr}\n\n` +
          `Source: WhatsApp bot`,
          tenantDoc
        ).catch(() => {});
      }
    } catch (err) {
      logger.warn('[LeadCapture] Admin notification failed (non-fatal)', { err: err.message });
    }
  }

  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: null, step: null, data: { leadCaptured: true }, postFlowAck: null, postFlowData: null,
  });

  const { getModeConfig } = await import('../config/modes.js');
  const { buildOptionsReply } = await import('../core/shared/uiOptionsHelper.js');
  const modeCfg = getModeConfig(business);

  const thankYou = cfg.thankYouMsg || `✅ All set! We'll remember you next time at *${bizName}*. 😊`;
  return buildOptionsReply(modeCfg, thankYou);
}
