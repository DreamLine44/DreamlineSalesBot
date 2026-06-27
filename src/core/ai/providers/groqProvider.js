/**
 * core/ai/providers/groqProvider.js
 *
 * Groq LLM provider — llama-3.1-8b-instant (free, fast, capable).
 * Used when GROQ_API_KEY is set.
 *
 * AI role in WhatSalesAgent:
 *   ✅ Handle unclear/ambiguous messages
 *   ✅ Answer FAQ-style questions naturally
 *   ✅ Generate smart upsell suggestions
 *   ✅ Produce personalised greetings
 *   ✅ Recommendation text
 *   ❌ Never controls flow state
 *   ❌ Never makes booking/order decisions
 *   ❌ Never replaces structured business logic
 *
 * [GROQ-OPT-1]  buildSystemPrompt: added business hours context so AI can correctly
 *               answer "are you open on Sunday?" questions. Previously hours were
 *               omitted and AI either made up answers or said it didn't know.
 * [GROQ-OPT-2]  buildSystemPrompt: accepts optional orderContext param. When the
 *               caller is inside the ORDER_CONFIRMED postFlowAck state, the AI now
 *               knows the customer has an active confirmed order being prepared.
 *               Without this, AI answers were context-free.
 * [GROQ-OPT-3]  FAQ short-circuit: replaced String.includes() with whole-word regex.
 *               "price" previously matched "surprised", "priceless", "apprise" etc.
 *               causing FAQ responses to fire on unrelated messages.
 * [GROQ-OPT-4]  generateGreeting: returns the greeting string directly (not an object
 *               with .text). callers in moduleRouter already do `body = g` — kept
 *               compatible. Added cooldown awareness — caller passes hoursSinceLastOrder.
 */

import logger from '../../../config/logger.js';

const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.1-8b-instant';
const GROQ_TIMEOUT = 12000;
const MAX_RETRIES  = 2;

// ── Sanitise business-supplied strings to prevent prompt injection ─────────────
function sanitise(str = '', maxLen = 600) {
  return String(str).slice(0, maxLen)
    .replace(/ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/gi, '[removed]')
    .replace(/you\s+are\s+now\s+/gi, '[removed] ')
    .replace(/system\s*:\s*/gi, '')
    .replace(/\s{3,}/g, '  ')
    .trim();
}

// ── Build the system prompt ────────────────────────────────────────────────────
function buildSystemPrompt({ business, intent, faqContext, orderContext }) {
  const mode    = (business?.businessMode || 'RETAIL').toUpperCase();
  const name    = sanitise(business?.name || 'our business');
  const desc    = sanitise(business?.description || '');
  const persona = sanitise(getPersona(mode));

  // [FIX-AI-CCY] Use configured currency symbol, not hardcoded 'D', in system prompt menu list.
  const _aiCcy = business?.payment?.currency || 'D';
  const menuLines = (business?.menuItems || business?.services || [])
    .filter(i => i.available !== false)
    .slice(0, 20)
    .map(i => `• ${i.name}${i.price ? ` — ${_aiCcy}${i.price}` : ''}${i.description ? ` (${sanitise(i.description, 80)})` : ''}`)
    .join('\n');

  // [GROQ-OPT-1] Business hours in system prompt
  const hoursLines = (() => {
    const hours = business?.hours;
    if (!hours?.enabled) return '';
    const _rawDays = hours.days || {};
    const days = (_rawDays instanceof Map) ? Object.fromEntries(_rawDays) : (typeof _rawDays.toObject === "function" ? _rawDays.toObject() : _rawDays);
    // hours.days stores open/close as decimal Numbers (e.g. 8.5 = 08:30, 22.75 = 22:45).
    // cfg.openTime / cfg.closeTime do not exist — they were a schema mismatch that caused
    // the AI to see "Monday: undefined–undefined" for every business day.
    // Fix: format the decimal numbers as HH:MM strings.
    const decToHHMM = (n) => {
      if (n == null) return '?';
      const h = Math.floor(n);
      const m = Math.round((n - h) * 60);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };
    const lines = Object.entries(days)
      .map(([day, cfg]) => cfg?.closed ? `${day}: Closed` : cfg?.open != null ? `${day}: ${decToHHMM(cfg.open)}–${decToHHMM(cfg.close)}` : '')
      .filter(Boolean)
      .join(', ');
    return lines ? `\nBusiness hours: ${lines}` : '';
  })();

  // [GROQ-OPT-2] Active order + customer history context so AI doesn't answer in a vacuum.
  // Previously only included the item name of ONE active order. Now includes:
  //   - All recent orders (up to 3) with status + payment state so AI can answer
  //     "Did I paid?", "What did I order?", "Is my payment confirmed?" truthfully.
  //   - Recent bookings so AI can answer "Did my booking go through?"
  //   - Customer name for personalisation.
  // This data is passed in by webhookController / moduleRouter via orderContext param.
  const orderLine = (() => {
    if (!orderContext) return '';
    const lines = [];

    // Recent orders
    if (Array.isArray(orderContext.recentOrders) && orderContext.recentOrders.length) {
      const orderSummaries = orderContext.recentOrders.slice(0, 3).map(o => {
        const ps = o.paymentStatus || 'unknown';
        const st = o.status || 'unknown';
        const paid = ['confirmed', 'self_confirmed', 'paid'].includes(ps)
          ? 'PAID ✅'
          : ps === 'proof_received' ? 'AWAITING VERIFICATION ⏳'
          : ps === 'rejected' ? 'PAYMENT REJECTED ❌'
          : 'UNPAID';
        return `• #${o.shortId || '?'} — ${sanitise(o.item || 'Order', 40)} ×${o.quantity || 1} | Status: ${st} | Payment: ${paid}`;
      }).join('\n');
      lines.push(`\nCUSTOMER'S RECENT ORDERS:\n${orderSummaries}`);
    } else if (orderContext.item) {
      // Legacy single-order path
      lines.push(`\nACTIVE ORDER: Customer has a confirmed order for *${sanitise(orderContext.item, 60)}* (ref #${orderContext.shortId || '?'}) currently being prepared.`);
    }

    // Recent bookings
    if (Array.isArray(orderContext.recentBookings) && orderContext.recentBookings.length) {
      const bookSummaries = orderContext.recentBookings.slice(0, 2).map(b =>
        `• ${sanitise(b.service || 'Appointment', 40)} on ${b.date || '?'} at ${b.time || '?'} — ${b.status || 'pending'}`
      ).join('\n');
      lines.push(`\nCUSTOMER'S RECENT BOOKINGS:\n${bookSummaries}`);
    }

    if (!lines.length) return '';
    return lines.join('\n') + '\n\nUse this context to give accurate, specific answers. Never claim you cannot see payment or order records — you have the information above.';
  })();

  return [
    `You are a ${persona} for *${name}*.`,
    desc ? `About: ${desc}` : '',
    menuLines ? `\nOfferings:\n${menuLines}` : '',
    hoursLines,
    orderLine,
    faqContext || '',
    `\nCRITICAL RULES:`,
    `- Reply in 1-2 short sentences maximum. Never write essays.`,
    `- Sound like a helpful human, not a robot.`,
    `- Only discuss ${name} and its services/products.`,
    `- NEVER claim you placed an order, made a booking, or took any action.`,
    `- NEVER claim to have confirmed a payment, received a payment, or processed a transaction. Only the payment system does that.`,
    `- NEVER say "Wave mobile money payment received", "I've confirmed your payment", "payment of D[amount]", or similar. These are system-generated messages, not your words.`,
    `- NEVER make up prices, hours, or menu items not listed above.`,
    `- If unsure, say "Let me check that for you" and offer to escalate.`,
    `- Use WhatsApp formatting: *bold* for emphasis. No markdown headers.`,
    intent === 'SUPPORT'    ? `- The customer needs human assistance. Acknowledge and reassure.` : '',
    intent === 'COMPLAINT'  ? `- The customer is unhappy. Be sincerely apologetic, empathetic, and solution-focused. Don't be defensive. Offer to escalate if needed. Keep it short and genuine.` : '',
    intent === 'COMPLIMENT' ? `- The customer is happy and giving a compliment. Respond warmly and personally, express genuine gratitude, and invite them to come back.` : '',
    intent === 'POST_ORDER' ? `- The customer just had their order confirmed. Be warm, reassuring, and briefly confirm the order is being prepared.` : '',
  ].filter(Boolean).join('\n');
}

function getPersona(mode) {
  const map = {
    RESTAURANT:  'friendly restaurant assistant who knows every dish',
    SALON:       'professional salon receptionist',
    BARBERSHOP:  'confident barber assistant',
    BAKERY:      'warm bakery assistant who loves fresh baked goods',
    FASHION:     'stylish fashion consultant',
    COSMETICS:   'knowledgeable beauty advisor',
    ELECTRONICS: 'knowledgeable electronics expert',
    RETAIL:      'helpful retail assistant',
    DELIVERY:    'efficient delivery coordinator',
    SERVICES:    'professional service consultant',
    GENERAL:     'helpful business assistant',
  };
  return map[mode] || 'helpful business assistant';
}

// ── HTTP call ─────────────────────────────────────────────────────────────────
async function callGroq(messages, retryCount = 0) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT);

  try {
    const response = await fetch(GROQ_URL, {
      method:  'POST',
      signal:  controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 200, temperature: 0.7 }),
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (response.status === 429 && retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1500 * (retryCount + 1)));
        return callGroq(messages, retryCount + 1);
      }
      throw new Error(`Groq HTTP ${response.status}: ${errText.slice(0, 120)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    clearTimeout(timer);
    if (retryCount < MAX_RETRIES && err.name !== 'AbortError') {
      await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
      return callGroq(messages, retryCount + 1);
    }
    throw err;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * getReply({ customerMessage, business, intent, history, orderContext })
 * Returns { text, source: 'groq'|'faq' }
 */
export async function getReply({ customerMessage, business, intent = 'FALLBACK', history = [], orderContext = null }) {
  // [GROQ-OPT-3] FAQ short-circuit — whole-word regex, not substring includes()
  const faqs = business?.faq || [];
  if (faqs.length && customerMessage) {
    const lower = customerMessage.toLowerCase();
    for (const faq of faqs) {
      const triggers = String(faq.trigger || '').split(',').map(t => t.trim().toLowerCase());
      const matched = triggers.some(t => {
        if (!t) return false;
        // Whole-word match — prevents "price" matching "surprised" or "apprise"
        const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return re.test(lower);
      });
      if (matched) return { text: faq.reply, source: 'faq' };
    }
  }

  const faqContext = buildFaqContext(business);
  const systemPrompt = buildSystemPrompt({ business, intent, faqContext, orderContext });

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: String(customerMessage || '').slice(0, 400) },
  ];

  const text = await callGroq(messages);
  return { text: text || null, source: 'groq' };
}

/**
 * generateGreeting({ business, customerName, lastOrder })
 *
 * [GROQ-OPT-4] Returns greeting string directly (not wrapped in object).
 * Caller in moduleRouter does: body = await generateGreeting(...)
 * Static fallback is returned on error.
 */
export async function generateGreeting({ business, customerName, lastOrder }) {
  const name     = sanitise(business?.name || 'us');
  const custName = customerName ? `, ${customerName}` : '';
  const lastStr  = lastOrder ? ` Last time you ordered *${sanitise(lastOrder, 40)}*.` : '';

  const prompt = `You are a warm ${getPersona((business?.businessMode || 'RETAIL').toUpperCase())} for ${name}. Write ONE welcoming sentence greeting a returning customer${custName}.${lastStr} Keep it casual and under 20 words. Use a relevant emoji.`;

  try {
    const text = await callGroq([{ role: 'user', content: prompt }]);
    return { text: text || `👋 Welcome back${custName}! Great to have you.`, source: 'groq' };
  } catch {
    return { text: `👋 Welcome back${custName}! Great to have you.`, source: 'mock' };
  }
}

export async function healthCheck() {
  if (!process.env.GROQ_API_KEY) return { ok: false, model: GROQ_MODEL, error: 'No API key' };
  const start = Date.now();
  try {
    await callGroq([{ role: 'user', content: 'ping' }]);
    return { ok: true, model: GROQ_MODEL, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, model: GROQ_MODEL, error: err.message };
  }
}

/**
 * classifyIntent({ message, validIntents, mode })
 *
 * [FIX-CLASSIFY] Lean intent classifier that bypasses the full persona system prompt.
 * Previously classifyWithAI in intentEngine called groq.getReply() which prepends a
 * customer-service persona ("You are a friendly restaurant assistant...") before the
 * classification instruction — the persona conflicts with the classifier role and
 * wastes tokens. This function sends only the minimal two-message prompt the model
 * needs: a concise system instruction and the sanitised customer message.
 *
 * @param {object} params
 * @param {string}   params.message       — sanitised customer message (≤200 chars)
 * @param {string[]} params.validIntents  — allowed return values
 * @param {string}   params.mode          — business mode for context (e.g. 'RESTAURANT')
 * @returns {Promise<string>} — one of validIntents, or 'UNKNOWN'
 */
export async function classifyIntent({ message, validIntents, mode = 'RETAIL' }) {
  if (!process.env.GROQ_API_KEY) return 'UNKNOWN';
  try {
    const result = await callGroq([
      {
        role: 'system',
        content:
          `You are an intent classifier for a ${mode} WhatsApp business bot.\n` +
          `Classify the customer message into exactly ONE of: ${validIntents.join(', ')}\n` +
          `Reply with ONLY the intent word — nothing else, no explanation, no punctuation.\n` +
          // [FIX-GRATITUDE] Gratitude phrases must be ACKNOWLEDGEMENT, never SUPPORT.
          // The keyword matcher catches short exact phrases; this guard covers longer
          // variants that bypass keyword matching and reach AI classification.
          `CRITICAL: Expressions of thanks, gratitude, or appreciation (e.g. "thanks so much", "really appreciate it", "you're amazing") MUST be classified as ACKNOWLEDGEMENT, NOT SUPPORT. SUPPORT is ONLY for complaints, problems, or requests for human help.`,
      },
      { role: 'user', content: String(message || '').slice(0, 200) },
    ]);
    const classified = String(result || '').trim().toUpperCase();
    return validIntents.includes(classified) ? classified : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildFaqContext(business) {
  const faqs = (business?.faq || []).filter(f => f.trigger && f.reply).slice(0, 10);
  if (!faqs.length) return '';
  return '\nKnown Q&A:\n' + faqs.map(f => `• "${f.trigger}" → ${f.reply}`).join('\n');
}
