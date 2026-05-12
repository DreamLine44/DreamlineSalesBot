'use strict';

const { sendButtons, sendText, sendList } = require('../services/waSender');
const { sessionStore } = require('../services/sessionStore');
const config = require('../config/businessConfig');
const { parseQuantity } = require('../utils/nlp');
const { logger } = require('../utils/logger');

async function startBooking({ session, userId, phoneNumberId }) {
  if (!config.booking.enabled) {
    return sendText(phoneNumberId, userId, `Table reservations are currently not available. Please call us directly at ${config.contact.phone}.`);
  }

  session.state = 'BOOKING';
  session.tableBooking = {};
  sessionStore.save(session);

  return sendButtons(phoneNumberId, userId,
    `📅 *Reserve a Table*\n\nGreat choice! Let's get your table booked.\n\nHow many people will be dining? 🍽️`,
    [
      { id: 'book_party_1', title: '👤 1–2 People' },
      { id: 'book_party_2', title: '👥 3–5 People' },
      { id: 'book_party_3', title: '👨‍👩‍👧 6+ People' },
    ],
    '*Book a Table*',
    `We accommodate up to ${config.booking.maxPartySize} guests`
  );
}

async function handle({ session, parsed, userId, phoneNumberId, intent }) {
  const text = parsed.text || '';

  if (session.state === 'AWAITING_BOOKING_PARTY') {
    return handlePartySize({ session, text, userId, phoneNumberId });
  }
  if (session.state === 'AWAITING_BOOKING_DATE') {
    return handleBookingDate({ session, text, userId, phoneNumberId });
  }
  if (session.state === 'AWAITING_BOOKING_TIME') {
    return handleBookingTime({ session, text, userId, phoneNumberId });
  }

  return startBooking({ session, userId, phoneNumberId });
}

async function handlePartySize({ session, text, userId, phoneNumberId }) {
  const qty = parseQuantity(text) || parseInt(text, 10);

  if (!qty || qty < 1) {
    return sendButtons(phoneNumberId, userId,
      `How many guests will be dining? 😊`,
      [
        { id: 'book_1', title: '1–2 Guests' },
        { id: 'book_3', title: '3–5 Guests' },
        { id: 'book_6', title: '6+ Guests' },
      ]
    );
  }

  if (qty > config.booking.maxPartySize) {
    return sendText(phoneNumberId, userId,
      `We can accommodate up to ${config.booking.maxPartySize} guests for reservations.\nFor larger groups, please call us: ${config.contact.phone}`
    );
  }

  session.tableBooking.partySize = qty;
  session.state = 'AWAITING_BOOKING_DATE';
  sessionStore.save(session);

  return sendText(phoneNumberId, userId,
    `Perfect! *${qty} guest(s)* noted. 😊\n\nWhat date would you like to dine?\nExample: *"Tomorrow"*, *"This Saturday"*, *"15 June"*`
  );
}

async function handleBookingDate({ session, text, userId, phoneNumberId }) {
  if (text.length < 2) {
    return sendText(phoneNumberId, userId, `Please provide a date. Example: *"Tomorrow"* or *"This Saturday"*`);
  }

  session.tableBooking.date = text;
  session.state = 'AWAITING_BOOKING_TIME';
  sessionStore.save(session);

  return sendButtons(phoneNumberId, userId,
    `Great! *${text}* is noted. 📅\n\nWhat time would you prefer?`,
    [
      { id: 'time_lunch',  title: '🌞 Lunch (12–2 PM)' },
      { id: 'time_dinner', title: '🌙 Dinner (6–9 PM)' },
      { id: 'time_other',  title: '⏰ Other Time' },
    ]
  );
}

async function handleBookingTime({ session, text, userId, phoneNumberId }) {
  session.tableBooking.time = text;
  sessionStore.save(session);

  // Confirm booking
  const b = session.tableBooking;
  session.state = 'IDLE';
  sessionStore.save(session);

  // Notify admin
  const adminMsg = `📅 *New Table Booking*\nCustomer: ${session.contactName} (${session.userId})\nParty: ${b.partySize} guests\nDate: ${b.date}\nTime: ${b.time}`;
  if (config.contact.adminWhatsApp) {
    const { sendText: st } = require('../services/waSender');
    st(session.phoneNumberId, config.contact.adminWhatsApp, adminMsg).catch(() => {});
  }

  return sendButtons(phoneNumberId, userId,
    `✅ *Table Reserved!*\n\n👥 Guests: *${b.partySize}*\n📅 Date: *${b.date}*\n⏰ Time: *${b.time}*\n\n${config.booking.confirmationMessage}\n\n_Our team will confirm your reservation shortly._`,
    [
      { id: 'action_order',     title: '🛒 Order Food Too' },
      { id: 'action_back_home', title: '🏠 Main Menu' },
    ]
  );
}

module.exports = { handle, startBooking };
