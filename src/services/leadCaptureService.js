/**
 * services/leadCaptureService.js
 *
 * [FIX-BUG6] notifyAdmin flag is now honoured — when business.leadCapture.notifyAdmin=true
 *            the admin receives a WhatsApp message for every new lead captured.
 *            Previously the flag was stored but never checked here.
 * [FIX]      LEAD_SKIP button ID accepted at all steps (no typing "skip" required).
 * [FIX]      finaliseLead returns welcome buttons from mode config.
 */

import { updateSession, getSession } from '../core/sessions/sessionService.js';
import { updateName }                from '../core/memory/customerMemory.js';
import UserProfile from '../models/UserProfile.js';
import Tenant      from '../models/Tenant.js';
import logger      from '../config/logger.js';

export async function shouldCaptureLead(business, session, trigger) {
  const cfg = business?.leadCapture;
  if (!cfg?.enabled) return false;
  if (cfg.triggerOn !== trigger) return false;
  if (session?.data?.leadCaptured) return false;
  try {
    const prof = await UserProfile.findOne({ phone: session.customerPhone, tenantId: session.tenantId }).lean();
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
    const name = skip ? null : raw.slice(0, 60);
    if (name) {
      await updateSession(session.customerPhone, session.tenantId, { customerName: name });
      // [FIX-BUG5] Update persistent memory
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
      { phone: session.customerPhone, tenantId: session.tenantId },
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
    currentFlow: null, step: null, data: { leadCaptured: true },
  });

  const { getModeConfig } = await import('../config/modes.js');
  const modeCfg = getModeConfig(business);

  const thankYou = cfg.thankYouMsg || `✅ All set! We'll remember you next time at *${bizName}*. 😊`;
  return {
    type:    'buttons',
    body:    thankYou,
    buttons: modeCfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🏠 Main Menu' }],
  };
}
