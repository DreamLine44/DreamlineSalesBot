/**
 * services/whatsappNotificationService.js
 *
 * Sends in-app (console / logger) and optionally WhatsApp notifications
 * when an onboarding request status changes.
 *
 * Design decisions:
 *  - All notification calls are fire-and-forget with try/catch.
 *    A notification failure must NEVER block or roll back the main operation.
 *  - In Phase 1 (no Meta Embedded Signup), notifications are logged and
 *    optionally sent via email (stub). WhatsApp notifications to the tenant
 *    are sent only once the tenant is actually CONNECTED.
 *  - The module does NOT import the main dispatcher or flow engine,
 *    preserving full isolation from the bot.
 */
import logger from '../config/logger.js';

// ── Status message templates ─────────────────────────────────────────────────

const STATUS_MESSAGES = {
  pending: {
    subject: 'WhatsApp Connection Request Received',
    body: (req) =>
      `Hi ${req.contactPerson},\n\nWe have received your WhatsApp connection request for *${req.businessName}*.\n\nOur team will review it shortly and get in touch with you at ${req.contactEmail}.\n\nRequest reference: ${req._id}\n\nThank you!`,
  },
  contacted: {
    subject: 'WhatsApp Onboarding — Team Will Contact You',
    body: (req) =>
      `Hi ${req.contactPerson},\n\nOur team has reviewed your request for *${req.businessName}* and will be in touch at *${req.contactEmail}* to guide you through the next steps.\n\nRequest reference: ${req._id}`,
  },
  connecting: {
    subject: 'WhatsApp Onboarding — Configuration In Progress',
    body: (req) =>
      `Hi ${req.contactPerson},\n\nGreat news! We are now configuring your WhatsApp Business account for *${req.businessName}*.\n\nYou will be notified once the connection is live.\n\nRequest reference: ${req._id}`,
  },
  connected: {
    subject: '🎉 WhatsApp Connected Successfully!',
    body: (req) =>
      `Hi ${req.contactPerson},\n\n*${req.businessName}* is now connected to WhatsApp Business!\n\nYour AI-powered assistant is live and ready to handle customer conversations.\n\nRequest reference: ${req._id}\n\nWelcome to WhatSales! 🚀`,
  },
  rejected: {
    subject: 'WhatsApp Connection Request — Update',
    body: (req, adminNotes) =>
      `Hi ${req.contactPerson},\n\nUnfortunately we were unable to process the WhatsApp connection request for *${req.businessName}* at this time.${adminNotes ? `\n\nReason: ${adminNotes}` : ''}\n\nPlease contact our support team for assistance.\n\nRequest reference: ${req._id}`,
  },
};

// ── Core notification dispatcher ─────────────────────────────────────────────

/**
 * notifyStatusChange
 *
 * Called whenever a connection request status changes.
 * Currently logs a structured notification. Plug in email / WhatsApp
 * send logic here when ready.
 *
 * @param {object} connectionRequest  - Mongoose document (or plain object)
 * @param {string} newStatus          - The status being transitioned to
 * @param {string} [adminNotes]       - Optional admin notes (shown on rejection)
 */
export async function notifyStatusChange(connectionRequest, newStatus, adminNotes = '') {
  try {
    const template = STATUS_MESSAGES[newStatus];
    if (!template) {
      logger.warn('[OnboardingNotify] No template for status', { status: newStatus });
      return;
    }

    const messageBody = template.body(connectionRequest, adminNotes);

    // ── Structured log (always) ───────────────────────────────────────────
    logger.info('[OnboardingNotify] Status change notification', {
      requestId:     String(connectionRequest._id),
      tenantId:      String(connectionRequest.tenantId),
      businessName:  connectionRequest.businessName,
      contactEmail:  connectionRequest.contactEmail,
      newStatus,
      subject:       template.subject,
    });

    // ── Email stub ────────────────────────────────────────────────────────
    // TODO: Replace with your email provider (SendGrid, Mailgun, SES, etc.)
    // Example:
    // await emailService.send({
    //   to:      connectionRequest.contactEmail,
    //   subject: template.subject,
    //   text:    messageBody,
    // });

    // ── Development preview ───────────────────────────────────────────────
    if (process.env.NODE_ENV !== 'production') {
      logger.info('[OnboardingNotify] [DEV] Email preview', {
        to:      connectionRequest.contactEmail,
        subject: template.subject,
        body:    messageBody,
      });
    }

  } catch (err) {
    // Fire-and-forget: notification failure must never surface to the caller
    logger.error('[OnboardingNotify] Failed to send notification (non-fatal)', {
      err:       err.message,
      requestId: String(connectionRequest._id),
      status:    newStatus,
    });
  }
}

/**
 * notifyAdminNewRequest
 *
 * Alerts super-admins when a new connection request is submitted.
 *
 * @param {object} connectionRequest - The newly created request document
 */
export async function notifyAdminNewRequest(connectionRequest) {
  try {
    logger.info('[OnboardingNotify] New connection request — admin alert', {
      requestId:    String(connectionRequest._id),
      tenantId:     String(connectionRequest.tenantId),
      businessName: connectionRequest.businessName,
      contactEmail: connectionRequest.contactEmail,
      submittedAt:  connectionRequest.createdAt,
    });

    // TODO: Send alert to super-admin email / Slack / webhook
    // const adminEmail = process.env.SUPER_ADMIN_EMAIL;
    // if (adminEmail) {
    //   await emailService.send({
    //     to:      adminEmail,
    //     subject: `[WhatSales] New WhatsApp Connection Request — ${connectionRequest.businessName}`,
    //     text:    `A new connection request was submitted by ${connectionRequest.contactEmail}.\n\nBusiness: ${connectionRequest.businessName}\nNumber: ${connectionRequest.whatsappNumber}\nRequest ID: ${connectionRequest._id}`,
    //   });
    // }

  } catch (err) {
    logger.error('[OnboardingNotify] Admin alert failed (non-fatal)', { err: err.message });
  }
}
