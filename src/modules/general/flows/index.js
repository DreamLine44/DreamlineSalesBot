/**
 * modules/general/flows/index.js
 *
 * GENERAL mode â€” catch-all for any business that doesn't fit a specific category.
 * FAQ-heavy, AI-driven, simple enquiry capture + optional booking.
 *
 * Flows:
 *   ENQUIRY   â€” structured contact/enquiry capture
 *   BOOKING   â€” generic appointment/call booking (shared bookingFlow)
 *   FAQ       â€” AI-powered FAQ answering with context from business profile
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

// â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const GENERAL_CONFIG = {
  businessMode: 'GENERAL',
  flows: ['ENQUIRY', 'BOOKING'],
  persona: 'a friendly, knowledgeable business assistant who answers questions, captures enquiries, and books appointments',
  steps: {
    ENQUIRY: ['TOPIC', 'DESCRIPTION', 'CONTACT_CONFIRM'],
    BOOKING: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },
  ui: {
    // [FIX-4BTN-GEN] Meta button cap is 3 â€” ABOUT (4th button) was silently dropped by
    // the dispatcher's .slice(0,3). Customers reach About Us via text ("about you", "who are you")
    // which is caught by intent detection, or via the ENQUIRY flow. The 3 most-used CTAs
    // (QUESTION, ENQUIRY, BOOK) are retained.
    welcomeButtons: [
      { id: 'QUESTION',   title: 'â“ Ask a Question'    },
      { id: 'ENQUIRY',    title: 'ðŸ“¬ Send an Enquiry'   },
      { id: 'BOOK',       title: 'ðŸ“… Book Appointment'  },
    ],
    fallbackButtons: [
      { id: 'QUESTION', title: 'â“ Ask'         },
      { id: 'ENQUIRY',  title: 'ðŸ“¬ Enquiry'     },
      { id: 'BOOK',     title: 'ðŸ“… Book'        },
    ],
  },
  messages: {
    welcome:   'ðŸ‘‹ Hi! How can we help you today?\n\nChoose an option below or just type your question.',
    fallback:  'Can I help you with a question, enquiry, or booking?',
    cancelMsg: 'âœ… No problem! Let us know if you need anything else.',
  },
};

// â”€â”€ FAQ / AI Question Handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function handleGeneralQuestion({ session, message, business, tenant }) {
  const raw = String(message || '').trim();
  if (!raw || raw.length < 2) {
    return {
      type: 'text',
      body: 'â“ What would you like to know? Feel free to type your question.',
    };
  }

  const { processQuestionMessage, persistQuestionSession } = await import('../../../services/question/questionAnswerService.js');
  const reply = await processQuestionMessage({ session, message: raw, business, tenant, intent: 'FAQ' });
  await persistQuestionSession(session, tenant, reply.context || { lastMessage: raw });

  // Answer-only: stay in QUESTION mode and wait â€” no buttons. Switching activity
  // is picked up upstream from the customer's own words, not from a tap target.
  return {
    type: reply.type || 'text',
    body: reply.body,
  };
}

// â”€â”€ About Handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function handleAbout({ session, message, business, tenant }) {
  const name    = business?.name || business?.businessName || 'us';
  const desc    = business?.description  || null;
  const phone   = business?.adminPhone   || null;
  const address = business?.address      || null;

  const lines = [`â„¹ï¸ *About ${name}*\n`];
  if (desc)    lines.push(desc);
  if (address) lines.push(`\nðŸ“ *Address:* ${address}`);
  if (phone)   lines.push(`ðŸ“ž *Contact:* ${phone}`);

  // [FIX-GENERAL-CF] Same fix as handleGeneralQuestion: build response first.
  const aboutResponse = {
    type: 'buttons',
    body: lines.join('\n'),
    buttons: [
      { id: 'QUESTION', title: 'â“ Ask a Question'   },
      { id: 'ENQUIRY',  title: 'ðŸ“¬ Send an Enquiry'  },
      { id: 'BOOK',     title: 'ðŸ“… Book Appointment' },
    ],
  };
  await completeFlow(session, 'ABOUT', business, tenant).catch(() => {});
  return aboutResponse;
}

// â”€â”€ Enquiry Flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function handleGeneralEnquiry({ session, message, business, tenant }) {
  const raw  = String(message || '').trim();
  const step = session.step || 'TOPIC';
  const data = session.data || {};

  // â”€â”€ INIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'TOPIC',
      data: {},
    });
    // [UX-GEN-1] 5 topic buttons exceed WhatsApp's 3-button limit â€” use a list instead.
    return {
      type: 'list',
      body: 'ðŸ“¬ *Send an Enquiry*\n\nWhat is your enquiry about?',
      button: 'Choose topic',
      sections: [{ title: 'Enquiry Topics', rows: [
        { id: 'TOPIC_PRODUCT', title: 'ðŸ“¦ Product / Service', description: 'Questions about what we offer'  },
        { id: 'TOPIC_PRICE',   title: 'ðŸ’° Pricing',           description: 'Costs, quotes, discounts'       },
        { id: 'TOPIC_SUPPORT', title: 'ðŸ›  Support',           description: 'Help with an existing order'    },
        { id: 'TOPIC_PARTNER', title: 'ðŸ¤ Partnership',       description: 'Collaboration or wholesale'     },
        { id: 'TOPIC_OTHER',   title: 'ðŸ’¬ Something else',    description: 'Any other enquiry'              },
      ]}],
      footer: 'Or type your topic',
    };
  }

  switch (step) {

    // â”€â”€ TOPIC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          body: 'ðŸ“¬ What is your enquiry about? Please choose one or type your topic.',
          buttons: [
            { id: 'TOPIC_PRODUCT', title: 'ðŸ“¦ Product / Service' },
            { id: 'TOPIC_OTHER',   title: 'ðŸ’¬ Something else'    },
          ],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'DESCRIPTION',
        data: { ...data, topic },
      });

      return {
        type: 'buttons',
        body: `ðŸ“¬ *${topic}*\n\nPlease describe your enquiry â€” include as much detail as you like.\n\n_We'll get back to you as soon as possible._`,
        buttons: [{ id: 'CANCEL', title: 'âŒ Cancel' }],
      };
    }

    // â”€â”€ DESCRIPTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'DESCRIPTION': {
      if (!raw || raw.length < 5) {
        return {
          type: 'buttons',
          body: 'ðŸ“ Please describe your enquiry so we can help you better.',
          buttons: [{ id: 'CANCEL', title: 'âŒ Cancel' }],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONTACT_CONFIRM',
        data: { ...data, description: raw },
      });

      return {
        type: 'buttons',
        body: `ðŸ“¬ *Review your enquiry*\n\n` +
          `ðŸ“Œ *Topic:* ${data.topic || 'General'}\n` +
          `ðŸ“ *Details:* ${raw}\n\n` +
          `We'll send our reply to this WhatsApp number. Ready to submit?`,
        buttons: [
          { id: 'ENQUIRY_SEND', title: 'âœ… Send Enquiry' },
          { id: 'CANCEL',       title: 'âŒ Cancel'        },
        ],
      };
    }

    // â”€â”€ CONTACT_CONFIRM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'CONTACT_CONFIRM': {
      // [FIX-DUALLAYER-CONFIRM] See core/shared/confirmationMatcher.js â€” was
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
            { id: 'ENQUIRY_SEND', title: 'âœ… Yes, send it' },
            { id: 'CANCEL',       title: 'âŒ Cancel'        },
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
          // [FIX-GENERAL-1] businessId was missing â€” without it this enquiry record has
          // no link back to the BusinessConfig, breaking business-scoped admin views.
          businessId:    business._id,
        });
      } catch (err) {
        logger.warn('[General] saveOrder failed for enquiry:', err.message);
        // [FIX-SAVE-ERR-GENERAL] Don't confirm an enquiry that was never persisted â€”
        // the admin alert below would also be misleading since there's no DB record.
        await updateSession(session.customerPhone, session.tenantId, {
          currentFlow: null, step: null, data: {},
        });
        return {
          type:    'buttons',
          body:    `âš ï¸ *Something went wrong submitting your enquiry.*\n\nPlease try again â€” tap below to start over.`,
          buttons: [
            { id: 'ENQUIRY', title: 'ðŸ“ Try Again'   },
            { id: 'SUPPORT', title: 'ðŸ’¬ Contact Us'  },
          ],
        };
      }

      const adminPhone = business?.adminPhone;

      if (adminPhone && tenant) {
        try {
          const { dispatchText } = await import('../../../core/whatsapp/dispatcher.js');
          await dispatchText(
            adminPhone,
            `ðŸ”” *New Enquiry*\n\n` +
            `ðŸ“ž From: ${session.customerPhone}\n` +
            `ðŸ“Œ Topic: ${data.topic || 'General'}\n` +
            `ðŸ“ Details: ${data.description}`,
            tenant,
          );
        } catch (err) {
          logger.warn('[General] admin notify failed:', err.message);
        }
      }

      // [FIX-1] Correct completeFlow signature: (session, completedFlow, business, tenant)
      // [FIX-2] Capture return value â€” completeFlow may return a lead-capture UIResponse
      const _lcRge = await completeFlow(session, 'ENQUIRY', business, tenant);
      if (_lcRge) return _lcRge;

      return {
        type: 'buttons',
        body: `âœ… *Enquiry Sent!*\n\nThank you! We've received your message and will respond shortly.\n\n` +
          (adminPhone ? `For urgent matters: ðŸ“ž *${adminPhone}*` : 'We\'ll be in touch soon.'),
        buttons: [
          { id: 'QUESTION',   title: 'â“ Ask a Question'   },
          { id: 'BOOK',       title: 'ðŸ“… Book Appointment' },
          { id: 'SHOW_MENU',  title: 'ðŸ”„ Start Over'      },
        ],
      };
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, { step: 'TOPIC', data: {} });
      return handleGeneralEnquiry({ session: { ...session, step: 'TOPIC', data: {} }, message: null, business, tenant });
  }
}

// â”€â”€ Booking (shared) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function handleGeneralBooking({ session, message, business, tenant, isInteractive }) {
  return handleBookingFlow({ session, message, business, tenant, isInteractive });
}

