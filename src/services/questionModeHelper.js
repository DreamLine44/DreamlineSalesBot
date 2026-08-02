/**
 * services/questionModeHelper.js
 *
 * Shared helpers for Question Mode (Prompt 3 + 7 + 8).
 */

const OFF_TOPIC_RE = /\b(weather|forecast|temperature|president|election|politics|football\s*score|premier\s*league|bitcoin|crypto|stock\s*market|who\s+is\s+the\s+president|tell\s+me\s+a\s+joke|write\s+(me\s+)?a\s+(poem|story|essay)|homework|math\s+problem)\b/i;

const RESTAURANT_TOPIC_RE = /\b(menu|food|dish|meal|order|booking|book|table|price|cost|how\s+much|allergen|gluten|nut|dairy|vegan|halal|hours|open|close|opening|closing|promo|discount|policy|payment|pay|wave|cash|contact|phone|address|location|delivery|pickup|collect|ingredient|special|today|tonight|tomorrow)\b/i;

/**
 * Returns false when the message is clearly unrelated to restaurant services.
 */
export function isRestaurantScopeQuestion(message) {
  const raw = String(message || '').trim();
  if (!raw || raw.length < 3) return true;
  if (OFF_TOPIC_RE.test(raw)) return false;
  if (RESTAURANT_TOPIC_RE.test(raw)) return true;
  // Short ambiguous questions — allow (AI can clarify); block only obvious off-topic.
  return raw.length <= 80;
}

/**
 * Preserve activity-specific session data when switching activities (Prompt 8).
 * Status information must never be stored here — only flow context.
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
