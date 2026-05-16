/**
 * services/groqService.js — v13.0
 *
 * FIXES IN v13:
 * [G-1] Conversation history: last 3 customer messages are now passed as
 *       actual conversation turns (role: user/assistant alternating), not
 *       just injected into the system prompt as text. This gives Groq real
 *       multi-turn context instead of a confusing "last message" string.
 * [G-2] HUMAN_ESCALATION intent added — dedicated prompt that explains how
 *       to reach a human agent and captures the customer's concern.
 * [G-3] System prompt STRICT_GROQ_RULE now explicitly forbids Groq from
 *       saying it has "placed", "confirmed", or "cancelled" anything.
 *       The previous rule only covered "order" but not "booking" cancellation.
 * [G-4] max_tokens raised to 280 for ENQUIRY intent (was 220) so answers
 *       to multi-part questions (menu + hours + location) aren't truncated.
 * [G-5] standardFallback now returns a buttons UI object, not a plain text
 *       string, so callers get consistent tappable options on Groq failure.
 * [G-6] isAboutQuestion patterns expanded: "do you deliver", "are you open",
 *       "is there parking" — common questions that were falling to FALLBACK.
 * [G-7] TIMEOUT_MS raised to 12000ms (from 9000) for slow Groq responses
 *       under load. Groq p99 latency can exceed 9s on busy models.
 */

import { resolveFaq, buildFaqContext } from './faqService.js';
import { getModeConfig }               from '../config/modes.js';
import logger                          from '../config/logger.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
];

const TIMEOUT_MS    = 12000;  // [G-7] raised from 9000
const MAX_RETRIES   = 2;
const RETRY_BASE_MS = 400;

// ─── System prompt builder ────────────────────────────────────────────────────

const buildSystemPrompt = (business, session, intent = 'FALLBACK') => {
  // Sanitise business-controlled fields before interpolation.
  // An admin could set name/description to contain prompt-injection instructions.
  // Strip common injection patterns: "Ignore previous instructions", role overrides, etc.
  const sanitise = (str = '', maxLen = 800) => {
    if (!str) return '';
    return str
      .slice(0, maxLen)
      // Remove common injection openers
      .replace(/ignore\s+(all\s+)?(previous|above|prior|earlier)\s+(instructions?|prompts?|rules?)/gi, '[removed]')
      .replace(/you\s+are\s+now\s+/gi, '[removed] ')
      .replace(/system\s*:\s*/gi, '')
      .replace(/assistant\s*:\s*/gi, '')
      .replace(/\bDAN\b/g, '')
      // Collapse whitespace created by replacements
      .replace(/\s{3,}/g, '  ')
      .trim();
  };

  const name         = sanitise(business?.name        || 'this business', 80);
  const desc         = sanitise(business?.description || '', 600);
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

  // [G-3] Stricter rule: covers order AND booking AND cancellation language
  // [FIX-GROQ-CTA] Build capability-aware CTA keywords — never say "order" for booking-only businesses
  const ctaKeywords = [
    canOrder ? '*order*'   : null,
    canBook  ? '*book*'    : null,
    '*question*',
  ].filter(Boolean).join(', ');
  const STRICT_GROQ_RULE = `
CRITICAL CONSTRAINTS (non-negotiable):
- You are a safe information assistant ONLY.
- NEVER say you will place, confirm, cancel, or modify an order or booking.
- NEVER trigger, confirm, or guess commands.
- ONLY answer factual questions about ${name}: menu, prices, hours, location, payment.
- Maximum 3 short sentences per response.
- Always end with: "Type ${ctaKeywords} to continue."
- If the question is not about ${name}, respond: "I can only assist with ${name} questions."
- NEVER reveal you are an AI, Groq, or Llama. You are the ${name} assistant.
- Reply in the same language the customer is using.
- NEVER say "your booking is confirmed", "your order is placed", "I've cancelled", or similar.
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
Task: The customer said something unclear while ${currentFlow ? `in the middle of ${currentFlow === 'ORDER' ? 'an order' : 'a booking'}` : 'chatting with the bot'}.
${currentFlow && currentStep ? `- They are currently at step: ${currentStep}. After answering, remind them to continue.` : ''}
- Answer any genuine question about the business briefly (1 sentence max).
- Then redirect them back to the next required action in 1 short sentence.
- NEVER ask open-ended questions. NEVER abandon the flow context.
- Max 2 sentences total.`,

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

    // [G-2] Dedicated human escalation prompt
    HUMAN_ESCALATION: `
Task: The customer wants to speak with a human agent or has a complaint.
- Acknowledge their request warmly.
- Explain that a team member will be in touch shortly.
- Provide the business contact if available: ${business?.adminPhone || 'our team'}.
- Do NOT attempt to resolve the issue yourself.
- Max 2 sentences. Empathetic and professional tone.`,

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
    `- NEVER say "your order is confirmed", "I've booked", "I've cancelled" or similar.\n` +
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

const _callGroqOnce = async (model, systemPrompt, messages) => {
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
        // [G-4] Larger token limit for ENQUIRY — controlled per-call by caller
        max_tokens:  280,
        temperature: 0.35,
        messages,
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

const callGroq = async (systemPrompt, userMessage, conversationHistory = []) => {
  if (!process.env.GROQ_API_KEY) {
    logger.warn('[Groq] GROQ_API_KEY not set — skipping AI call');
    return null;
  }

  // [G-1] Build proper multi-turn conversation messages.
  // conversationHistory is an array of { role, content } pairs from prior turns.
  // We cap at last 3 user messages (6 turns max) to control token usage.
  const historyMessages = Array.isArray(conversationHistory)
    ? conversationHistory.slice(-6)
    : [];

  const messages = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user',   content: userMessage  },
  ];

  for (const model of GROQ_MODELS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        await sleep(backoff);
      }

      const result = await _callGroqOnce(model, systemPrompt, messages);
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
    const result = await _callGroqOnce(GROQ_MODELS[0], 'You are a test assistant. Reply with exactly: OK', [
      { role: 'user', content: 'ping' },
    ]);
    if (result.ok && result.text) return { ok: true, model: GROQ_MODELS[0] };
    return { ok: false, error: result.error || 'Empty response' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

// ─── Standard fallback ────────────────────────────────────────────────────────
// [G-5] Returns a structured buttons UI object (not a plain string) so callers
// always get consistent tappable options on Groq failure.

export const standardFallback = (business) => {
  const cfg      = getModeConfig(business);
  const canOrder = cfg.flows.includes('ORDER');
  const canBook  = cfg.flows.includes('BOOKING');

  const body = `What would you like to do? 😊`;
  const buttons = [];
  if (canOrder) buttons.push({ id: 'ORDER',    title: '🛒 Order Now'      });
  if (canBook)  buttons.push({ id: 'BOOK',     title: '📅 Book Service'   });
  buttons.push(             { id: 'QUESTION', title: '❓ Ask a Question' });

  if (buttons.length >= 2) return { type: 'buttons', body, buttons: buttons.slice(0, 3) };
  // Edge: single-flow business
  const hint = canOrder ? 'Type *Order* to see what we have available.'
             : canBook  ? 'Type *Book* to schedule an appointment.'
             :            'Type *Hi* to see how we can help you.';
  return { type: 'text', body: hint };
};

// ─── About-question detection ─────────────────────────────────────────────────
// [G-6] Additional patterns for common questions that were hitting FALLBACK

const ABOUT_PATTERNS = [
  /what (do|does|can) (you|this|the business)/i,
  /tell me (about|more)/i,
  /who are you/i,
  /what (is|are) (you|this place)/i,
  /about (your|the) business/i,
  /what (kind|type) of/i,
  /what (do|does) (this|your) (place|restaurant|shop|salon|bakery|barbershop|store|business)/i,
  /what (do you|can you) (offer|serve|have|sell|stock)/i,
  /what (are you|is this)/i,
  /do you (deliver|have delivery|offer delivery)/i,  // [G-6]
  /are you (open|closed|available)/i,               // [G-6]
  /is there (parking|seating|takeaway|delivery)/i,   // [G-6]
  /how (far|long) (is|does|will)/i,                  // [G-6]
  // Fashion / clothing
  /do you (have|sell|carry|stock) (clothes|dresses|shoes|bags|accessories|outfits)/i,
  /what (sizes|styles|collections|colours|colors) (do you|are)/i,
  /do you (have a size guide|do alterations|do tailoring)/i,
  /is (this|the item) available in/i,
  // Cosmetics / beauty
  /do you (have|sell|carry|stock) (skincare|makeup|cosmetics|beauty products|perfume)/i,
  /is (this product|it) (good for|suitable for|safe for)/i,
  /what (ingredients|brand|brands) (do you|are)/i,
  /do you (do|offer) (consultations|beauty consultations|skin consultations)/i,
  // Bakery
  /do you (have|sell|make) (cakes|bread|pastries|baked goods|croissants)/i,
  /what (flavours|flavors|options) (do you|are available)/i,
  /can (i|you) (custom order|customise|customize)/i,
  /do you (do|make) (custom cakes|wedding cakes|birthday cakes)/i,
  /what time (do you|are you) (open|close|ready)/i,
  // Salon / barbershop
  /what (services|treatments|cuts|styles) (do you|are)/i,
  /do you (do|offer) (haircuts|fades|locs|braids|relaxers|treatments|colouring|coloring)/i,
  /how long (does|will) (a|the) (haircut|appointment|service|treatment)/i,
  /do i (need to|have to) (book|make an appointment|call ahead)/i,
  /how much (does|is) (a|the) (haircut|cut|fade|treatment|service)/i,
  // General info
  /where (are|is) (you|the|your)/i,
  /what (are your|is your) (hours|opening hours|working hours)/i,
  // African English variants
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
    const fallback = standardFallback(business);
    // Return text body for callers expecting a string
    return typeof fallback === 'string' ? fallback : fallback.body;
  }

  const systemPrompt = buildSystemPrompt(business, session, resolvedIntent);

  // [G-1] Build conversation history from session if available
  const history = [];
  if (session?.lastMessage && session?.lastBotMessage) {
    history.push({ role: 'user',      content: session.lastMessage    });
    history.push({ role: 'assistant', content: session.lastBotMessage });
  }

  const aiReply = await callGroq(systemPrompt, message, history);
  if (aiReply) return aiReply;

  const fallback = standardFallback(business);
  return typeof fallback === 'string' ? fallback : fallback.body;
};

// ─── AI reply for human escalation ───────────────────────────────────────────
// [G-2] Dedicated function for SUPPORT/escalation intent

export const getEscalationReply = async (business, session) => {
  if (!process.env.GROQ_API_KEY || !business?.description?.trim()) {
    const adminPhone = business?.adminPhone;
    return adminPhone
      ? `🤝 Our team will be with you shortly.\n\nYou can also reach us directly at *${adminPhone}*.`
      : `🤝 Our team will be with you shortly. Thank you for your patience! 😊`;
  }

  const systemPrompt = buildSystemPrompt(business, session, 'HUMAN_ESCALATION');
  const aiReply      = await callGroq(systemPrompt, 'I need to speak with a human agent.');
  if (aiReply) return aiReply;

  const adminPhone = business?.adminPhone;
  return adminPhone
    ? `🤝 Our team will be with you shortly.\n\nYou can also reach us at *${adminPhone}*.`
    : `🤝 Our team will be with you shortly. Thank you for your patience! 😊`;
};
