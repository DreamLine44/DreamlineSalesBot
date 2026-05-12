'use strict';

/**
 * Welcome Flow
 * FIX: Welcome message no longer says "Type Order" or "Type Book"
 *      because the interactive buttons already serve that purpose.
 */

const { sendButtons, sendText } = require('../services/waSender');
const { sessionStore } = require('../services/sessionStore');
const config = require('../config/businessConfig');
const { logger } = require('../utils/logger');
const orderFlow = require('./orderFlow');
const bookingFlow = require('./bookingFlow');
const helpFlow = require('./helpFlow');

/**
 * Main welcome handler — triggered by greeting, IDLE state, or returning user.
 */
async function handle({ session, parsed, userId, phoneNumberId, intent }) {
  const text = (parsed?.text || '').toLowerCase();

  // If they typed something meaningful alongside a greeting, try to route it
  if (intent?.secondary) {
    if (intent.secondary === 'ORDER' || intent.secondary === 'MENU') {
      return await orderFlow.startBrowsing({ session, userId, phoneNumberId });
    }
    if (intent.secondary === 'BOOK') {
      return await bookingFlow.startBooking({ session, userId, phoneNumberId });
    }
  }

  return await sendWelcome({ session, userId, phoneNumberId });
}

/**
 * Send the welcome message.
 * ✅ FIX: No "Type Order to..." or "Type Book to..." in the message body.
 *         The three buttons communicate those options clearly.
 */
async function sendWelcome({ session, userId, phoneNumberId }) {
  session.state = 'WELCOME';
  sessionStore.save(session);

  const name = session.contactName !== 'Friend' ? ` ${session.contactName}` : '';
  const isReturn = session.interactionCount > 1;

  let welcomeText;

  if (isReturn) {
    // Returning user — warmer, shorter
    welcomeText = `Welcome back${name}! 👋\n\n*DreamLine Restaurant* is ready for you.\nHow can we help you today?`;
  } else {
    // First-time user — full welcome, NO instructions to "type" keywords
    welcomeText = `Welcome to *DreamLine Restaurant*${name}! 🍽️\n\nYour home for authentic *Gambian cuisine*.\n\n⏰ Open daily: *8:00 AM – 9:00 PM*\n\nWhat would you like to do?`;
  }

  return sendButtons(
    phoneNumberId,
    userId,
    welcomeText,
    config.welcome.buttons,
    null,
    null
  );
}

/**
 * Graceful handler for completely unknown/empty messages at IDLE state.
 */
async function handleUnknown({ session, userId, phoneNumberId }) {
  session.state = 'WELCOME';
  sessionStore.save(session);
  return sendWelcome({ session, userId, phoneNumberId });
}

/**
 * Send error recovery — last resort when something crashes.
 */
async function sendErrorRecovery({ session, userId, phoneNumberId }) {
  return sendButtons(
    phoneNumberId,
    userId,
    `Oops, something went wrong on our end! 😅 Let's get you back on track.`,
    [
      { id: 'action_order',     title: '🛒 Order Food' },
      { id: 'action_book',      title: '📅 Book a Table' },
      { id: 'action_human',     title: '👤 Talk to Someone' },
    ]
  );
}

module.exports = { handle, sendWelcome, handleUnknown, sendErrorRecovery };
