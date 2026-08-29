/**
 * services/questionModeHelper.js
 *
 * Shared helpers for Question Mode (Prompt 3 + 7 + 8).
 */

import { INTENT_PATTERNS } from '../../core/intents/patterns.js';

const OFF_TOPIC_RE = /\b(weather|forecast|temperature|president|election|politics|football\s*score|premier\s*league|bitcoin|crypto|stock\s*market|who\s+is\s+the\s+president|tell\s+me\s+a\s+joke|write\s+(me\s+)?a\s+(poem|story|essay)|homework|math\s+problem)\b/i;

/** Free-form human-handoff phrasing that is not an exact SUPPORT keyword match. */
const HUMAN_HANDOFF_RE = /\b(?:(?:talk|speak|connect\s*me)\s*(?:to|with)\s*(?:an?\s*)?(?:real\s*)?(?:human|person|agent|someone|manager|owner|boss|staff|admin|team|support)|(?:i\s*(?:want|need)\s*(?:to\s*)?(?:talk|speak)\s*(?:to|with)\s*(?:an?\s*)?(?:human|person|agent|someone|manager|owner|boss|staff|admin|the\s+boss|a\s+real\s+person))|human\s+please|real\s+person\s+please|customer\s+service)\b/i;

/** Customer wants to stay in Q&A — not switch to order/booking. */
const STAY_IN_QUESTION_RE = /\b(still asking|keep asking|am still asking|i'?m still asking|just asking|still have questions|more questions|continue asking|asking questions|not ready to (?:book|order)|don'?t want to (?:book|order) yet)\b/i;

/** Bare greetings — should show the welcome menu, not a text-only AI reply. */
const GREETING_ONLY_RE = /^(?:hi|hello|hey|hiya|howdy|yo|sup|good morning|good afternoon|good evening|greetings|salaam|salam)[!.?\s]*$/i;

const RESTAURANT_TOPIC_RE = /\b(menu|food|dish|meal|order|booking|book|table|price|cost|how\s+much|allergen|gluten|nut|dairy|vegan|halal|hours|open|close|opening|closing|promo|discount|policy|payment|pay|wave|cash|contact|phone|address|location|delivery|pickup|collect|ingredient|special|today|tonight|tomorrow|track|status|ref|reference|#\w+)\b/i;

const SALON_TOPIC_RE = /\b(service|hair|cut|style|salon|barber|appointment|booking|walk.?in|queue|price|cost|hours|open|close|aftercare|product|track|status|ref|reference)\b/i;

const GENERAL_TOPIC_RE = /\b(service|product|price|cost|hours|open|close|booking|order|contact|phone|address|location|payment|policy|about|track|status|ref|reference)\b/i;

/**
 * Returns false when the message is clearly unrelated to business services.
 * Mode-aware — no longer restaurant-only.
 */
export const isBusinessScopeQuestion = (message, business = null) => {
  const raw = String(message || '').trim();
  if (!raw || raw.length < 3) return true;
  if (OFF_TOPIC_RE.test(raw)) return false;

  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  if (mode === 'SALON' || mode === 'BARBERSHOP') {
    if (SALON_TOPIC_RE.test(raw)) return true;
  } else if (mode === 'RESTAURANT' || mode === 'BAKERY' || mode === 'DELIVERY') {
    if (RESTAURANT_TOPIC_RE.test(raw)) return true;
  } else if (GENERAL_TOPIC_RE.test(raw)) {
    return true;
  }

  return raw.length <= 100;
}

/**
 * True when the customer is asking *about* booking/ordering options — not
 * requesting to start those flows ("what can I book?" vs "book a table").
 */
export const isInformationalActivityQuestion = (message) => {
  const clean = String(message || '').toLowerCase().replace(/[^\w\s?']/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return false;

  if (/\b(i want to|i d like to|let me|book me|reserve me|book a|reserve a|table for|party of|book for)\b/.test(clean)) {
    return false;
  }
  if (/\bwhat is this (?:all )?about\b/.test(clean)) return true;
  if (/\bhow does (?:booking|ordering|reservation) work\b/.test(clean)) return true;
  if (/\bwhat (?:do you|can you|could you) (?:offer|have|provide|serve)\b/.test(clean)) {
    if (/\b(?:menu|food|dishes?|meals?|eat)\b/.test(clean)) return false;
    if (/\b(?:book|reserve|booking|reservation|table|appointment)\b/.test(clean)) return true;
  }

  if (/\bwhat\b/.test(clean) && /\b(?:book|order|reserve|booking|reservation)\b/.test(clean)) {
    if (/\bwhat (?:can|could|do|should|is|are)\b/.test(clean)) return true;
    if (/\bwhat\b[\s\w]{0,25}\b(?:book|order|reserve)\b/.test(clean)) return true;
  }
  return false;
}

/** True when the customer explicitly wants to remain in question mode. */
export const isStayInQuestionMessage = (message) => {
  const raw = String(message || '').trim();
  if (!raw) return false;
  return STAY_IN_QUESTION_RE.test(raw);
}

/** True for bare hi/hello/hey — route to welcome menu with options, not AI text. */
export const isGreetingMessage = (message) => {
  const raw = String(message || '').trim();
  if (!raw) return false;
  return GREETING_ONLY_RE.test(raw);
}

/**
 * True when the customer wants to speak to a human — must route to SUPPORT,
 * never to catalog/order flows. "i want to talk to human" contains "i want"
 * (ORDER_DIRECT_RE) so this guard must run before catalog/order intercepts.
 */
export const isHumanHandoffRequest = (message) => {
  const raw = String(message || '').trim();
  if (!raw || raw.length < 3) return false;

  const clean = raw.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (HUMAN_HANDOFF_RE.test(clean)) return true;

  const words = clean.split(' ');
  for (const kw of (INTENT_PATTERNS.SUPPORT || [])) {
    if (kw.includes(' ')) {
      if (clean === kw || clean.startsWith(kw + ' ') || clean.endsWith(' ' + kw)
          || clean.includes(' ' + kw + ' ') || clean.includes(' ' + kw)) {
        return true;
      }
    } else if (words.includes(kw)) {
      return true;
    }
  }
  return false;
}

/** Booking/reservation info ask — should be answered in Q&A, not open WA Catalog. */
export const isBookingInfoQuestion = (message) => {
  const raw = String(message || '').trim();
  if (!raw || !/\b(?:book|reserve|booking|reservation|table|appointment)\b/i.test(raw)) return false;
  if (/\b(?:menu|food|dishes?|meals?|eat)\b/i.test(raw)) return false;
  return isInformationalActivityQuestion(raw);
}

/** @deprecated Use isBusinessScopeQuestion — kept for backward compatibility. */
export const isRestaurantScopeQuestion = (message) => {
  return isBusinessScopeQuestion(message, { businessMode: 'RESTAURANT' });
}

/**
 * Preserve activity-specific session data when switching activities (Prompt 8).
 */
export const snapshotActivityData = (session, activity) => {
  const flow = (activity || session.currentFlow || '').toUpperCase();
  const data = session.data || {};
  if (flow === 'ORDER') {
    return { cart: data.cart, item: data.item, orderViaCatalog: data.orderViaCatalog };
  }
  if (flow === 'BOOKING') {
    return {
      service: data.service, date: data.date, time: data.time,
      partySize: data.partySize, staff: data.staff,
    };
  }
  if (flow === 'QUESTION' || flow === 'ENQUIRY') {
    return { _questionCtx: data._questionCtx || null };
  }
  return {};
}

/** Merge new question context into session state. */
export const mergeQuestionContext = (session, patch = {}) => {
  const prev = session?.data?._questionCtx || {};
  return {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

/** Compact context block for AI prompts. */
export const buildQuestionContextBlock = (session) => {
  const ctx = session?.data?._questionCtx;
  if (!ctx) return '';
  const parts = [];
  if (ctx.lastReference) parts.push(`Customer is discussing activity #${ctx.lastReference}.`);
  if (ctx.lastTopic) parts.push(`Current topic: ${ctx.lastTopic}.`);
  if (ctx.lastMessage) parts.push(`Previous question: "${String(ctx.lastMessage).slice(0, 120)}"`);
  return parts.length ? `Question mode context:\n${parts.join('\n')}` : '';
}
