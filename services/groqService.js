/**
 * services/groqService.js — Dreamline Sales Bot v5.0
 *
 * AI layer — powered by Groq/Llama.
 *
 * v4.0 IMPROVEMENTS (merged from v1.2 + v3.3 + enhancements):
 * Automatic retry with exponential back-off on transient Groq errors
 *             (rate-limit 429, server error 5xx). Max 2 retries.
 * Model cascade: tries llama-3.1-8b-instant first (fastest/cheapest),
 *             falls back to llama-3.3-70b-versatile on repeated failure so the
 *             bot NEVER silently dies if the small model is overloaded.
 * exportable groqHealthCheck() — call on startup / cron to validate
 *             the API key is live before the first customer message arrives.
 * Structured log for every Groq call: model used, latency, tokens —
 *             lets you spot regressions in production instantly.
 * GROQ_API_KEY absence is caught in ONE place and surfaced clearly;
 *             every exported function gracefully degrades to standardFallback().
 *
 * Sales-assistant behaviour (preserved from v3.1):
 * System prompt rewritten as focused WhatsApp sales assistant.
 *        NO chatty AI behaviour. Every response drives toward: buy / book / info.
 * Tone: professional, short, action-driven. No long paragraphs.
 *        Minimal emojis. Zero unnecessary conversation.
 * FALLBACK prompt attempts ONE clarification question (not a menu dump).
 * ABOUT / GREET prompts redirect to order/booking at the end.
 * standardFallback uses sales-focused language + single CTA.
 * Anti-spam: AI is instructed NEVER to ask follow-up questions unprompted.
 *
 * Mode-awareness (preserved from v3.1):
 * BOOKING-only businesses never see "Order" as option.
 * Session context (current step, last message) feeds AI for coherent follow-ups.
 * Auto-upgrade FALLBACK → ABOUT for about-questions.
 * generateGreeting for GREET action.
 * isAboutQuestion exported for brainService routing.
 */

import { resolveFaq, buildFaqContext } from './faqService.js';
import { getModeConfig }               from '../config/modes.js';
import logger                          from '../config/logger.js';

// ─── Groq config ──────────────────────────────────────────────────────────────

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Model cascade — fastest/cheapest first, most capable as fallback.
 * If the primary model is overloaded (503/429 persists), Groq
 * automatically switches to the secondary so production never goes dark.
 */
const GROQ_MODELS = [
  'llama-3.1-8b-instant',      // Primary: ultra-fast, 131k ctx, free tier
  'llama-3.3-70b-versatile',   // Fallback: higher accuracy for tough queries
];

const TIMEOUT_MS    = 9000;  // Per-attempt timeout (ms)
const MAX_RETRIES   = 2;     // Max retry attempts per model before cascade
const RETRY_BASE_MS = 400;   // Base back-off delay (doubles each retry)

// ─── Build system prompt ──────────────────────────────────────────────────────

const buildSystemPrompt = (business, session, intent = 'FALLBACK') => {
  const name     = business?.name        || 'this business';
  const desc     = business?.description || '';
  const menu     = business?.menu        || [];
  const tone     = business?.tone?.style    || 'PROFESSIONAL';
  const industry = business?.tone?.industry || 'GENERAL';

  const cfg      = getModeConfig(business);
  const canOrder = cfg.flows.includes('ORDER');
  const canBook  = cfg.flows.includes('BOOKING');

  const menuText = menu.length > 0
    ? menu.filter((i) => i.available !== false)
          .map((i, idx) => `${idx + 1}. ${i.name}${i.price > 0 ? ` — D${i.price}` : ''}`)
          .join('\n')
    : 'No menu available.';

  const capabilities = [
    canOrder ? 'placing orders' : null,
    canBook  ? 'booking services' : null,
  ].filter(Boolean).join(' and ');

  // ── STRICT GROQ RULES (enforced via system prompt) ────────────────────────
  // Groq is a CONTROLLED FALLBACK ONLY. It must NEVER:
  //   - trigger order/booking flows
  //   - guess commands or interpret intents as actions
  //   - override system routing decisions
  //   - send unsolicited follow-ups
  // It MUST always end responses with the options menu so the user knows next steps.

  // Strict Groq enforcement — injected into every system prompt
  const STRICT_GROQ_RULE = `
CRITICAL CONSTRAINTS (non-negotiable):
- You are a safe information assistant ONLY.
- NEVER say you will place an order, make a booking, or execute any action.
- NEVER trigger, confirm, or guess commands.
- ONLY answer factual questions about ${name}: menu, prices, hours, location, payment.
- Maximum 3 short sentences per response.
- Always end with: "Type *order*, *book*, or *question* to continue."
- If the question is not about ${name}, respond: "I can only assist with ${name} questions. Type *order*, *book*, or *question*."
`;

  const cta = [
    canOrder ? 'type *Order* to buy' : null,
    canBook  ? 'type *Book* to schedule' : null,
  ].filter(Boolean).join(', or ');

  const toneRule =
    tone === 'PREMIUM'  ? 'Formal, refined, polished. No slang. No emojis.' :
    tone === 'FRIENDLY' ? 'Warm and friendly. One emoji max per message.' :
                          'Clear and professional. Minimal emojis.';

  const faqContext = buildFaqContext(business);

  // Full context assembled in intentInstructions per-intent — built below
  // (currentFlow, currentStep, activeOrderCtx etc are declared there)

  // Intent-specific instructions — sales assistant persona
  // Richer session context for AI memory
  const currentFlow    = session?.currentFlow;
  const currentStep    = session?.step;
  const lastIntent     = session?.lastIntent;
  const lastMsg        = session?.lastMessage;

  const activeOrderCtx = currentFlow === 'ORDER' ? (() => {
    const { item, quantity, totalPrice } = session?.data || {};
    const parts = [];
    if (item)       parts.push(`Item: ${item}`);
    if (quantity)   parts.push(`Qty: ${quantity}`);
    if (totalPrice) parts.push(`Total: D${totalPrice}`);
    return parts.length ? `Current order in progress: ${parts.join(', ')}.` : '';
  })() : '';

  const wavePhone = business?.payment?.wavePhone?.trim() || business?.wavePhone?.trim() || null;
  const currency  = business?.payment?.currency || 'GMD';

  // ── [v6-MERGE] Explicit payment context injected for every intent ─────────
  // Complements the dedicated PAYMENT intent prompt — ensures ALL intents
  // (FALLBACK, ABOUT, REPEAT) give coherent payment guidance when relevant.
  let paymentContext = '';
  if (currentFlow === 'ORDER') {
    if (currentStep === 'PAYMENT_PROOF') {
      paymentContext =
        `PAYMENT CONTEXT: The customer has confirmed their order. ` +
        `They must now send a Wave payment screenshot to complete it. ` +
        `If they ask about payment, tell them to send their Wave screenshot here now.`;
    } else {
      paymentContext =
        `PAYMENT CONTEXT: Payment is via Wave mobile money` +
        (wavePhone ? ` to *${wavePhone}*` : '') + `. ` +
        `If asked about payment, say: "You can pay using Wave after confirming your order." ` +
        `DO NOT discuss payment details until the order is confirmed.`;
    }
  }

  const intentInstructions = {

    GREET: `
Task: Write a SHORT, warm, and friendly welcome message for "${name}".
- Be conversational and welcoming — like a helpful shop assistant greeting a customer.
- 1-2 sentences max. Use a friendly emoji if it suits the business tone.
- End with ONE clear, inviting call to action so the customer knows what they can do.
- Do NOT list every option. Pick the single most useful next step.
Example: "Welcome to ${name}! 😊 Type *Order* to browse our menu, or *Hi* to see everything we offer."`,

    ABOUT: `
Task: Answer the customer's question about the business briefly.
- Max 3 sentences using the business description.
- End with a single, clear next step: ${cta || 'type *Hi* to get started'}.
- Do not enter a long conversation.`,

    FALLBACK: `
Task: The customer said something unclear.
- Ask ONE short clarifying question to understand what they need.
- Do not list all options. Do not explain what the bot can do at length.
- If you cannot guess intent at all, say: "What would you like to do — order, book, or ask a question?"
- Max 2 sentences.`,

    REPEAT: `
Task: The customer has sent the same message multiple times.
- Acknowledge briefly (1 sentence).
- Guide them to the next correct action (1 sentence).
- Do not repeat their message back. Do not apologise excessively.`,

    PAYMENT: `
Task: Explain the payment process clearly and briefly.
${wavePhone
  ? `- Payment is via *Wave* mobile money to: *${wavePhone}*`
  : '- Payment method: Wave mobile money (ask the business for the Wave number)'}
- Currency: *${currency}*
${currentFlow === 'ORDER'
  ? `- Customer has an active order. Tell them to confirm their order first, then payment details will be shown.`
  : `- Guide them to place an order first, then payment will follow.`}
- Max 2 sentences.
- DO NOT confirm the order. DO NOT change any totals.
- End by telling them what to do next (confirm order, or type Order to start).`,

  }[intent] || 'Respond helpfully in 1-2 sentences. Never expose technical errors.';

  return (
    STRICT_GROQ_RULE + '\n\n' +
    `You are a WhatsApp sales assistant for "${name}", a ${industry.toLowerCase()} business.\n` +
    `Your ONLY job is to help customers with: ${capabilities}.\n\n` +
    (currentFlow
      ? `CUSTOMER CONTEXT:\n` +
        `- Active flow: ${currentFlow} | Step: ${currentStep || 'unknown'}\n` +
        (activeOrderCtx ? `- ${activeOrderCtx}\n` : '') +
        (lastIntent ? `- Last detected intent: ${lastIntent}\n` : '') +
        (lastMsg    ? `- Last message: "${lastMsg}"\n` : '') +
        '\n'
      : 'Customer has no active flow.\n\n') +
    (paymentContext ? `${paymentContext}\n\n` : '') +
    (desc ? `ABOUT THE BUSINESS:\n${desc}\n\n` : '') +
    (canOrder && menuText !== 'No menu available.' ? `MENU:\n${menuText}\n\n` : '') +
    (faqContext ? `${faqContext}\n\n` : '') +
    `YOUR TASK:\n${intentInstructions}\n\n` +
    `STRICT RULES (never break these):\n` +
    `- NEVER confirm an order, change quantities, or modify any totals. That is the flow's job.\n` +
    `- NEVER say "your order is confirmed" or "I've added X to your order".\n` +
    `- You are a sales assistant, NOT a chatbot. Do NOT have long conversations.\n` +
    `- NEVER reveal you are an AI, Groq, or Llama.\n` +
    `- NEVER discuss topics unrelated to this business.\n` +
    `- NEVER send follow-up messages or reminders unprompted.\n` +
    `- NEVER repeat the same message twice.\n` +
    `- Keep responses SHORT — this is WhatsApp. Max 3 sentences unless listing items.\n` +
    `- Do NOT ask multiple questions. Ask ONE at most.\n` +
    `- ${toneRule}\n` +
    `- Always end by guiding to the next action: ${cta || 'ask a question'}.\n` +
    `- Your FINAL sentence must always be: "Type *order*, *book*, or *question* to continue."`
  );
};

// ─── Sleep helper (for retry back-off) ───────────────────────────────────────

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ─── Single Groq attempt (one model, one try) ────────────────────────────────

/**
 * Every attempt is timed; structured log includes model, latency, tokens.
 * Returns { ok: true, text } on success or { ok: false, status, error } on failure.
 */
const _callGroqOnce = async (model, systemPrompt, userMessage) => {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0         = Date.now();

  try {
    const response = await fetch(GROQ_API_URL, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        max_tokens:  180,   // Hard cap — prevents long AI rambling on WhatsApp
        temperature: 0.4,   // Lower = more focused, less creative
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage  },
        ],
      }),
    });

    const latencyMs = Date.now() - t0;

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const errMsg  = errBody?.error?.message || `HTTP ${response.status}`;
      logger.warn('[Groq] API error', { model, status: response.status, error: errMsg, latencyMs });
      return { ok: false, status: response.status, error: errMsg };
    }

    const data   = await response.json();
    const text   = data?.choices?.[0]?.message?.content?.trim() || null;
    const tokens = data?.usage?.total_tokens ?? '?';

    logger.info('[Groq] OK', { model, latencyMs, tokens });
    return { ok: true, text };

  } catch (err) {
    const latencyMs = Date.now() - t0;
    if (err.name === 'AbortError') {
      logger.warn('[Groq] Request timed out', { model, latencyMs });
    } else {
      logger.error('[Groq] Fetch error', { model, error: err.message, latencyMs });
    }
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
};

// ─── Call Groq with retry + model cascade ────────────────────────────────────

/**
 * Retries on 429 / 5xx with exponential back-off.
 * After exhausting retries on primary model, tries the fallback model.
 *
 * Returns the AI text string on success, or null on total failure.
 */
const callGroq = async (systemPrompt, userMessage) => {
  if (!process.env.GROQ_API_KEY) {
    logger.warn('[Groq] GROQ_API_KEY not set — skipping AI call');
    return null;
  }

  for (const model of GROQ_MODELS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.info(`[Groq] Retrying`, { model, attempt, maxRetries: MAX_RETRIES, backoffMs: backoff });
        await sleep(backoff);
      }

      const result = await _callGroqOnce(model, systemPrompt, userMessage);

      if (result.ok) return result.text;

      // Retryable: rate limit (429), server errors (5xx), network timeout (0)
      const retryable = result.status === 429 || result.status >= 500 || result.status === 0;
      if (!retryable || attempt === MAX_RETRIES) break;
    }

    logger.warn('[Groq] Model exhausted — trying next in cascade', { model });
  }

  logger.error('[Groq] All models failed — falling back to standard response');
  return null;
};

// ─── Groq health check ────────────────────────────────────────────────────────

/**
 * Validate the Groq API key on startup or via periodic cron.
 * Returns { ok: true, model } on success, { ok: false, error } on failure.
 * Never throws — safe to await in startup without crashing the server.
 */
export const groqHealthCheck = async () => {
  if (!process.env.GROQ_API_KEY) {
    return { ok: false, error: 'GROQ_API_KEY not set' };
  }
  try {
    const result = await _callGroqOnce(
      GROQ_MODELS[0],
      'You are a test assistant. Reply with exactly: OK',
      'ping'
    );
    if (result.ok && result.text) {
      logger.info('[Groq] Health check passed', { model: GROQ_MODELS[0] });
      return { ok: true, model: GROQ_MODELS[0] };
    }
    return { ok: false, error: result.error || 'Empty response from Groq' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

// ─── Standard fallback (no Groq) ─────────────────────────────────────────────
// Sales-focused language with clear single CTA

const standardFallback = (business) => {
  const cfg      = getModeConfig(business);
  const canOrder = cfg.flows.includes('ORDER');
  const canBook  = cfg.flows.includes('BOOKING');

  if (canOrder && canBook) {
    return `What would you like to do?\n\nType *Order* to place an order, or *Book* to schedule a service.`;
  }
  if (canOrder) return `Type *Order* to see what we have available.`;
  if (canBook)  return `Type *Book* to schedule an appointment.`;
  return `Type *Hi* to see how we can help you.`;
};

// ─── About-question detection ─────────────────────────────────────────────────
// Exported so brainService can route INQUIRY → ABOUT without duplication

const ABOUT_PATTERNS = [
  /what (do|does|can) (you|this|the business)/i,
  /tell me (about|more)/i,
  /who are you/i,
  /what (is|are) (you|this place)/i,
  /about (your|the) business/i,
  /what (kind|type) of/i,
  /what (do|does) (this|your) (place|restaurant|shop|salon|business)/i,
  /what (do you|can you) (offer|serve|have)/i,
  /what (are you|is this)/i,
];

export const isAboutQuestion = (message) =>
  ABOUT_PATTERNS.some((p) => p.test(message));

// ─── Generate greeting ────────────────────────────────────────────────────────
// Used by webhookController for GREET action

export const generateGreeting = async (business) => {
  if (business?.settings?.greeting?.trim()) return business.settings.greeting.trim();
  if (!business?.description?.trim()) return null;
  const systemPrompt = buildSystemPrompt(business, null, 'GREET');
  return await callGroq(systemPrompt, 'Hello') || null;
};

// ─── Answer about question ────────────────────────────────────────────────────
// CTA is structurally appended after every ABOUT answer — guarantees
//        redirect to order/booking regardless of what the AI returns.

export const answerAboutQuestion = async (message, business, session) => {
  const cfg      = getModeConfig(business);
  const canOrder = cfg.flows.includes('ORDER');
  const canBook  = cfg.flows.includes('BOOKING');
  const cta      = canOrder && canBook
    ? '\n\nType *Order* to place an order, or *Book* to make a booking.'
    : canOrder ? '\n\nType *Order* to place an order.'
    : canBook  ? '\n\nType *Book* to make a booking.'
    : '';

  if (!business?.description?.trim()) return null;

  if (!process.env.GROQ_API_KEY) {
    return `${business.name || 'We'} — happy to help!${cta}`;
  }

  const systemPrompt = buildSystemPrompt(business, session, 'ABOUT');
  const aiText       = await callGroq(systemPrompt, message);
  if (!aiText) return null;

  // Strip any trailing CTA the AI may have already written (avoid duplication),
  // then append the structured one so it's always present and always consistent.
  const stripped = aiText.replace(/\n+type \*(order|book)\*.+$/i, '').trimEnd();
  return stripped + cta;
};

// ─── Main AI reply ────────────────────────────────────────────────────────────
// Auto-upgrades FALLBACK → ABOUT for about-questions

export const getAIReply = async (message, business, session, intent = 'FALLBACK') => {
  // FAQ short-circuit — instant, no Groq cost
  const faqReply = resolveFaq(message, business);
  if (faqReply) return faqReply;

  const resolvedIntent = (intent === 'FALLBACK' && isAboutQuestion(message)) ? 'ABOUT' : intent;

  if (!process.env.GROQ_API_KEY) {
    logger.warn('[Groq] GROQ_API_KEY not set — using standard fallback');
    return standardFallback(business);
  }

  const systemPrompt = buildSystemPrompt(business, session, resolvedIntent);
  const aiReply      = await callGroq(systemPrompt, message);
  return aiReply || standardFallback(business);
};
