'use strict';

/**
 * Media Flow — Handles all non-text media.
 * IMAGE UPLOAD = payment proof by default if order is active.
 */

const { sendButtons, sendText } = require('../services/waSender');
const { sessionStore } = require('../services/sessionStore');
const paymentFlow = require('./paymentFlow');
const { logger } = require('../utils/logger');

/**
 * Handle image/document upload.
 * If an order is in progress (any state), treat as payment proof.
 */
async function handle({ session, parsed, userId, phoneNumberId }) {
  const mediaId = parsed.mediaId;
  const caption = (parsed.caption || '').toLowerCase();

  logger.info(`[${userId}] Media received: type=${parsed.type}, state=${session.state}, mediaId=${mediaId}`);

  // Always try to associate with active order/payment
  const isPaymentContext =
    session.state === 'AWAITING_PAYMENT_PROOF' ||
    session.payment?.status === 'pending' ||
    session.currentOrder?.length > 0 ||
    caption.includes('proof') ||
    caption.includes('paid') ||
    caption.includes('receipt') ||
    caption.includes('transfer') ||
    caption.includes('screenshot');

  if (isPaymentContext) {
    return paymentFlow.handleScreenshotUpload({ session, userId, phoneNumberId, mediaId });
  }

  // No active order context — acknowledge and guide
  return sendButtons(phoneNumberId, userId,
    `📎 Thanks for the image!\n\nIf this is a *payment proof*, please first place an order and we'll ask for your screenshot at checkout.\n\nWhat would you like to do?`,
    [
      { id: 'action_order', title: '🛒 Order Food' },
      { id: 'action_help',  title: '❓ Get Help' },
    ]
  );
}

/**
 * Gracefully handle unsupported media (voice, video, sticker, audio).
 */
async function handleUnsupported({ session, parsed, userId, phoneNumberId }) {
  const typeMessages = {
    voice:   `🎤 I received your voice note, but I'm not able to process audio just yet.\nPlease type your message and I'll help you right away! 😊`,
    audio:   `🎵 I received an audio file! Please type your message instead.`,
    video:   `🎬 Thanks for the video! Please type your order or question.`,
    sticker: `😄 Nice sticker! How can I help you today?`,
  };

  const message = typeMessages[parsed.type] || `I received your file! Please type your message so I can help.`;

  return sendButtons(phoneNumberId, userId,
    message,
    [
      { id: 'action_order', title: '🛒 Order Food' },
      { id: 'action_help',  title: '❓ Ask a Question' },
    ]
  );
}

module.exports = { handle, handleUnsupported };
