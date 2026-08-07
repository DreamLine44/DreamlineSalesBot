/**
 * enhancedNlu.js — production-safe Groq understanding layer.
 *
 * Sits in front of existing business logic: improves intent + entity extraction
 * for natural language, then falls back to the legacy classifyIntent() on any
 * failure. Deterministic routing (buttons, keywords, guards) is unchanged.
 */

import logger from '../../config/logger.js';
import { findBestMatch } from '../../utils/matchEngine.js';
import {
  isEnhancedNluEnabled,
  sanitiseNluMessage,
  buildConversationContext,
  getAiHistoryMessages,
} from './nluContext.js';

export { isEnhancedNluEnabled };

const CONFIDENCE_LEVELS = new Set(['HIGH', 'MEDIUM', 'LOW']);

/**
 * Resolve AI-extracted product names against the tenant menu.
 * Only HIGH-confidence fuzzy matches are kept — never guess.
 */
export function resolveProductEntities(products, business) {
  if (!Array.isArray(products) || products.length === 0) return [];

  const menu = [
    ...(business?.menuItems || []).filter(i => i.available !== false),
    ...(business?.services || [])
      .filter(s => s.available !== false)
      .map(s => ({ ...s, name: s.name, price: s.price ?? 0, available: true })),
  ];

  if (!menu.length) return [];

  const resolved = [];
  for (const p of products) {
    const name = String(p?.name || p?.product || '').trim();
    if (name.length < 2) continue;

    const qtyRaw = parseInt(p?.quantity ?? p?.qty, 10);
    const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.min(qtyRaw, 99) : 1;

    const { item, confidenceLevel } = findBestMatch(menu, name);
    if (item && confidenceLevel === 'HIGH') {
      resolved.push({ item, quantity, variant: null, matchedFrom: name });
    }
  }
  return resolved;
}

/** Parse JSON from model output — tolerates markdown fences. */
function parseStructuredNluResponse(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * classifyMessageEnhanced — primary NLU entry for step 7 of detectIntent.
 *
 * @returns {{
 *   intent: string,
 *   confidence: 'HIGH'|'MEDIUM'|'LOW',
 *   entities?: { products?: Array, questions?: string[] },
 *   secondaryIntents?: string[],
 *   clarification?: string|null,
 *   source: 'enhanced-nlu'|'legacy-fallback',
 * }}
 */
export async function classifyMessageEnhanced({ message, business, session, validIntents }) {
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  const sanitised = sanitiseNluMessage(message);

  if (!isEnhancedNluEnabled() || sanitised.length < 4) {
    return legacyClassify({ message: sanitised, validIntents, mode });
  }

  try {
    const { classifyMessageStructured } = await import('../ai/providers/groqProvider.js');
    const contextBlock = buildConversationContext({ session, business });
    const history = getAiHistoryMessages(session);
    const menuSample = buildMenuSample(business);

    const structured = await classifyMessageStructured({
      message:      sanitised,
      validIntents,
      mode,
      contextBlock,
      history,
      menuSample,
    });

    if (!structured?.primaryIntent) {
      return legacyClassify({ message: sanitised, validIntents, mode });
    }

    const intent = validIntents.includes(structured.primaryIntent)
      ? structured.primaryIntent
      : 'UNKNOWN';

    let confidence = CONFIDENCE_LEVELS.has(structured.confidence)
      ? structured.confidence
      : 'MEDIUM';

    if (intent === 'UNKNOWN') confidence = 'LOW';
    if (structured.clarificationNeeded && confidence === 'HIGH') confidence = 'MEDIUM';

    const rawProducts = Array.isArray(structured.entities?.products)
      ? structured.entities.products
      : [];

    const resolvedProducts = resolveProductEntities(rawProducts, business);

    const secondaryIntents = (structured.secondaryIntents || [])
      .map(i => String(i).toUpperCase())
      .filter(i => validIntents.includes(i) && i !== intent);

    return {
      intent,
      confidence,
      entities: {
        products:  resolvedProducts,
        questions: Array.isArray(structured.entities?.questions)
          ? structured.entities.questions.map(String).slice(0, 3)
          : [],
      },
      secondaryIntents,
      clarification: structured.clarificationNeeded
        ? (structured.clarificationQuestion || null)
        : null,
      source: 'enhanced-nlu',
    };
  } catch (err) {
    logger.warn('[EnhancedNLU] structured classify failed — falling back', { err: err.message });
    return legacyClassify({ message: sanitised, validIntents, mode });
  }
}

async function legacyClassify({ message, validIntents, mode }) {
  try {
    const { classifyIntent } = await import('../ai/providers/groqProvider.js');
    const result = await classifyIntent({ message, validIntents, mode });
    return {
      ...result,
      entities:        { products: [], questions: [] },
      secondaryIntents: [],
      clarification:   null,
      source:          'legacy-fallback',
    };
  } catch {
    return {
      intent: 'UNKNOWN', confidence: 'LOW',
      entities: { products: [], questions: [] },
      secondaryIntents: [], clarification: null,
      source: 'legacy-fallback',
    };
  }
}

function buildMenuSample(business) {
  const items = (business?.menuItems || [])
    .filter(i => i.available !== false)
    .slice(0, 30)
    .map(i => i.name);
  if (!items.length) return '';
  return `Available products (match customer wording to these names): ${items.join(', ')}`;
}
