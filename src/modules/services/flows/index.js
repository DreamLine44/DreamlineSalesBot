/**
 * modules/services/flows/index.js
 *
 * SERVICES mode — freelancers, agencies, consultants, tradespeople.
 * No physical menu / stock. Flows:
 *   ENQUIRY      — scoped quote request (type → description → budget → contact)
 *   BOOKING      — schedule a consultation / call / site visit
 *   QUOTE_FOLLOW — follow-up on a pending quote
 *
 * Persona: a professional service coordinator who qualifies leads efficiently,
 * collects just enough info, and always ends with a clear next step.
 */

import { updateSession }     from '../../../core/sessions/sessionService.js';
import { completeFlow, cancelFlow } from '../../../core/conversations/flowEngine.js';
import { handleBookingFlow } from '../../../core/conversations/bookingFlow.js';
import { saveOrder }         from '../../../services/order/orderService.js';
import logger                from '../../../config/logger.js';
import { getAdminPhones, getPrimaryAdminPhone } from '../../../utils/adminPhones.js';

// ── Config ────────────────────────────────────────────────────────────────────

export const SERVICES_CONFIG = {
  businessMode: 'SERVICES',
  flows: ['ENQUIRY', 'BOOKING'],
  persona: 'professional service coordinator who qualifies project enquiries clearly and books consultations efficiently',
  steps: {
    ENQUIRY: ['SERVICE_TYPE', 'DESCRIPTION', 'BUDGET', 'TIMELINE', 'CONTACT_CONFIRM'],
    BOOKING: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },
  ui: {
    // [FIX-4BTN-SVC] Meta button messages are capped at 3 buttons; the dispatcher
    // silently drops the 4th via .slice(0,3). This array previously had 4 items —
    // 'QUESTION' was never rendered and customers had no way to tap it.
    // Fix: keep 3 buttons. QUESTION is accessible via the 'ENQUIRY' flow, free-text,
    // or by using a list-type welcome message (see welcomeList below).
    welcomeButtons: [
      { id: 'ENQUIRY',      title: '📋 Get a Quote'        },
      { id: 'BOOK',         title: '📅 Book Consultation'  },
      { id: 'QUESTION',     title: '❓ Ask a Question'     },
    ],
    // [FIX-4BTN-SVC] Full 4-option list for callers that use list-type messages.
    // Use this instead of welcomeButtons when the UI can support a list (no button cap).
    welcomeList: [
      { id: 'ENQUIRY',      title: '📋 Get a Quote',           description: 'Request a project quote'       },
      { id: 'BOOK',         title: '📅 Book Consultation',     description: 'Schedule a call or site visit' },
      { id: 'QUOTE_FOLLOW', title: '🔍 Follow Up on Quote',    description: 'Check on a pending quote'      },
      { id: 'QUESTION',     title: '❓ Ask a Question',        description: 'Get a quick answer'            },
    ],
    fallbackButtons: [
      { id: 'ENQUIRY', title: '📋 Get a Quote'       },
      { id: 'BOOK',    title: '📅 Book a Call'       },
      { id: 'QUESTION',title: '❓ Ask'               },
    ],
  },
  messages: {
    welcome:      '👋 Hi! We\'re happy to help with your project.\n\nWhat would you like to do?',
    fallback:     'Would you like to *get a quote*, *book a consultation*, or *ask a question*?',
    cancelMsg:    '✅ No problem! Feel free to come back whenever you\'re ready.',
    afterEnquiry: '✅ Got it! We\'ll review your enquiry and get back to you shortly with a personalised quote.',
  },
};

// ── Enquiry Flow ──────────────────────────────────────────────────────────────

export async function handleEnquiryFlow({ session, message, business, tenant }) {
  const raw  = String(message || '').trim();
  const step = session.step || 'SERVICE_TYPE';
  const data = session.data || {};

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SERVICE_TYPE',
      data: {},
    });

    const serviceTypes = _getServiceTypes(business);
    // [FIX-LIST-CAP-2] No build-time slice needed here — dispatcher.js
    // hard-caps the OUTGOING message at Meta's real limit of 10 rows TOTAL
    // (not chunked into extra sections — an earlier version of this comment
    // wrongly claimed that; Meta's actual cap is 10 rows combined across the
    // whole message, full stop). If a tenant configures more than 10 service
    // types, the dispatcher truncates to 10 and adds a footer hint; the rest
    // are typeable but not shown. Add category grouping here if that becomes
    // a real limitation for any tenant.
    return {
      type: 'list',
      body:   '📋 *Get a Quote*\n\nWhat type of service are you looking for?\n\n_(Tap one below or type your answer)_',
      button: 'Choose service',
      sections: [{
        title: 'Service Types',
        rows: serviceTypes.map(s => ({ id: `SVC_${s.toUpperCase().replace(/\s+/g, '_')}`, title: s })),
      }],
      footer: 'Tap a service or type your own',
    };
  }

  switch (step) {

    // ── SERVICE_TYPE ─────────────────────────────────────────────────────────
    case 'SERVICE_TYPE': {
      if (!raw || raw.length < 2) return _askServiceType(business);

      // Strip SVC_ prefix from button IDs
      const cleaned = raw.startsWith('SVC_')
        ? raw.slice(4).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
        : raw;

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'DESCRIPTION',
        data: { ...data, serviceType: cleaned },
      });

      return {
        type: 'buttons',
        body: `Great — *${cleaned}* 👍\n\nCould you describe what you need in a bit more detail?\n\n_For example: the scope, goals, specific requirements, or any challenges._`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }

    // ── DESCRIPTION ──────────────────────────────────────────────────────────
    case 'DESCRIPTION': {
      if (!raw || raw.length < 10) {
        return {
          type: 'buttons',
          body: '📝 Please give us a bit more detail so we can quote accurately.\n\n_Describe your project, goals, or what you need done._',
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'BUDGET',
        data: { ...data, description: raw },
      });

      // [UX-SVC-2] 4 budget options exceed WhatsApp's 3-button cap — use a list.
      return {
        type: 'list',
        body: '💰 *Budget*\n\nDo you have a rough budget in mind?\n\n_This helps us tailor the right solution for you._',
        button: 'Choose budget',
        sections: [{ title: 'Budget Range', rows: [
          { id: 'BUDGET_DISCUSS', title: '💬 Discuss it',    description: 'Open to conversation'   },
          { id: 'BUDGET_SMALL',   title: '🟢 Under $500',    description: 'Small project budget'   },
          { id: 'BUDGET_MED',     title: '🟡 $500 – $2,000', description: 'Mid-range budget'       },
          { id: 'BUDGET_LARGE',   title: '🔴 $2,000+',       description: 'Larger project budget'  },
        ]}],
        footer: 'Or type your budget e.g. $800',
      };
    }

    // ── BUDGET ───────────────────────────────────────────────────────────────
    case 'BUDGET': {
      const BUDGET_MAP = {
        'BUDGET_DISCUSS': 'Open to discussion',
        'BUDGET_SMALL':   'Under $500',
        'BUDGET_MED':     '$500 – $2,000',
        'BUDGET_LARGE':   '$2,000+',
      };
      const budget = BUDGET_MAP[raw.toUpperCase()] || raw;

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'TIMELINE',
        data: { ...data, budget },
      });

      // [UX-SVC-1] 4 timeline options exceed WhatsApp's 3-button cap — use a list instead.
      return {
        type: 'list',
        body: '📅 *Timeline*\n\nWhen are you looking to get started or have this completed?',
        button: 'Choose timeline',
        sections: [{ title: 'When do you need this?', rows: [
          { id: 'TL_ASAP',  title: '🔥 ASAP',         description: 'Start immediately'    },
          { id: 'TL_WEEK',  title: '📆 This week',     description: 'Within 7 days'        },
          { id: 'TL_MONTH', title: '🗓 This month',    description: 'Within 30 days'       },
          { id: 'TL_FLEX',  title: '🌀 Flexible',      description: 'No rush, discuss it'  },
        ]}],
      };
    }

    // ── TIMELINE ─────────────────────────────────────────────────────────────
    case 'TIMELINE': {
      const TL_MAP = {
        'TL_ASAP':  'ASAP',
        'TL_WEEK':  'This week',
        'TL_MONTH': 'This month',
        'TL_FLEX':  'Flexible',
      };
      const timeline = TL_MAP[raw.toUpperCase()] || raw;
      const updatedData = { ...data, timeline };

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONTACT_CONFIRM',
        data: updatedData,
      });

      return {
        type: 'buttons',
        body: `📋 *Quote Summary*\n\n` +
          `🔧 *Service:* ${updatedData.serviceType || 'Not specified'}\n` +
          `📝 *Details:* ${updatedData.description}\n` +
          `💰 *Budget:* ${updatedData.budget}\n` +
          `📅 *Timeline:* ${timeline}\n\n` +
          `We'll send the quote to this WhatsApp number. Shall we proceed?`,
        buttons: [
          { id: 'ENQUIRY_CONFIRM', title: '✅ Yes, send quote' },
          { id: 'CANCEL',          title: '❌ Cancel'          },
        ],
      };
    }

    // ── CONTACT_CONFIRM ──────────────────────────────────────────────────────
    case 'CONTACT_CONFIRM': {
      // [FIX-DUALLAYER-CONFIRM] See core/nlu/resolution/confirmationMatcher.js — was
      // exact-match-only, so a typed "yes please"/"go ahead" never registered.
      const { resolveConfirmation } = await import('../../../core/nlu/nluFeature.js');
      const verdict = await resolveConfirmation({
        raw, business,
        affirmIds: ['ENQUIRY_CONFIRM', 'CONFIRM', 'YES'],
      });
      if (verdict === 'no') return cancelFlow(session, business);
      if (verdict !== 'yes') {
        return {
          type: 'buttons',
          body: 'Would you like us to send you a quote based on the details provided?',
          buttons: [
            { id: 'ENQUIRY_CONFIRM', title: '✅ Yes, send it' },
            { id: 'CANCEL',          title: '❌ Cancel'        },
          ],
        };
      }

      // Save as order record for admin visibility
      try {
        await saveOrder({
          tenantId:      session.tenantId,
          customerPhone: session.customerPhone,
          customerName:  session.customerName,
          item:          `[QUOTE] ${data.serviceType || 'Service Enquiry'}`,
          quantity:      1,
          notes:         `Desc: ${data.description} | Budget: ${data.budget} | Timeline: ${data.timeline}`,
          status:        'pending',
          // [FIX-SERVICES-1] businessId was missing — without it this quote-request record
          // has no link back to the BusinessConfig, breaking business-scoped admin views.
          businessId:    business._id,
        });
      } catch (err) {
        logger.warn('[Services] saveOrder failed for enquiry:', err.message);
        // [FIX-SAVE-ERR-SERVICES] Don't confirm a quote request that was never
        // persisted — the admin alert below would also be misleading.
        await updateSession(session.customerPhone, session.tenantId, {
          currentFlow: null, step: null, data: {},
        });
        return {
          type:    'buttons',
          body:    `⚠️ *Something went wrong submitting your quote request.*\n\nPlease try again — tap below to start over.`,
          buttons: [
            { id: 'ENQUIRY', title: '📋 Try Again'   },
            { id: 'SUPPORT', title: '💬 Contact Us'  },
          ],
        };
      }

      const adminPhones = getAdminPhones(business, tenant);
      const adminPhone  = getPrimaryAdminPhone(business, tenant);

      // Notify admin
      if (adminPhones.length && tenant) {
        try {
          const { dispatchText } = await import('../../../core/whatsapp/dispatcher.js');
          const alertBody =
            `🔔 *New Service Enquiry*\n\n` +
            `📞 From: ${session.customerPhone}\n` +
            `🔧 Service: ${data.serviceType || 'Not specified'}\n` +
            `📝 Details: ${data.description}\n` +
            `💰 Budget: ${data.budget}\n` +
            `📅 Timeline: ${data.timeline}`;
          for (const phone of adminPhones) {
            await dispatchText(phone, alertBody, tenant).catch(e =>
              logger.warn('[Services] admin notify failed for one recipient (non-fatal)', { err: e.message, phone })
            );
          }
        } catch (err) {
          logger.warn('[Services] admin notify failed:', err.message);
        }
      }

      // [FIX-1] Correct completeFlow signature: (session, completedFlow, business, tenant)
      // [FIX-2] Capture return value — completeFlow may return a lead-capture UIResponse
      const _lcRs = await completeFlow(session, 'ENQUIRY', business, tenant);
      if (_lcRs) return _lcRs;

      return {
        type: 'buttons',
        body: `✅ *Enquiry Received!*\n\nThank you! We've logged your enquiry and will be in touch with a personalised quote.\n\n` +
          (adminPhone ? `You can also reach us directly: 📞 *${adminPhone}*` : 'We\'ll be in touch shortly.'),
        buttons: [
          { id: 'BOOK',    title: '📅 Book a Call' },
          { id: 'SHOW_MENU', title: '🔄 Start Over' },
        ],
      };
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, { step: 'SERVICE_TYPE', data: {} });
      return _askServiceType(business);
  }
}

// ── Booking Flow ──────────────────────────────────────────────────────────────

export async function handleServicesBooking({ session, message, business, tenant, isInteractive }) {
  return handleBookingFlow({ session, message, business, tenant, isInteractive });
}

// ── Quote Follow-Up ───────────────────────────────────────────────────────────

export async function handleQuoteFollowUp({ session, message, business, tenant }) {
  const adminPhone = business?.adminPhone || tenant?.adminPhone;
  // [FIX-1] Correct completeFlow signature: (session, completedFlow, business, tenant)
  const _lcRqf = await completeFlow(session, 'QUOTE_FOLLOW', business, tenant);
  if (_lcRqf) return _lcRqf;
  return {
    type: 'buttons',
    body: '🔍 *Quote Follow-Up*\n\nWe\'d love to help you track your quote!\n\n' +
      (adminPhone
        ? `Please reach out directly and we'll look it up right away:\n📞 *${adminPhone}*`
        : 'Please contact us directly and we\'ll pull up your quote immediately.'),
    buttons: [
      { id: 'ENQUIRY',   title: '📋 New Quote'     },
      { id: 'BOOK',      title: '📅 Book a Call'   },
      { id: 'SHOW_MENU', title: '🔄 Start Over'    },
    ],
  };
}

// ── AI Question Handler ───────────────────────────────────────────────────────

export async function handleServicesQuestion({ session, message, business, tenant }) {
  const raw = String(message || '').trim();
  const { processQuestionMessage, persistQuestionSession } = await import('../../../services/question/questionAnswerService.js');
  const reply = await processQuestionMessage({ session, message: raw, business, tenant, intent: 'SERVICES_QUESTION' });
  await persistQuestionSession(session, tenant, reply.context || { lastMessage: raw });

  // Answer-only: stay in QUESTION mode and wait — no buttons. Switching activity
  // (e.g. asking for a quote, booking a consultation) is picked up upstream from
  // the customer's own words, not from a tap target.
  return {
    type: reply.type || 'text',
    body: reply.body,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _getServiceTypes(business) {
  // Use business's menu items as service categories if available
  const items = (business?.menuItems || []).filter(i => i.available !== false);
  if (items.length > 0) return items.slice(0, 8).map(i => i.name);
  return [
    'Web Design / Development',
    'Graphic Design',
    'Photography / Video',
    'Consulting / Strategy',
    'Writing / Copywriting',
    'Social Media Management',
    'IT / Tech Support',
    'Other',
  ];
}

function _askServiceType(business) {
  const serviceTypes = _getServiceTypes(business);
  // [FIX-LIST-CAP-2] same as the INIT handler above — dispatcher.js hard-caps
  // at 10 rows total (truncating with a footer hint past that), it does not
  // chunk into extra sections, so nothing needs pre-slicing here either.
  return {
    type: 'list',
    body:   '📋 *Get a Quote*\n\nWhat type of service are you looking for?',
    button: 'Choose service',
    sections: [{
      title: 'Service Types',
      rows: serviceTypes.map(s => ({ id: `SVC_${s.toUpperCase().replace(/\s+/g, '_')}`, title: s })),
    }],
    footer: 'Tap a service or type your own',
  };
}

