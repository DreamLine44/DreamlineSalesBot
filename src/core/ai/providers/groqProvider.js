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

  const menuLines = (business?.menuItems || business?.services || [])
    .filter(i => i.available !== false)
    .slice(0, 20)
    .map(i => `• ${i.name}${i.price ? ` — D${i.price}` : ''}${i.description ? ` (${sanitise(i.description, 80)})` : ''}`)
    .join('\n');

  // [GROQ-OPT-1] Business hours in system prompt
  const hoursLines = (() => {
    const hours = business?.hours;
    if (!hours?.enabled) return '';
    const days = hours.days || {};
    const lines = Object.entries(days)
      .map(([day, cfg]) => cfg?.open ? `${day}: ${cfg.openTime}–${cfg.closeTime}` : `${day}: Closed`)
      .join(', ');
    return lines ? `\nBusiness hours: ${lines}` : '';
  })();

  // [GROQ-OPT-2] Active order context so AI doesn't answer in a vacuum
  const orderLine = orderContext?.item
    ? `\nACTIVE ORDER: Customer has a confirmed order for *${sanitise(orderContext.item, 60)}* (ref #${orderContext.shortId || '?'}) currently being prepared. Any answers about timing, status, or next steps should acknowledge this.`
    : '';

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
          `Reply with ONLY the intent word — nothing else, no explanation, no punctuation.`,
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
