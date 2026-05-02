/**
 * services/notificationService.js
 *
 * Sends alert messages to a business admin's WhatsApp number.
 * Used by messageService.js (token-expiry alerts) and can be used
 * by any service that needs to push a notification to the owner.
 *
 * Intentionally thin — it delegates to the raw Graph API directly so
 * it does NOT import messageService (which would create a circular dep).
 */

import axios from 'axios';

const FALLBACK_API_VERSION = process.env.WA_API_VERSION || 'v21.0';

/**
 * Send a plain-text WhatsApp notification to the tenant's admin phone.
 *
 * @param {object} tenant       Tenant document (.whatsapp.accessToken, .whatsapp.phoneNumberId)
 * @param {string} message      Message body to send
 * @param {string} [adminPhone] Admin phone number (E.164 without +).
 *                              If omitted, falls back to tenant.adminPhone (legacy path).
 */
export async function notifyAdmin(tenant, message, adminPhone) {
  const recipient = adminPhone || tenant?.adminPhone;

  if (!recipient) {
    // No admin phone configured — silently skip (not an error)
    return;
  }

  // Tenant model nests credentials under .whatsapp.*
  const phoneNumberId = tenant?.whatsapp?.phoneNumberId || tenant?.phoneNumberId;
  const accessToken   = tenant?.whatsapp?.accessToken   || tenant?.accessToken;

  // [FIX 3] Use per-tenant apiVersion, fall back to env var.
  const apiVersion = tenant?.whatsapp?.apiVersion || FALLBACK_API_VERSION;

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'text',
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 8_000,
    }
  );
}
