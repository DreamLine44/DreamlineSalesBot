/**
 * core/ai/providers/aiRouter.js
 *
 * THE ONLY AI ENTRY POINT for all business logic.
 *
 * Provider selection (runtime, based on env vars):
 *   1. Groq    — if GROQ_API_KEY is set
 *   2. Mock    — always available, zero cost
 *
 * Adding a new provider:
 *   1. Create src/core/ai/providers/newProvider.js with getReply/generateGreeting/healthCheck
 *   2. Add to PROVIDERS map below
 *   3. Set AI_PROVIDER=new in .env
 *   ZERO business logic changes required.
 *
 * AI ROLE — strictly enforced here and in providers:
 *   ✅ Unclear messages, FAQ, recommendations, greetings, upsell text
 *   ❌ Flow state, cart totals, booking logic, scheduling, prices
 *
 * [AI-OPT-1] getAIReply: accepts optional orderContext param and passes it through
 *            to groqProvider.getReply. When called from ORDER_CONFIRMED postFlowAck,
 *            the AI system prompt now includes the active order details so responses
 *            are grounded in context (e.g. "your Jollof Rice is being prepared").
 */

import * as groqProvider from './groqProvider.js';
import * as mockProvider from './mockProvider.js';
import logger from '../../../config/logger.js';

// ── Provider registry ─────────────────────────────────────────────────────────
const PROVIDERS = { groq: groqProvider, mock: mockProvider };

function getProvider() {
  if (process.env.GROQ_API_KEY) return groqProvider;
  return mockProvider;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * getAIReply({ customerMessage, business, session, intent, history, orderContext, sessionContext })
 * Returns string | null
 *
 * [AI-OPT-1] orderContext: optional active order details for ORDER_CONFIRMED post-flow context.
 * [GROQ-V3-8] sessionContext: optional string for active-flow grounding (walk-in queue, etc.).
 */
export async function getAIReply({ customerMessage, business, session, intent = 'FALLBACK', history = [], orderContext = null, sessionContext = null }) {
  try {
    const provider = getProvider();
    const result   = await provider.getReply({ customerMessage, business, intent, history, orderContext, sessionContext });
    if (!result?.text) return null;
    logger.debug('[AI] Reply', { source: result.source, intent });
    return result.text;
  } catch (err) {
    logger.error('[AI] getAIReply failed', { err: err.message });
    // Always fall back to mock — never throw to callers
    const mock = await mockProvider.getReply({ customerMessage, business, intent });
    return mock.text;
  }
}

/**
 * generateGreeting({ business, customerName, lastOrder })
 * Returns string
 */
export async function generateGreeting({ business, customerName, lastOrder, orderCount = 0, vipThreshold = 5 }) {
  try {
    const provider = getProvider();
    const result   = await provider.generateGreeting({ business, customerName, lastOrder, orderCount, vipThreshold });
    return result?.text || `👋 Welcome back, ${customerName || 'there'}!`;
  } catch {
    return `👋 Welcome back, ${customerName || 'there'}!`;
  }
}

/**
 * aiHealthCheck()
 * Returns { groq: { ok, model, latencyMs?, error? } }
 */
export async function aiHealthCheck() {
  const groqStatus = process.env.GROQ_API_KEY
    ? await groqProvider.healthCheck()
    : { ok: false, model: 'llama-3.1-8b-instant', error: 'No GROQ_API_KEY' };

  return { groq: groqStatus, mock: { ok: true, model: 'mock' } };
}
