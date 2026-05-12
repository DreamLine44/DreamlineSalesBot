'use strict';

const { sendButtons, sendText, sendList } = require('../services/waSender');
const { sessionStore } = require('../services/sessionStore');
const config = require('../config/businessConfig');

const FAQ_SECTIONS = [
  {
    title: '📦 Orders',
    rows: [
      { id: 'faq_hours',    title: 'Opening Hours',      description: 'When are you open?' },
      { id: 'faq_delivery', title: 'Delivery Info',       description: 'Areas & fees' },
      { id: 'faq_payment',  title: 'Payment Methods',     description: 'How can I pay?' },
      { id: 'faq_time',     title: 'How Long?',           description: 'Order & delivery time' },
    ],
  },
  {
    title: '🆘 Support',
    rows: [
      { id: 'faq_cancel',  title: 'Cancel an Order',  description: 'How to cancel' },
      { id: 'faq_track',   title: 'Track My Order',   description: 'Where is my order?' },
      { id: 'faq_contact', title: 'Contact Us',        description: 'Phone & address' },
      { id: 'faq_human',   title: 'Talk to Someone',  description: 'Speak with our team' },
    ],
  },
];

const FAQ_ANSWERS = {
  faq_hours:    `⏰ We're open *${config.hours.days}*\n*${config.hours.open} – ${config.hours.close}*`,
  faq_delivery: `🚗 *Delivery Areas:* ${config.delivery.zones.join(', ')}\n*Fee:* ${config.currencySymbol}${config.delivery.fee}\n*Free delivery* on orders over ${config.currencySymbol}${config.delivery.freeAbove}!`,
  faq_payment:  `💳 We accept:\n${config.payment.methods.map(m => `• ${m.name}`).join('\n')}`,
  faq_time:     `⏱️ Typical delivery time: *${config.delivery.estimatedMinutes} minutes*`,
  faq_cancel:   `❌ To cancel an order, please contact us immediately.\n📞 ${config.contact.phone}\n\n_Cancellations accepted before preparation begins._`,
  faq_track:    `📦 To track your order, share your *Order ID* with our team.\n📞 ${config.contact.phone}`,
  faq_contact:  `📞 *Phone:* ${config.contact.phone}\n📍 *Address:* ${config.contact.address}\n✉️ *Email:* ${config.contact.email}`,
};

async function handle({ session, parsed, userId, phoneNumberId, intent }) {
  const text = (parsed?.text || '').toLowerCase();
  const interactiveId = parsed?.interactiveId;

  // FAQ answer lookup
  if (interactiveId?.startsWith('faq_')) {
    const answer = FAQ_ANSWERS[interactiveId];
    if (answer) {
      return sendButtons(phoneNumberId, userId, answer,
        [
          { id: 'action_back_home', title: '🏠 Main Menu' },
          { id: 'action_order',     title: '🛒 Order Food' },
          { id: 'action_human',     title: '👤 More Help' },
        ]
      );
    }
    if (interactiveId === 'faq_human') return escalateToHuman({ session, userId, phoneNumberId });
  }

  session.state = 'HELP';
  sessionStore.save(session);

  return sendList(
    phoneNumberId, userId,
    `❓ *Help & Support*\n\nWhat would you like to know? Choose from the options below, or just ask me your question! 😊`,
    '❓ Get Help',
    FAQ_SECTIONS,
    '*DreamLine Support*',
    'Or type your question'
  );
}

async function escalateToHuman({ session, userId, phoneNumberId }) {
  session.state = 'IDLE';
  sessionStore.save(session);

  return sendButtons(phoneNumberId, userId,
    `👤 *Connecting you with our team*\n\nOur staff will assist you shortly.\n\n📞 *Direct line:* ${config.contact.phone}\n📍 ${config.contact.address}\n\n_Typical response time: a few minutes during business hours._`,
    [
      { id: 'action_back_home', title: '🏠 Main Menu' },
      { id: 'action_order',     title: '🛒 Order Food' },
    ]
  );
}

async function sendErrorRecovery({ userId, phoneNumberId, session }) {
  return sendButtons(phoneNumberId, userId,
    `Something went wrong on our end! 😔\n\nDon't worry — your order is safe. Let's get back on track.`,
    [
      { id: 'action_cart',      title: '🛒 View My Cart' },
      { id: 'action_back_home', title: '🏠 Start Over' },
      { id: 'action_human',     title: '👤 Get Help' },
    ]
  );
}

module.exports = { handle, escalateToHuman, sendErrorRecovery };
