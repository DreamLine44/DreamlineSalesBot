/**
 * services/leadCaptureService.js — Dreamline Sales Bot v8.0
 *
 * AI Lead Capture — collects name, contact, and interest from new customers.
 *
 * Flows triggered by:
 *   - FIRST_MESSAGE (before bot interaction)
 *   - AFTER_ORDER   (after order confirmation)
 *   - AFTER_BOOKING (after booking confirmation)
 *   - MANUAL        (triggered via /business/lead-trigger API)
 *
 * Captured data is stored in UserProfile + optionally sent to admin via WhatsApp.
 *
 * Steps: CAPTURE_NAME → CAPTURE_EMAIL → CAPTURE_INTEREST → LEAD_CONFIRM
 */

import UserProfile    from '../models/UserProfile.js';
import BusinessConfig from '../models/BusinessConfig.js';
import Session        from '../models/Session.js';
import { updateSession, clearSession } from './sessionService.js';
import { dispatch }   from './messageService.js';
import logger         from '../config/logger.js';

// ─── Should we capture a lead for this customer? ─────────────────────────────

export async function shouldCaptureLead(business, session, trigger = 'FIRST_MESSAGE') {
  const cfg = business?.leadCapture;
  if (!cfg?.enabled) return false;
  if (cfg.triggerOn !== trigger) return false;

  // Don't re-capture if we already have this customer's lead
  const existing = await UserProfile.findOne({ phone: session.customerPhone });
  if (existing?.lead?.captured) return false;

  return true;
}

// ─── Start lead capture flow ──────────────────────────────────────────────────

export async function startLeadCapture(session, business) {
  const cfg  = business?.leadCapture;
  const name = business?.name || 'us';

  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'LEAD_CAPTURE',
    step:        'CAPTURE_NAME',
    data:        { leadFields: cfg?.fields || ['name', 'email'] },
  });

  return {
    type: 'text',
    body: cfg?.promptMessage?.trim() ||
      `👋 Welcome to *${name}*!\n\nBefore we get started, may I have your *name*? This helps us serve you better. 😊\n\n_(Type *skip* to continue without sharing)_`,
  };
}

// ─── Handle lead capture flow steps ──────────────────────────────────────────

export async function handleLeadCapture(session, message, business, tenantDoc) {
  const clean = message.trim();
  const skip  = ['skip', 'no', 'nope', 'later'].includes(clean.toLowerCase());

  switch (session.step) {

    case 'CAPTURE_NAME': {
      if (!skip && clean.length >= 2) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'CAPTURE_EMAIL',
          data: { ...session.data, leadName: clean },
        });
        return {
          type: 'text',
          body: `Nice to meet you, *${clean}*! 😊\n\nCould you share your *email or phone number* so we can send you updates?\n\n_(Type *skip* to continue)_`,
        };
      }
      // Skipped name
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CAPTURE_EMAIL',
        data: { ...session.data, leadName: null },
      });
      return {
        type: 'text',
        body: `No problem! Could you share your *email or phone number* for updates?\n\n_(Type *skip* to continue)_`,
      };
    }

    case 'CAPTURE_EMAIL': {
      const contact = skip ? null : clean;
      const fields  = session.data?.leadFields || ['name', 'email'];

      if (!fields.includes('interest')) {
        // Skip interest step — go straight to confirm
        return await finalizeLead(session, business, tenantDoc, { contact });
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CAPTURE_INTEREST',
        data: { ...session.data, leadContact: contact },
      });
      return {
        type: 'text',
        body: `Great! Last question — what are you most interested in?\n\n(e.g. "food delivery", "skincare products", "phone repair")\n\n_(Type *skip* to continue)_`,
      };
    }

    case 'CAPTURE_INTEREST': {
      const interest = skip ? null : clean;
      return await finalizeLead(session, business, tenantDoc, { interest });
    }

    default:
      return await finalizeLead(session, business, tenantDoc, {});
  }
}

// ─── Finalize and save lead ───────────────────────────────────────────────────

async function finalizeLead(session, business, tenantDoc, extra = {}) {
  const data    = { ...session.data, ...extra };
  const phone   = session.customerPhone;
  const name    = data.leadName    || null;
  const contact = data.leadContact || null;
  const interest= data.interest    || null;

  // Save to UserProfile
  try {
    await UserProfile.findOneAndUpdate(
      { phone },
      {
        $set: {
          'lead.captured':  true,
          'lead.name':      name,
          'lead.contact':   contact,
          'lead.interest':  interest,
          'lead.capturedAt': new Date(),
          'activity.lastSeen': new Date(),
        },
        $setOnInsert: { phone },
      },
      { upsert: true, new: true },
    );
    logger.info('[LeadCapture] Lead saved', { phone, name, contact, interest });
  } catch (err) {
    logger.warn('[LeadCapture] Failed to save lead', { phone, err: err.message });
  }

  // Notify admin if configured
  const cfg = business?.leadCapture;
  if (cfg?.notifyAdmin && tenantDoc?.adminPhone) {
    const adminMsg =
      `🎯 *New Lead Captured!*\n\n` +
      `📱 Phone: *${phone}*\n` +
      (name    ? `👤 Name: *${name}*\n`      : '') +
      (contact ? `📧 Contact: *${contact}*\n` : '') +
      (interest? `💡 Interest: *${interest}*\n` : '') +
      `\n_Via Dreamline Sales Bot_`;
    dispatch(tenantDoc.adminPhone, { type: 'text', body: adminMsg }, tenantDoc)
      .catch(e => logger.warn('[LeadCapture] Admin notify failed', { err: e.message }));
  }

  // Clear lead flow — resume normal bot interaction
  await updateSession(phone, session.tenantId, {
    currentFlow: null,
    step:        null,
    data:        {},
  });

  const thankYou = cfg?.thankYouMsg?.trim() ||
    `✅ Thank you! We'll keep you in the loop. 😊\n\nNow, how can we help you today?`;

  return { type: 'text', body: thankYou };
}

// ─── Get all leads for a tenant (for dashboard) ───────────────────────────────

export async function getLeadsForTenant(tenantId) {
  // UserProfile has no tenantId field — scope leads by looking up which phone numbers
  // have ever had a session for this tenant, then return matching UserProfile leads.
  // This correctly prevents tenant A from seeing tenant B's captured leads.
  const tenantSessions = await Session.find(
    { tenantId: String(tenantId) },
    { customerPhone: 1, _id: 0 },
  ).lean();

  const phones = [...new Set(tenantSessions.map(s => s.customerPhone).filter(Boolean))];
  if (!phones.length) return [];

  const leads = await UserProfile.find(
    { phone: { $in: phones }, 'lead.captured': true },
    { phone: 1, lead: 1, 'activity.lastSeen': 1, _id: 0 },
  ).sort({ 'lead.capturedAt': -1 }).limit(500);

  return leads;
}
