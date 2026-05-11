/**
 * services/templateService.js — Dreamline Sales Bot v11.0
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  WHATSAPP TEMPLATE MESSAGE SERVICE                              ║
 * ║                                                                 ║
 * ║  Solves the 24-hour session window problem.                     ║
 * ║  After 24h of inactivity, WhatsApp only allows pre-approved     ║
 * ║  template messages. Free-form messages will be rejected.        ║
 * ║                                                                 ║
 * ║  Templates supported:                                           ║
 * ║  - abandoned_cart    : follow up on incomplete orders           ║
 * ║  - order_confirmed   : order confirmation (post-session)        ║
 * ║  - booking_reminder  : appointment reminder day before          ║
 * ║  - payment_reminder  : remind customer to send payment proof    ║
 * ║  - reengagement      : generic "we miss you" re-engagement      ║
 * ║                                                                 ║
 * ║  RULES:                                                         ║
 * ║  ✅ Always falls back to free-form within the 24h window        ║
 * ║  ✅ Templates respect tenant credentials (per-tenant token)     ║
 * ║  ✅ Fails silently — never blocks core flow                     ║
 * ║  ✅ All sends logged with outcome                               ║
 * ║                                                                 ║
 * ║  SETUP:                                                         ║
 * ║  Register templates in Meta Business Manager first.            ║
 * ║  Set TEMPLATE_NAMESPACE env var to your Meta template namespace.║
 * ║  See INTEGRATION_GUIDE.md §Templates for registration steps.   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import axios  from 'axios';
import Tenant from '../models/Tenant.js';
import logger from '../config/logger.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const FALLBACK_API_VERSION  = process.env.WA_API_VERSION  || 'v21.0';
const TEMPLATE_LANGUAGE     = process.env.TEMPLATE_LANGUAGE || 'en_US';

// ─── Template definitions ─────────────────────────────────────────────────────
//
// Each entry maps a logical name to the Meta-registered template name + component
// builder. Component builders accept business-specific variables and return the
// `components` array required by the WhatsApp template API.
//
// Template variables MUST match exactly what was approved in Meta Business Manager.
// Parameter order matters — {{1}} = first param, {{2}} = second, etc.
//
// IMPORTANT: Template names below are examples. Replace with your actual registered
// template names from Meta Business Manager before going live.

const TEMPLATE_DEFINITIONS = {

  // Sent ~1h after a session expires with an incomplete order
  abandoned_cart: {
    name: 'dreamline_abandoned_cart',
    language: TEMPLATE_LANGUAGE,
    // Template body (register in Meta):
    // "Hi {{1}}! You left some items in your cart at {{2}}. 🛒
    //  Come back and complete your order — we saved it for you!"
    buildComponents: ({ customerName = 'there', businessName = 'us' }) => ([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: customerName  },
          { type: 'text', text: businessName  },
        ],
      },
    ]),
  },

  // Sent after order is confirmed by admin payment approval
  order_confirmed: {
    name: 'dreamline_order_confirmed',
    language: TEMPLATE_LANGUAGE,
    // "Your order ({{1}}) has been confirmed! ✅ We'll have it ready soon."
    buildComponents: ({ orderSummary = 'your order' }) => ([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: orderSummary },
        ],
      },
    ]),
  },

  // Sent the evening before a booking appointment
  booking_reminder: {
    name: 'dreamline_booking_reminder',
    language: TEMPLATE_LANGUAGE,
    // "Reminder: You have a booking at {{1}} tomorrow at {{2}}. 📅
    //  Reply *Hi* to manage your booking."
    buildComponents: ({ businessName = 'us', bookingTime = 'your scheduled time' }) => ([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: businessName },
          { type: 'text', text: bookingTime  },
        ],
      },
    ]),
  },

  // Sent if payment proof hasn't arrived within 30 minutes of order placement
  payment_reminder: {
    name: 'dreamline_payment_reminder',
    language: TEMPLATE_LANGUAGE,
    // "Hi! Your order at {{1}} is waiting for payment confirmation. 💳
    //  Please send your Wave payment screenshot to complete your order."
    buildComponents: ({ businessName = 'us' }) => ([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: businessName },
        ],
      },
    ]),
  },

  // Generic re-engagement for cold customers
  reengagement: {
    name: 'dreamline_reengagement',
    language: TEMPLATE_LANGUAGE,
    // "Hi {{1}}! We miss you at {{2}}. 👋 Come back and see what's new!"
    buildComponents: ({ customerName = 'there', businessName = 'us' }) => ([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: customerName },
          { type: 'text', text: businessName },
        ],
      },
    ]),
  },

};

// ─── Core send function ───────────────────────────────────────────────────────

/**
 * Send a WhatsApp template message to a customer.
 *
 * @param {object} params
 * @param {string}  params.to           - Recipient phone (E.164 without +)
 * @param {string}  params.templateName - Key from TEMPLATE_DEFINITIONS
 * @param {object}  params.variables    - Variables passed to buildComponents()
 * @param {object}  params.tenant       - Tenant document (for credentials)
 * @returns {Promise<boolean>}          - true if sent, false if failed
 */
export async function sendTemplate({ to, templateName, variables = {}, tenant }) {
  const def = TEMPLATE_DEFINITIONS[templateName];
  if (!def) {
    logger.warn(`[TemplateService] Unknown template: ${templateName}`);
    return false;
  }

  if (!tenant) {
    logger.warn(`[TemplateService] No tenant provided for template ${templateName}`);
    return false;
  }

  const phoneNumberId = tenant?.whatsapp?.phoneNumberId || tenant?.phoneNumberId;
  const accessToken   = tenant?.whatsapp?.accessToken   || tenant?.accessToken;
  const apiVersion    = tenant?.whatsapp?.apiVersion    || FALLBACK_API_VERSION;

  if (!phoneNumberId || !accessToken) {
    logger.warn(`[TemplateService] Tenant ${tenant._id} missing credentials`);
    return false;
  }

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:       def.name,
      language:   { code: def.language },
      components: def.buildComponents(variables),
    },
  };

  try {
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 12_000,
    });

    logger.info(`[TemplateService] Sent "${templateName}" to ${to}`, {
      tenant: tenant._id,
      template: def.name,
    });
    return true;
  } catch (err) {
    const status  = err.response?.status;
    const errData = err.response?.data?.error;

    // 132000 = template not found / not approved — log clearly
    if (errData?.code === 132000 || errData?.code === 132001) {
      logger.error(`[TemplateService] Template "${def.name}" not found or not approved in Meta.`, {
        code:   errData.code,
        detail: errData.error_data?.details || errData.message,
        hint:   'Register this template in Meta Business Manager and wait for approval.',
      });
    } else {
      logger.error(`[TemplateService] Failed to send "${templateName}" to ${to}`, {
        status,
        error: errData?.message || err.message,
      });
    }

    return false;
  }
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

/**
 * Send abandoned cart recovery message.
 * Called by abandonedCartJob after session TTL expiry with pending order.
 */
export async function sendAbandonedCartTemplate({ to, customerName, business, tenant }) {
  return sendTemplate({
    to,
    templateName: 'abandoned_cart',
    variables: {
      customerName: customerName || 'there',
      businessName: business?.name || 'us',
    },
    tenant,
  });
}

/**
 * Send booking reminder the day before an appointment.
 * Called by bookingReminderJob.
 */
export async function sendBookingReminderTemplate({ to, business, bookingTime, tenant }) {
  return sendTemplate({
    to,
    templateName: 'booking_reminder',
    variables: {
      businessName: business?.name || 'us',
      bookingTime:  bookingTime    || 'your appointment',
    },
    tenant,
  });
}

/**
 * Send payment reminder if proof hasn't arrived.
 */
export async function sendPaymentReminderTemplate({ to, business, tenant }) {
  return sendTemplate({
    to,
    templateName: 'payment_reminder',
    variables: { businessName: business?.name || 'us' },
    tenant,
  });
}
