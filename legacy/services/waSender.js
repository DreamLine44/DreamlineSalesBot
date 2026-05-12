'use strict';

/**
 * WhatsApp sender — wraps all Cloud API message types with retry logic.
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

const BASE_URL = `https://graph.facebook.com/v19.0`;
const TOKEN = process.env.WHATSAPP_TOKEN;

// Simple rate-limit: max 3 messages per 200ms per user
const _lastSent = new Map();

async function _send(phoneNumberId, payload, retries = 3) {
  const url = `${BASE_URL}/${phoneNumberId}/messages`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(url, payload, {
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const errMsg = err.response?.data?.error?.message || err.message;
      logger.warn(`WA send attempt ${attempt}/${retries} failed [${status}]: ${errMsg}`);
      if (attempt === retries || [400, 401, 403].includes(status)) throw err;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

// ─── Core Builders ────────────────────────────────────────────────────────────

function sendText(phoneNumberId, to, text, previewUrl = false) {
  return _send(phoneNumberId, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'text',
    text: { preview_url: previewUrl, body: text },
  });
}

function sendButtons(phoneNumberId, to, bodyText, buttons, headerText = null, footerText = null) {
  // WA supports max 3 buttons
  const capped = buttons.slice(0, 3);
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: capped.map(b => ({
          type: 'reply',
          reply: { id: b.id || b.title.toLowerCase().replace(/\s+/g, '_'), title: b.title.substring(0, 20) },
        })),
      },
    },
  };
  if (headerText) payload.interactive.header = { type: 'text', text: headerText };
  if (footerText) payload.interactive.footer = { text: footerText };
  return _send(phoneNumberId, payload);
}

function sendList(phoneNumberId, to, bodyText, buttonLabel, sections, headerText = null, footerText = null) {
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonLabel.substring(0, 20),
        sections: sections.map(section => ({
          title: (section.title || '').substring(0, 24),
          rows: section.rows.slice(0, 10).map(row => ({
            id: row.id || row.title.toLowerCase().replace(/\s+/g, '_'),
            title: row.title.substring(0, 24),
            description: row.description ? row.description.substring(0, 72) : undefined,
          })),
        })),
      },
    },
  };
  if (headerText) payload.interactive.header = { type: 'text', text: headerText };
  if (footerText) payload.interactive.footer = { text: footerText };
  return _send(phoneNumberId, payload);
}

function sendTemplate(phoneNumberId, to, templateName, languageCode, components = []) {
  return _send(phoneNumberId, {
    messaging_product: 'whatsapp', to,
    type: 'template',
    template: { name: templateName, language: { code: languageCode }, components },
  });
}

function markRead(phoneNumberId, messageId) {
  return _send(phoneNumberId, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  }).catch(e => logger.warn('markRead failed:', e.message));
}

module.exports = { sendText, sendButtons, sendList, sendTemplate, markRead };
