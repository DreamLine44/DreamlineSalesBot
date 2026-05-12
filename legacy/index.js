'use strict';

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { handleIncomingMessage } = require('./src/messageRouter');
const { logger } = require('./utils/logger');
const { sessionStore } = require('./services/sessionStore');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ─── Webhook Verification ────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    logger.info('Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ─── Incoming Messages ────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value?.messages?.length) return;

    const message = value.messages[0];
    const contact = value.contacts?.[0];
    const metadata = value.metadata;

    await handleIncomingMessage({ message, contact, metadata });
  } catch (err) {
    logger.error('Webhook processing error', err);
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessionStore.size(), timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`DreamlineSalesBot v14 running on port ${PORT}`));
