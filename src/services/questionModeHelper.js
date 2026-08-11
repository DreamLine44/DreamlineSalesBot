/**
 * services/questionModeHelper.js
 *
 * Shared helpers for Question Mode (Prompt 3 + 7 + 8).
 */

const OFF_TOPIC_RE = /\b(weather|forecast|temperature|president|election|politics|football\s*score|premier\s*league|bitcoin|crypto|stock\s*market|who\s+is\s+the\s+president|tell\s+me\s+a\s+joke|write\s+(me\s+)?a\s+(poem|story|essay)|homework|math\s+problem)\b/i;

const RESTAURANT_TOPIC_RE = /\b(menu|food|dish|meal|order|booking|book|table|price|cost|how\s+much|allergen|gluten|nut|dairy|vegan|halal|hours|open|close|opening|closing|promo|discount|policy|payment|pay|wave|cash|contact|phone|address|location|delivery|pickup|collect|ingredient|special|today|tonight|tomorrow|track|status|ref|reference|#\w+)\b/i;

const SALON_TOPIC_RE = /\b(service|hair|cut|style|salon|barber|appointment|booking|walk.?in|queue|price|cost|hours|open|close|aftercare|product|track|status|ref|reference)\b/i;

const GENERAL_TOPIC_RE = /\b(service|product|price|cost|hours|open|close|booking|order|contact|phone|address|location|payment|policy|about|track|status|ref|reference)\b/i;

/**
 * Returns false when the message is clearly unrelated to business services.
 * Mode-aware — no longer restaurant-only.
 */
export function isBusinessScopeQuestion(message, business = null) {
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

/** @deprecated Use isBusinessScopeQuestion — kept for backward compatibility. */
export function isRestaurantScopeQuestion(message) {
  return isBusinessScopeQuestion(message, { businessMode: 'RESTAURANT' });
}

/**
 * Preserve activity-specific session data when switching activities (Prompt 8).
 */
export function snapshotActivityData(session, activity) {
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
export function mergeQuestionContext(session, patch = {}) {
  const prev = session?.data?._questionCtx || {};
  return {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

/** Compact context block for AI prompts. */
export function buildQuestionContextBlock(session) {
  const ctx = session?.data?._questionCtx;
  if (!ctx) return '';
  const parts = [];
  if (ctx.lastReference) parts.push(`Customer is discussing activity #${ctx.lastReference}.`);
  if (ctx.lastTopic) parts.push(`Current topic: ${ctx.lastTopic}.`);
  if (ctx.lastMessage) parts.push(`Previous question: "${String(ctx.lastMessage).slice(0, 120)}"`);
  return parts.length ? `Question mode context:\n${parts.join('\n')}` : '';
}
