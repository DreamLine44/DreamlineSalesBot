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
import { completeFlow }      from '../../../core/conversations/flowEngine.js';
import { handleBookingFlow } from '../../../core/conversations/bookingFlow.js';
import { getAIReply }        from '../../../core/ai/providers/aiRouter.js';
import { saveOrder }         from '../../../services/orderService.js';
import logger                from '../../../config/logger.js';

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
    welcomeButtons: [
      { id: 'ENQUIRY',      title: '📋 Get a Quote'        },
      { id: 'BOOK',         title: '📅 Book Consultation'  },
      { id: 'QUOTE_FOLLOW', title: '🔍 Follow Up on Quote' },
      { id: 'QUESTION',     title: '❓ Ask a Question'     },
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
    return {
      type: 'list',
      body: '📋 *Get a Quote*\n\nWhat type of service are you looking for?\n\n_(Tap one below or type your answer)_',
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
        ],
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
      if (!['ENQUIRY_CONFIRM', 'CONFIRM', 'YES'].includes(raw.toUpperCase())) {
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
        });
      } catch (err) {
        logger.warn('[Services] saveOrder failed for enquiry:', err.message);
      }

      const adminPhone = business?.adminPhone;

      // Notify admin
      if (adminPhone && tenant) {
        try {
          const { dispatchText } = await import('../../../core/whatsapp/dispatcher.js');
          await dispatchText(
            adminPhone,
            `🔔 *New Service Enquiry*\n\n` +
            `📞 From: ${session.customerPhone}\n` +
            `🔧 Service: ${data.serviceType || 'Not specified'}\n` +
            `📝 Details: ${data.description}\n` +
            `💰 Budget: ${data.budget}\n` +
            `📅 Timeline: ${data.timeline}`,
            tenant,
          );
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
  const adminPhone = business?.adminPhone;
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
  const aiReply = await getAIReply({
    customerMessage: String(message || '').trim(),
    business,
    session,
    intent: 'SERVICES_QUESTION',
  });
  // [FIX-1] Correct completeFlow signature: (session, completedFlow, business, tenant)
  const _lcRsq = await completeFlow(session, 'QUESTION', business, tenant);
  if (_lcRsq) return _lcRsq;
  return {
    type: 'buttons',
    body: aiReply || 'Happy to help! Feel free to ask us anything about our services.',
    buttons: [
      { id: 'ENQUIRY', title: '📋 Get a Quote'       },
      { id: 'BOOK',    title: '📅 Book Consultation' },
    ],
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
  return {
    type: 'list',
    body: '📋 *Get a Quote*\n\nWhat type of service are you looking for?',
    sections: [{
      title: 'Service Types',
      rows: serviceTypes.map(s => ({ id: `SVC_${s.toUpperCase().replace(/\s+/g, '_')}`, title: s })),
    }],
    footer: 'Tap a service or type your own',
  };
}
