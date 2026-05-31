/**
 * modules/salon/flows/index.js
 * Salon & Barbershop module — appointment booking + FAQ
 */
import { handleBookingFlow } from '../../../core/conversations/bookingFlow.js';
import { completeFlow }      from '../../../core/conversations/flowEngine.js';
import { updateSession }     from '../../../core/sessions/sessionService.js';

export const SALON_CONFIG = {
  businessMode: 'SALON',
  flows: ['BOOKING'],
  persona: 'professional, welcoming salon receptionist who helps clients book appointments',
  steps: {
    BOOKING: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },
  ui: {
    welcomeButtons: [
      { id: 'BOOK',     title: '💇 Book Appointment' },
      { id: 'QUESTION', title: '❓ Ask a Question'   },
    ],
    fallbackButtons: [
      { id: 'BOOK',     title: '💇 Book' },
      { id: 'QUESTION', title: '❓ Question' },
    ],
    confirmButtons: [{ id: 'CONFIRM', title: '✅ Confirm' }, { id: 'CANCEL', title: '❌ Cancel' }],
    upsellButtons:  [{ id: 'UPSELL_YES', title: '✅ Yes, add it' }, { id: 'UPSELL_NO', title: '❌ No thanks' }],
  },
  messages: {
    welcome:   '👋 Welcome! How can we help you today?',
    cancelMsg: "✅ No problem! Just tap below whenever you're ready.",
    fallback:  'Would you like to *book an appointment* or ask a *question*?',
  },
};

export const BARBERSHOP_CONFIG = {
  ...SALON_CONFIG,
  businessMode: 'BARBERSHOP',
  persona: 'friendly, confident barber who helps clients book cuts and answers style questions',
  ui: {
    ...SALON_CONFIG.ui,
    welcomeButtons: [
      { id: 'BOOK',     title: '💈 Book Appointment' },
      { id: 'QUESTION', title: '❓ Ask a Question'   },
    ],
    fallbackButtons: [
      { id: 'BOOK',     title: '💈 Book' },
      { id: 'QUESTION', title: '❓ Question' },
    ],
  },
  messages: {
    welcome:   '✂️ Welcome! Ready for a fresh cut? How can we help?',
    cancelMsg: "✅ No problem! Just tap below whenever you're ready. ✂️",
    fallback:  'Would you like to *book an appointment* or ask a *question*?',
  },
};

export async function handleSalonBooking({ session, message, business, tenant, isInteractive }) {
  return handleBookingFlow({ session, message, business, tenant, isInteractive });
}
