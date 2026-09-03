/**
 * modules/cosmetics/flows/index.js
 * Cosmetics module — products + skin profile + AI beauty recommendations + consultations
 */
import { updateSession }     from '../../../core/sessions/sessionService.js';
import { completeFlow }      from '../../../core/conversations/flowEngine.js';
import { handleBookingFlow } from '../../../core/conversations/bookingFlow.js';
import { getAIReply, findBestMatch } from '../../../core/nlu/nluFeature.js';
import { saveOrder }         from '../../../services/order/orderService.js';
import logger                from '../../../config/logger.js';

export const COSMETICS_CONFIG = {
  businessMode: 'COSMETICS',
  flows: ['ORDER', 'BOOKING'],
  persona: 'knowledgeable beauty advisor who gives personalised skincare and makeup recommendations',
  steps: {
    // [CART-AI] CART_REVIEW added — reached from SELECT_ITEM on a multi-item
    // message (shade-less products only), mirroring restaurant/salon/bakery.
    ORDER:   ['SELECT_ITEM', 'CART_REVIEW', 'SELECT_SHADE', 'QUANTITY', 'GIFT_NOTE', 'CONFIRM'],
    BOOKING: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: '💄 Shop Products'     },
      { id: 'BOOK',     title: '💅 Book Consultation' },
      { id: 'QUESTION', title: '❓ Beauty Advice'     },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '💄 Shop'    },
      { id: 'BOOK',     title: '💅 Consult' },
      { id: 'QUESTION', title: '❓ Advice'  },
    ],
    confirmButtons: [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
    upsellButtons:  [{ id: 'UPSELL_YES', title: '✅ Add it' }, { id: 'UPSELL_NO', title: '❌ No thanks' }],
  },
  messages: {
    welcome:   '💄 Welcome! Ready to glow? What can I help you find today?',
    cancelMsg: '✅ Cancelled! Come back anytime — we love helping you glow 💄',
    fallback:  'Would you like to *shop*, *book a consultation*, or get *beauty advice*?',
  },
};

// ── Dedicated cosmetics order flow ───────────────────────────────────────────
export { handleCosmeticsOrderFlow as handleCosmeticsOrder } from './orderFlow.js';

export async function handleCosmeticsBooking({ session, message, business, tenant, isInteractive }) {
  return handleBookingFlow({ session, message, business, tenant, isInteractive });
}

/** Skincare advice flow — AI-powered with skin type context */
export async function handleSkincareAdvice({ session, message, business, tenant }) {
  const raw  = String(message || '').trim();
  const step = session.step || 'SKIN_QUESTION';
  const data = session.data || {};

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, { step: 'SKIN_QUESTION', data: {} });
    // [UX-COSM-3] 4 skin-type options → WhatsApp list so all 4 show cleanly.
    return {
      type: 'list',
      body: '💄 *Beauty Advice*\n\nWhat would you like help with today?',
      button: 'Choose skin type',
      sections: [{ title: 'Skin Type', rows: [
        { id: 'SKIN_DRY',    title: '💧 Dry Skin',     description: 'Feels tight, flaky, or dull'       },
        { id: 'SKIN_OILY',   title: '✨ Oily Skin',    description: 'Shiny, prone to breakouts'         },
        { id: 'SKIN_COMBO',  title: '🌟 Combination',  description: 'Oily T-zone, dry cheeks'           },
        { id: 'SKIN_CUSTOM', title: '💬 Describe it',  description: 'Type your specific skin concern'   },
      ]}],
    };
  }

  // ── SKIN_QUESTION: customer picked a skin type button or typed their issue ─
  if (step === 'SKIN_QUESTION') {
    // [FIX] Map button IDs to human-readable skin type labels so AI gets
    // proper context instead of raw button IDs like "SKIN_DRY".
    const SKIN_TYPE_MAP = {
      'SKIN_DRY':   'dry',
      'SKIN_OILY':  'oily',
      'SKIN_COMBO': 'combination',
    };
    const mappedSkinType = SKIN_TYPE_MAP[raw.toUpperCase()] || null;
    const skinType = mappedSkinType || raw;

    // Store skin type and ask for the actual question
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SKIN_ADVICE',
      data: { ...data, skinType },
    });

    if (mappedSkinType) {
      // [UX-COSM-1] Offer common concern quick-picks as a list so the customer doesn't
      // have to type — most concerns map to one of these 5 options.
      return {
        type: 'list',
        body: `Got it — *${skinType} skin* 💄\n\nWhat's your main concern?`,
        button: 'Choose concern',
        sections: [{ title: 'Common Concerns', rows: [
          { id: 'CONCERN_ACNE',  title: '🔴 Acne / Breakouts',    description: 'Spots, pimples, oiliness'       },
          { id: 'CONCERN_DARK',  title: '🌑 Dark Spots / Uneven', description: 'Pigmentation, tone'              },
          { id: 'CONCERN_MOIST', title: '💧 Moisture / Dryness',  description: 'Hydration, flakiness'            },
          { id: 'CONCERN_AGE',   title: '✨ Anti-Ageing',          description: 'Fine lines, firmness'            },
          { id: 'CONCERN_SENSE', title: '🌿 Sensitive Skin',       description: 'Redness, irritation, reactions'  },
        ]}],
        footer: 'Or type your specific concern',
      };
    }
    // They typed a description — treat it as their question immediately
    return await _buildSkincareAdvice(raw, skinType, business, session);
  }

  // ── SKIN_ADVICE: they described their concern — answer it ─────────────────
  // [UX-COSM-2] Map concern button IDs to human-readable phrases for the AI prompt.
  const CONCERN_MAP = {
    'CONCERN_ACNE':  'acne and breakouts',
    'CONCERN_DARK':  'dark spots and uneven skin tone',
    'CONCERN_MOIST': 'dryness and lack of moisture',
    'CONCERN_AGE':   'fine lines and anti-ageing',
    'CONCERN_SENSE': 'sensitive skin, redness and irritation',
  };
  const mappedConcern = CONCERN_MAP[raw.toUpperCase()] || null;
  const concernText = mappedConcern || raw;
  return await _buildSkincareAdvice(concernText, data.skinType || null, business, session);
}

async function _buildSkincareAdvice(question, skinType, business, session) {
  const skinContext = skinType ? `The customer has ${skinType} skin. ` : '';
  const prompt = `${skinContext}The customer asks: "${question}"\n\nAs a beauty advisor, recommend 1-2 specific products (from our range if mentioned) and briefly explain why. Keep it friendly and under 3 sentences.`;

  const aiReply = await getAIReply({ customerMessage: prompt, business, session, intent: 'SKINCARE_ADVICE' });

  // [FIX-COSM-CF] completeFlow was imported but never called — the SKINCARE_ADVICE
  // flow stayed active in session after advice was delivered. On the customer's next
  // tap ('💄 Shop Now', '❓ Another Question', '🔄 Start Over') the session still had
  // currentFlow='SKINCARE_ADVICE', so advance() re-entered handleSkincareAdvice with
  // the button ID as the "question", producing a nonsensical AI beauty-advice response
  // instead of routing to ORDER/QUESTION/SHOW_MENU as intended. Calling completeFlow
  // here clears currentFlow/step/data and sets postFlowAck='SKINCARE_ADVICE' so the
  // customer's next message gets an appropriate warm reply.
  await completeFlow(session, 'SKINCARE_ADVICE', business, null);

  return {
    type: 'buttons',
    body: aiReply || 'Great question! Let me suggest some products for you. 💄',
    buttons: [
      { id: 'ORDER',     title: '💄 Shop Now'         },
      { id: 'QUESTION',  title: '❓ Another Question'  },
      { id: 'SHOW_MENU', title: '🔄 Start Over' },
    ],
  };
}

