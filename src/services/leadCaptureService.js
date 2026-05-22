/**
 * services/leadCaptureService.js — WhatSalesAgent2
 *
 * Collects customer name/email/phone after order or booking completion.
 *
 * Trigger points: AFTER_ORDER · AFTER_BOOKING · FIRST_MESSAGE
 *
 * [FIX] clearSession is no longer called before startLeadCapture.
 *       In v28, clearSession destroyed the session then updateSession
 *       inside startLeadCapture wrote to a non-existent doc (no upsert).
 *       Now flowEngine.completeFlow() keeps the session alive with
 *       postFlowAck set, and lead capture updates it without issue.
 */

import { updateSession, getSession } from '../core/sessions/sessionService.js';
import UserProfile from '../models/UserProfile.js';
import logger      from '../config/logger.js';

/**
 * shouldCaptureLead(business, session, trigger)
 * Returns true when lead capture is configured for this trigger and not yet captured.
 */
export async function shouldCaptureLead(business, session, trigger) {
  const cfg = business?.leadCapture;
  if (!cfg?.enabled) return false;
  if (cfg.triggerOn !== trigger) return false;

  // Don't re-capture if already done
  if (session?.data?.leadCaptured) return false;

  // Check UserProfile
  try {
    const prof = await UserProfile.findOne({ phone: session.customerPhone, tenantId: session.tenantId }).lean();
    if (prof?.lead?.capturedAt) return false;
  } catch { /* non-fatal */ }

  return true;
}

/**
 * startLeadCapture(session, business)
 * Updates the session to begin lead capture flow.
 * Safe to call after completeFlow() because session row is still alive.
 */
export async function startLeadCapture(session, business) {
  const cfg    = business?.leadCapture || {};
  const fields = cfg.fields?.length ? cfg.fields : ['name', 'email'];

  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'LEAD_CAPTURE',
    step:        'CAPTURE_NAME',
    postFlowAck: null, // lead capture takes over
    data:        { leadFields: fields, leadData: {} },
  });

  const bizName = business?.name || 'us';
  return {
    type: 'text',
    body: cfg.promptMessage?.trim() ||
      `👋 One quick thing — may I have your *name*? This helps us serve you better at *${bizName}*.\n\n_(Type *skip* to continue without sharing)_`,
  };
}

/**
 * handleLeadCapture(session, message, business, tenantDoc)
 * Advances the lead capture flow step by step.
 */
export async function handleLeadCapture(session, message, business, tenantDoc) {
  const raw    = String(message || '').trim();
  const skip   = /^(skip|no|nope|later|cancel|stop)$/i.test(raw);
  const step   = session.step || 'CAPTURE_NAME';
  const data   = session.data || {};
  const fields = data.leadFields || ['name', 'email'];
  const lead   = data.leadData   || {};
  const bizName= business?.name  || 'us';

  if (step === 'CAPTURE_NAME') {
    const name = skip ? null : raw.slice(0, 60);
    if (name) {
      // Persist name to session for personalisation
      await updateSession(session.customerPhone, session.tenantId, { customerName: name });
    }

    // Determine next field
    const needsEmail = fields.includes('email');
    if (needsEmail && !skip) {
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CAPTURE_EMAIL', data: { ...data, leadData: { ...lead, name } },
      });
      return { type: 'text', body: `Thanks, *${name}*! 😊\n\nWhat's your *email address*? (or type *skip*)` };
    }

    // Done
    return finaliseLead({ session, lead: { ...lead, name }, business, tenantDoc });
  }

  if (step === 'CAPTURE_EMAIL') {
    const email = skip ? null : raw.toLowerCase().slice(0, 100);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { type: 'text', body: `That doesn't look like a valid email. Please try again, or type *skip*.` };
    }
    return finaliseLead({ session, lead: { ...lead, email }, business, tenantDoc });
  }

  // Unknown step — complete anyway
  return finaliseLead({ session, lead, business, tenantDoc });
}

async function finaliseLead({ session, lead, business, tenantDoc }) {
  const bizName = business?.name || 'us';

  // Persist to UserProfile
  try {
    await UserProfile.findOneAndUpdate(
      { phone: session.customerPhone, tenantId: session.tenantId },
      {
        $set: {
          'lead.name':        lead.name  || null,
          'lead.email':       lead.email || null,
          'lead.capturedAt':  new Date(),
          'lead.source':      'whatsapp',
        },
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    logger.error('[LeadCapture] UserProfile update failed', { err: err.message });
  }

  // Notify admin if configured
  const adminPhone = business?.adminPhone;
  if (adminPhone && business?.leadCapture?.notifyAdmin && tenantDoc) {
    const { dispatchText } = await import('../core/whatsapp/dispatcher.js');
    dispatchText(adminPhone,
      `📋 *New Lead Captured*\n\n` +
      `👤 Name: ${lead.name  || 'not provided'}\n` +
      `📧 Email: ${lead.email || 'not provided'}\n` +
      `📱 Phone: ${session.customerPhone}\n` +
      `🏢 Business: ${bizName}`,
      tenantDoc).catch(() => {});
  }

  // Reset flow
  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: null, step: null, data: { leadCaptured: true },
  });

  const { getModeConfig } = await import('../config/modes.js');
  const cfg = getModeConfig(business);

  return {
    type:    'buttons',
    body:    `✅ All set! We'll remember you next time at *${bizName}*. 😊`,
    buttons: cfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🏠 Main Menu' }],
  };
}
