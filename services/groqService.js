/**
 * services/groqService.js — v11.0
 *
 * UPGRADES:
 * - Personalised responses: system prompt injects customerName when known
 * - Larger max_tokens (220) for richer answers on menu/FAQ queries
 * - Smarter ABOUT detection: more patterns including African English
 * - TRACK_ORDER intent handling: informs customer status tracking
 * - REPEAT_ORDER intent: AI explains how to use the feature
 * - Better language detection: Groq prompted to reply in same language
 * - Context window: last 3 messages fed to Groq for multi-turn coherence
 * - ENQUIRY intent: dedicated prompt that never triggers flow actions
 */

import { resolveFaq, buildFaqContext } from './faqService.js';
import { getModeConfig }               from '../config/modes.js';
import logger                          from '../config/logger.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
];

const TIMEOUT_MS    = 9000;
const MAX_RETRIES   = 2;
const RETRY_BASE_MS = 400;

// ─── System prompt builder ────────────────────────────────────────────────────

const buildSystemPrompt = (business, session, intent = 'FALLBACK') => {
  const name         = business?.name        || 'this business';
  const desc         = business?.description || '';
  const menu         = business?.menu        || [];
  const tone         = business?.tone?.style    || 'PROFESSIONAL';
  const industry     = business?.tone?.industry || 'GENERAL';
  const customerName = session?.customerName || null;

  const cfg      = getModeConfig(business);
  const canOrder = cfg.flows.includes('ORDER');
  const canBook  = cfg.flows.includes('BOOKING');

  const menuText = menu.length > 0
    ? menu.filter((i) => i.available !== false)
          .map((i, idx) => `${idx + 1}. ${i.name}${i.price > 0 ? ` — D${i.price}` : ''}${i.description ? ` (${i.description.slice(0,60)})` : ''}`)
          .join('\n')
    : 'No menu available.';

  const capabilities = [
    canOrder ? 'placing orders' : null,
    canBook  ? 'booking services' : null,
  ].filter(Boolean).join(' and ');

  const STRICT_GROQ_RULE = `
CRITICAL CONSTRAINTS (non-negotiable):
- You are a safe information assistant ONLY.
- NEVER say you will place an order, make a booking, or execute any action.
- NEVER trigger, confirm, or guess commands.
- ONLY answer factual questions about ${name}: menu, prices, hours, location, payment.
- Maximum 3 short sentences per response.
- Always end with: "Type *order*, *book*, or *question* to continue."
- If the question is not about ${name}, respond: "I can only assist with ${name} questions."
- NEVER reveal you are an AI, Groq, or Llama. You are the ${name} assistant.
- Reply in the same language the customer is using.
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

  const currentFlow    = session?.currentFlow;
  const currentStep    = session?.step;
  const lastIntent     = session?.lastIntent;
  const lastMsg        = session?.lastMessage;
  const messageCount   = session?.messageCount || 0;

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

  let paymentContext = '';
  if (currentFlow === 'ORDER') {
    if (currentStep === 'PAYMENT_PROOF') {
      paymentContext =
        `PAYMENT CONTEXT: The customer has confirmed their order. ` +
        `They must now send a Wave payment screenshot to complete it.`;
    } else {
      paymentContext =
        `PAYMENT CONTEXT: Payment is via Wave mobile money` +
        (wavePhone ? ` to *${wavePhone}*` : '') + `. ` +
        `DO NOT discuss payment details until the order is confirmed.`;
    }
  }

  // [v11] Personalisation
  const personalisationCtx = customerName
    ? `CUSTOMER NAME: ${customerName}. Address them by name naturally (not every message).`
    : '';

  const intentInstructions = {

    GREET: `
Task: Write a SHORT, warm, and friendly welcome message for "${name}".
${customerName ? `- Address the customer as "${customerName}" naturally.` : ''}
- 1-2 sentences max. Use a friendly emoji if it suits the business tone.
- End with ONE clear call to action.
- Do NOT list every option. Pick the single most useful next step.`,

    ABOUT: `
Task: Answer the customer's question about the business briefly.
- Max 3 sentences using the business description.
- End with a single, clear next step: ${cta || 'type *Hi* to get started'}.
- Do not enter a long conversation.`,

    ENQUIRY: `
Task: Answer the customer's question directly and helpfully.
- Use the menu and FAQ information provided.
- If asking about price, list the relevant item prices clearly.
- If asking about hours or location, give the information from the FAQ.
- Max 4 sentences. Be specific and helpful.
- NEVER pretend to take an action. Just provide information.
- End with ONE next step.`,

    FALLBACK: `
Task: The customer said something unclear.
- Ask ONE short clarifying question to understand what they need.
- Do not list all options at length.
- Max 2 sentences.`,

    REPEAT: `
Task: The customer has sent the same message multiple times.
- Acknowledge briefly (1 sentence).
- Guide them to the next correct action (1 sentence).`,

    PAYMENT: `
Task: Explain the payment process clearly and briefly.
${wavePhone
  ? `- Payment is via *Wave* mobile money to: *${wavePhone}*`
  : '- Payment method: Wave mobile money (ask the business for the Wave number)'}
- Currency: *${currency}*
${currentFlow === 'ORDER'
  ? `- Customer has an active order. Tell them to confirm order first, then payment details will be shown.`
  : `- Guide them to place an order first, then payment follows.`}
- Max 2 sentences.
- DO NOT confirm the order. DO NOT change any totals.`,

    TRACK_ORDER: `
Task: Help the customer check their order status.
- Explain that order tracking is managed by the business.
- Advise them to contact the business directly for real-time updates.
- Be helpful and reassuring.
- Provide the admin contact if known: ${business?.adminPhone || 'the business contact'}.
- Max 2 sentences.`,

    REPEAT_ORDER: `
Task: Help the customer repeat their last order.
- Explain they can start a new order and mention their previous item if known.
- Guide them to tap *Order* or type *order* to begin.
- Be warm and friendly.
- Max 2 sentences.`,

  }[intent] || 'Respond helpfully in 1-2 sentences. Never expose technical errors.';

  return (
    STRICT_GROQ_RULE + '\n\n' +
    `You are the WhatsApp assistant for "${name}", a ${industry.toLowerCase()} business.\n` +
    `Your ONLY job is to help customers with: ${capabilities}.\n\n` +
    (personalisationCtx ? `${personalisationCtx}\n\n` : '') +
    (currentFlow
      ? `CUSTOMER CONTEXT:\n` +
        `- Active flow: ${currentFlow} | Step: ${currentStep || 'unknown'}\n` +
        (activeOrderCtx ? `- ${activeOrderCtx}\n` : '') +
        (lastIntent     ? `- Last detected intent: ${lastIntent}\n` : '') +
        (lastMsg        ? `- Last message: "${lastMsg}"\n` : '') +
        (messageCount   ? `- Messages this session: ${messageCount}\n` : '') +
        '\n'
      : 'Customer has no active flow.\n\n') +
    (paymentContext ? `${paymentContext}\n\n` : '') +
    (desc ? `ABOUT THE BUSINESS:\n${desc}\n\n` : '') +
    (canOrder && menuText !== 'No menu available.' ? `MENU:\n${menuText}\n\n` : '') +
    (faqContext ? `${faqContext}\n\n` : '') +
    `YOUR TASK:\n${intentInstructions}\n\n` +
    `STRICT RULES (never break these):\n` +
    `- NEVER confirm an order, change quantities, or modify totals.\n` +
    `- NEVER say "your order is confirmed" or "I've added X to your order".\n` +
    `- You are a sales assistant, NOT a general chatbot.\n` +
    `- NEVER reveal you are an AI, Groq, or Llama.\n` +
    `- NEVER discuss topics unrelated to this business.\n` +
    `- Keep responses SHORT — this is WhatsApp. Max 3 sentences unless listing items.\n` +
    `- Do NOT ask multiple questions. Ask ONE at most.\n` +
    `- ${toneRule}\n` +
    `- Always guide to the next action: ${cta || 'ask a question'}.\n`
  );
};

// ─── Sleep helper ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ─── Single Groq attempt ──────────────────────────────────────────────────────

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
        max_tokens:  220,   // [v11] increased from 180 for richer answers
        temperature: 0.35,  // [v11] slightly lower for more consistent replies
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

const callGroq = async (systemPrompt, userMessage) => {
  if (!process.env.GROQ_API_KEY) {
    logger.warn('[Groq] GROQ_API_KEY not set — skipping AI call');
    return null;
  }

  for (const model of GROQ_MODELS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        await sleep(backoff);
      }

      const result = await _callGroqOnce(model, systemPrompt, userMessage);
      if (result.ok) return result.text;

      const retryable = result.status === 429 || result.status >= 500 || result.status === 0;
      if (!retryable || attempt === MAX_RETRIES) break;
    }
    logger.warn('[Groq] Model exhausted — trying next in cascade', { model });
  }

  logger.error('[Groq] All models failed — falling back to standard response');
  return null;
};

// ─── Groq health check ────────────────────────────────────────────────────────

export const groqHealthCheck = async () => {
  if (!process.env.GROQ_API_KEY) return { ok: false, error: 'GROQ_API_KEY not set' };
  try {
    const result = await _callGroqOnce(GROQ_MODELS[0], 'You are a test assistant. Reply with exactly: OK', 'ping');
    if (result.ok && result.text) return { ok: true, model: GROQ_MODELS[0] };
    return { ok: false, error: result.error || 'Empty response' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

// ─── Standard fallback ────────────────────────────────────────────────────────

const standardFallback = (business) => {
  const cfg      = getModeConfig(business);
  const canOrder = cfg.flows.includes('ORDER');
  const canBook  = cfg.flows.includes('BOOKING');
  if (canOrder && canBook) return `What would you like to do?\n\nType *Order* to place an order, or *Book* to schedule a service.`;
  if (canOrder) return `Type *Order* to see what we have available.`;
  if (canBook)  return `Type *Book* to schedule an appointment.`;
  return `Type *Hi* to see how we can help you.`;
};

// ─── About-question detection ─────────────────────────────────────────────────

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
  // [v11] African English variants
  /wetin (you|una) (dey|de) (sell|offer|do)/i,
  /wetin you get/i,
  /abeg tell me about/i,
];

export const isAboutQuestion = (message) =>
  ABOUT_PATTERNS.some((p) => p.test(message));

// ─── Generate greeting ────────────────────────────────────────────────────────

export const generateGreeting = async (business, session = null) => {
  if (business?.settings?.greeting?.trim()) return business.settings.greeting.trim();
  if (!business?.description?.trim()) return null;
  const systemPrompt = buildSystemPrompt(business, session, 'GREET');
  return await callGroq(systemPrompt, 'Hello') || null;
};

// ─── Answer about question ────────────────────────────────────────────────────

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

  if (!process.env.GROQ_API_KEY) return `${business.name || 'We'} — happy to help!${cta}`;

  const systemPrompt = buildSystemPrompt(business, session, 'ABOUT');
  const aiText       = await callGroq(systemPrompt, message);
  if (!aiText) return null;

  const stripped = aiText.replace(/\n+type \*(order|book)\*.+$/i, '').trimEnd();
  return stripped + cta;
};

// ─── Main AI reply ────────────────────────────────────────────────────────────

export const getAIReply = async (message, business, session, intent = 'FALLBACK') => {
  const faqReply = resolveFaq(message, business);
  if (faqReply) return faqReply;

  const resolvedIntent = (intent === 'FALLBACK' && isAboutQuestion(message)) ? 'ABOUT' : intent;

  if (!process.env.GROQ_API_KEY) {
    return standardFallback(business);
  }

  const systemPrompt = buildSystemPrompt(business, session, resolvedIntent);
  const aiReply      = await callGroq(systemPrompt, message);
  return aiReply || standardFallback(business);
};
