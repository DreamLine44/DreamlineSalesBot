/**
 * modules/general/flows/index.js
 *
 * GENERAL mode — catch-all for any business that doesn't fit a specific category.
 * FAQ-heavy, AI-driven, simple enquiry capture + optional booking.
 *
 * Flows:
 *   ENQUIRY   — structured contact/enquiry capture
 *   BOOKING   — generic appointment/call booking (shared bookingFlow)
 *   FAQ       — AI-powered FAQ answering with context from business profile
 *
 * Persona: a helpful, friendly business assistant who answers questions clearly
 * and directs customers to the right next step.
 */

import { updateSession }     from '../../../core/sessions/sessionService.js';
import { completeFlow, cancelFlow } from '../../../core/conversations/flowEngine.js';
import { handleBookingFlow } from '../../../core/conversations/bookingFlow.js';
import { getAIReply }        from '../../../core/ai/providers/aiRouter.js';
import { saveOrder }         from '../../../services/order/orderService.js';
import logger                from '../../../config/logger.js';

// ── Config ────────────────────────────────────────────────────────────────────

export const GENERAL_CONFIG = {
  businessMode: 'GENERAL',
  flows: ['ENQUIRY', 'BOOKING'],
  persona: 'a friendly, knowledgeable business assistant who answers questions, captures enquiries, and books appointments',
  steps: {
    ENQUIRY: ['TOPIC', 'DESCRIPTION', 'CONTACT_CONFIRM'],
    BOOKING: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },
  ui: {
    // [FIX-4BTN-GEN] Meta button cap is 3 — ABOUT (4th button) was silently dropped by
    // the dispatcher's .slice(0,3). Customers reach About Us via text ("about you", "who are you")
    // which is caught by intent detection, or via the ENQUIRY flow. The 3 most-used CTAs
    // (QUESTION, ENQUIRY, BOOK) are retained.
    welcomeButtons: [
      { id: 'QUESTION',   title: '❓ Ask a Question'    },
      { id: 'ENQUIRY',    title: '📬 Send an Enquiry'   },
      { id: 'BOOK',       title: '📅 Book Appointment'  },
    ],
    fallbackButtons: [
      { id: 'QUESTION', title: '❓ Ask'         },
      { id: 'ENQUIRY',  title: '📬 Enquiry'     },
      { id: 'BOOK',     title: '📅 Book'        },
    ],
  },
  messages: {
    welcome:   '👋 Hi! How can we help you today?\n\nChoose an option below or just type your question.',
    fallback:  'Can I help you with a question, enquiry, or booking?',
    cancelMsg: '✅ No problem! Let us know if you need anything else.',
  },
};

// ── FAQ / AI Question Handler ─────────────────────────────────────────────────

export async function handleGeneralQuestion({ session, message, business, tenant }) {
  const raw = String(message || '').trim();
  if (!raw || raw.length < 2) {
    return {
      type: 'text',
      body: '❓ What would you like to know? Feel free to type your question.',
    };
  }

  const { processQuestionMessage, persistQuestionSession } = await import('../../../services/question/questionAnswerService.js');
  const reply = await processQuestionMessage({ session, message: raw, business, tenant, intent: 'FAQ' });
  await persistQuestionSession(session, tenant, reply.context || { lastMessage: raw });

  // Answer-only: stay in QUESTION mode and wait — no buttons. Switching activity
  // is picked up upstream from the customer's own words, not from a tap target.
  return {
    type: reply.type || 'text',
    body: reply.body,
  };
}

// ── About Handler ─────────────────────────────────────────────────────────────

export async function handleAbout({ session, message, business, tenant }) {
  const name    = business?.name || business?.businessName || 'us';
  const desc    = business?.description  || null;
  const phone   = business?.adminPhone   || null;
  const address = business?.address      || null;

  const lines = [`ℹ️ *About ${name}*\n`];
  if (desc)    lines.push(desc);
  if (address) lines.push(`\n📍 *Address:* ${address}`);
  if (phone)   lines.push(`📞 *Contact:* ${phone}`);

  // [FIX-GENERAL-CF] Same fix as handleGeneralQuestion: build response first.
  const aboutResponse = {
    type: 'buttons',
    body: lines.join('\n'),
    buttons: [
      { id: 'QUESTION', title: '❓ Ask a Question'   },
      { id: 'ENQUIRY',  title: '📬 Send an Enquiry'  },
      { id: 'BOOK',     title: '📅 Book Appointment' },
    ],
  };
  await completeFlow(session, 'ABOUT', business, tenant).catch(() => {});
  return aboutResponse;
}

// ── Enquiry Flow ──────────────────────────────────────────────────────────────

export async function handleGeneralEnquiry({ session, message, business, tenant }) {
  const raw  = String(message || '').trim();
  const step = session.step || 'TOPIC';
  const data = session.data || {};

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'TOPIC',
      data: {},
    });
    // [UX-GEN-1] 5 topic buttons exceed WhatsApp's 3-button limit — use a list instead.
    return {
      type: 'list',
      body: '📬 *Send an Enquiry*\n\nWhat is your enquiry about?',
      button: 'Choose topic',
      sections: [{ title: 'Enquiry Topics', rows: [
        { id: 'TOPIC_PRODUCT', title: '📦 Product / Service', description: 'Questions about what we offer'  },
        { id: 'TOPIC_PRICE',   title: '💰 Pricing',           description: 'Costs, quotes, discounts'       },
        { id: 'TOPIC_SUPPORT', title: '🛠 Support',           description: 'Help with an existing order'    },
        { id: 'TOPIC_PARTNER', title: '🤝 Partnership',       description: 'Collaboration or wholesale'     },
        { id: 'TOPIC_OTHER',   title: '💬 Something else',    description: 'Any other enquiry'              },
      ]}],
      footer: 'Or type your topic',
    };
  }

  switch (step) {

    // ── TOPIC ─────────────────────────────────────────────────────────────────
    case 'TOPIC': {
      const TOPIC_MAP = {
        'TOPIC_PRODUCT':  'Product / Service',
        'TOPIC_PRICE':    'Pricing',
        'TOPIC_SUPPORT':  'Support',
        'TOPIC_PARTNER':  'Partnership',
        'TOPIC_OTHER':    'Other',
      };
      const topic = TOPIC_MAP[raw.toUpperCase()] || raw;

      if (!topic || topic.length < 2) {
        return {
          type: 'buttons',
          body: '📬 What is your enquiry about? Please choose one or type your topic.',
          buttons: [
            { id: 'TOPIC_PRODUCT', title: '📦 Product / Service' },
            { id: 'TOPIC_OTHER',   title: '💬 Something else'    },
          ],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'DESCRIPTION',
        data: { ...data, topic },
      });

      return {
        type: 'buttons',
        body: `📬 *${topic}*\n\nPlease describe your enquiry — include as much detail as you like.\n\n_We'll get back to you as soon as possible._`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }

    // ── DESCRIPTION ──────────────────────────────────────────────────────────
    case 'DESCRIPTION': {
      if (!raw || raw.length < 5) {
        return {
          type: 'buttons',
          body: '📝 Please describe your enquiry so we can help you better.',
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONTACT_CONFIRM',
        data: { ...data, description: raw },
      });

      return {
        type: 'buttons',
        body: `📬 *Review your enquiry*\n\n` +
          `📌 *Topic:* ${data.topic || 'General'}\n` +
          `📝 *Details:* ${raw}\n\n` +
          `We'll send our reply to this WhatsApp number. Ready to submit?`,
        buttons: [
          { id: 'ENQUIRY_SEND', title: '✅ Send Enquiry' },
          { id: 'CANCEL',       title: '❌ Cancel'        },
        ],
      };
    }

    // ── CONTACT_CONFIRM ──────────────────────────────────────────────────────
    case 'CONTACT_CONFIRM': {
      // [FIX-DUALLAYER-CONFIRM] See core/shared/confirmationMatcher.js — was
      // exact-match-only, so a typed "yes please"/"go ahead" never registered.
      const { resolveConfirmation } = await import('../../../core/shared/confirmationMatcher.js');
      const verdict = await resolveConfirmation({
        raw, business,
        affirmIds: ['ENQUIRY_SEND', 'CONFIRM', 'YES'],
      });
      if (verdict === 'no') return cancelFlow(session, business);
      if (verdict !== 'yes') {
        return {
          type: 'buttons',
          body: 'Ready to send your enquiry?',
          buttons: [
            { id: 'ENQUIRY_SEND', title: '✅ Yes, send it' },
            { id: 'CANCEL',       title: '❌ Cancel'        },
          ],
        };
      }

      // Save as a record
      try {
        await saveOrder({
          tenantId:      session.tenantId,
          customerPhone: session.customerPhone,
          customerName:  session.customerName,
          item:          `[ENQUIRY] ${data.topic || 'General'}`,
          quantity:      1,
          notes:         data.description,
          status:        'pending',
          // [FIX-GENERAL-1] businessId was missing — without it this enquiry record has
          // no link back to the BusinessConfig, breaking business-scoped admin views.
          businessId:    business._id,
        });
      } catch (err) {
        logger.warn('[General] saveOrder failed for enquiry:', err.message);
        // [FIX-SAVE-ERR-GENERAL] Don't confirm an enquiry that was never persisted —
        // the admin alert below would also be misleading since there's no DB record.
        await updateSession(session.customerPhone, session.tenantId, {
          currentFlow: null, step: null, data: {},
        });
        return {
          type:    'buttons',
          body:    `⚠️ *Something went wrong submitting your enquiry.*\n\nPlease try again — tap below to start over.`,
          buttons: [
            { id: 'ENQUIRY', title: '📝 Try Again'   },
            { id: 'SUPPORT', title: '💬 Contact Us'  },
          ],
        };
      }

      const adminPhone = business?.adminPhone;

      if (adminPhone && tenant) {
        try {
          const { dispatchText } = await import('../../../core/whatsapp/dispatcher.js');
          await dispatchText(
            adminPhone,
            `🔔 *New Enquiry*\n\n` +
            `📞 From: ${session.customerPhone}\n` +
            `📌 Topic: ${data.topic || 'General'}\n` +
            `📝 Details: ${data.description}`,
            tenant,
          );
        } catch (err) {
          logger.warn('[General] admin notify failed:', err.message);
        }
      }

      // [FIX-1] Correct completeFlow signature: (session, completedFlow, business, tenant)
      // [FIX-2] Capture return value — completeFlow may return a lead-capture UIResponse
      const _lcRge = await completeFlow(session, 'ENQUIRY', business, tenant);
      if (_lcRge) return _lcRge;

      return {
        type: 'buttons',
        body: `✅ *Enquiry Sent!*\n\nThank you! We've received your message and will respond shortly.\n\n` +
          (adminPhone ? `For urgent matters: 📞 *${adminPhone}*` : 'We\'ll be in touch soon.'),
        buttons: [
          { id: 'QUESTION',   title: '❓ Ask a Question'   },
          { id: 'BOOK',       title: '📅 Book Appointment' },
          { id: 'SHOW_MENU',  title: '🔄 Start Over'      },
        ],
      };
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, { step: 'TOPIC', data: {} });
      return handleGeneralEnquiry({ session: { ...session, step: 'TOPIC', data: {} }, message: null, business, tenant });
  }
}

// ── Booking (shared) ──────────────────────────────────────────────────────────

export async function handleGeneralBooking({ session, message, business, tenant, isInteractive }) {
  return handleBookingFlow({ session, message, business, tenant, isInteractive });
}

