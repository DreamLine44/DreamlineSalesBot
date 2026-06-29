/**
 * core/ai/providers/groqProvider.js
 *
 * Groq LLM provider — upgraded dual-model system:
 *   - llama-3.3-70b-versatile  → primary model for customer-facing replies (smarter, contextual)
 *   - llama-3.1-8b-instant     → fast classifier model (intent classification, greetings)
 *
 * AI role in WhatSalesAgent:
 *   ✅ Handle unclear/ambiguous messages
 *   ✅ Answer FAQ-style questions naturally per business type
 *   ✅ Generate smart upsell suggestions
 *   ✅ Produce personalised greetings
 *   ✅ Recommendation text
 *   ❌ Never controls flow state
 *   ❌ Never makes booking/order decisions
 *   ❌ Never replaces structured business logic
 *
 * CHANGELOG:
 * [GROQ-V3-1]  Upgraded primary model to llama-3.3-70b-versatile. The 8b model
 *              produced generic, unhelpful replies for nuanced business questions
 *              (allergens, product details, service suitability). The 70b model is
 *              still free on Groq and delivers meaningfully better responses.
 * [GROQ-V3-2]  classifyIntent keeps llama-3.1-8b-instant (fast path, low token count,
 *              classification doesn't benefit from larger model).
 * [GROQ-V3-3]  generateGreeting also uses 8b (short output, speed matters more).
 * [GROQ-V3-4]  Raised max_tokens from 250 → 350 for primary replies so AI can give
 *              complete answers to multi-part questions without mid-sentence truncation.
 * [GROQ-V3-5]  Temperature tuned: 0.5 for factual/FAQ replies, 0.75 for greetings/
 *              recommendations. Reduces hallucinated facts in product/policy answers.
 * [GROQ-V3-6]  Added conversation history passthrough to getReply so multi-turn FAQ
 *              conversations stay coherent. History trimmed to last 10 turns.
 * [GROQ-V3-7]  buildSystemPrompt: added explicit "DO NOT invent" rules per field type
 *              to reduce hallucination of prices, stock levels, and staff names.
 * [GROQ-V3-8]  getReply now accepts sessionContext param for passing active-flow context
 *              (walk-in queue position, booking service, etc.) so AI answers are grounded.
 * [GROQ-OPT-1] buildSystemPrompt: added business hours context.
 * [GROQ-OPT-2] buildSystemPrompt: accepts optional orderContext param for ORDER_CONFIRMED.
 * [GROQ-OPT-3] FAQ short-circuit: whole-word regex, not substring includes().
 * [GROQ-OPT-4] generateGreeting: returns object with .text field.
 * [GROQ-FIX-1] buildSystemPrompt: added business capabilities block.
 * [GROQ-FIX-2] buildSystemPrompt: full intent-to-instruction map.
 * [GROQ-FIX-3] buildSystemPrompt: location/address context.
 * [GROQ-FIX-4] buildSystemPrompt: payment methods context.
 * [GROQ-FIX-5] buildSystemPrompt: staff/team context for salon/barbershop.
 * [GROQ-FIX-6] buildSystemPrompt: richer mode-specific personas.
 * [GROQ-FIX-7] getReply: conversation history trimmed to last 10 turns.
 * [GROQ-FIX-8] classifyIntent: business mode context in system prompt.
 */

import logger from '../../../config/logger.js';

const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
// [GROQ-V3-1] Primary model upgraded — smarter, context-aware responses
const GROQ_MODEL_PRIMARY   = 'llama-3.3-70b-versatile';
// [GROQ-V3-2/3] Fast model retained for classification and greeting generation
const GROQ_MODEL_FAST      = 'llama-3.1-8b-instant';
const GROQ_TIMEOUT = 14000; // slightly longer timeout for 70b
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
function buildSystemPrompt({ business, intent, faqContext, orderContext, sessionContext = null }) {
  const mode    = (business?.businessMode || 'RETAIL').toUpperCase();
  const name    = sanitise(business?.name || 'our business');
  const desc    = sanitise(business?.description || '');
  const persona = getPersona(mode);

  // Menu / services / products list
  const menuLines = (business?.menuItems || business?.services || [])
    .filter(i => i.available !== false)
    .slice(0, 25)
    .map(i => {
      const price = i.price ? ` — D${i.price}` : '';
      const dur   = i.duration ? ` (${i.duration} min)` : '';
      const desc2 = i.description ? ` — ${sanitise(i.description, 80)}` : '';
      return `• ${i.name}${price}${dur}${desc2}`;
    })
    .join('\n');

  // [GROQ-OPT-1] Business hours
  const hoursLines = (() => {
    const hours = business?.hours;
    if (!hours?.enabled) return '';
    const days = hours.days || {};
    const lines = Object.entries(days)
      .map(([day, cfg]) => cfg?.open ? `${day}: ${cfg.openTime}–${cfg.closeTime}` : `${day}: Closed`)
      .join(', ');
    return lines ? `\nBusiness hours: ${lines}` : '';
  })();

  // [GROQ-FIX-3] Location / address
  const locationLine = business?.address
    ? `\nLocation: ${sanitise(business.address, 200)}`
    : '';

  // [GROQ-FIX-4] Payment methods — answers "how do I pay?"
  const paymentLine = (() => {
    const pay = business?.payment;
    if (!pay) return '';
    if (!pay.enabled) return '\nPayment: Cash on delivery / cash in store.';
    const channels = Array.isArray(pay.channels) && pay.channels.length
      ? pay.channels.map(ch => `${ch.provider} (${ch.accountNo}${ch.label ? ` — ${ch.label}` : ''})`).join(', ')
      : null;
    return channels
      ? `\nPayment methods accepted: ${channels}.`
      : `\nPayment: Online payment accepted.`;
  })();

  // [GROQ-FIX-5] Staff/team context for salon/barbershop modes
  const staffLine = (() => {
    if (!['SALON','BARBERSHOP'].includes(mode)) return '';
    const staff = business?.staff || business?.stylists || [];
    if (!staff.length) return '';
    const names = staff.slice(0, 10).map(s => s.name || s).filter(Boolean).join(', ');
    return names ? `\nOur team: ${sanitise(names, 200)}` : '';
  })();

  // [GROQ-FIX-1] Business capabilities — what flows/features are active
  // Infers from businessMode when business.flows is not explicitly set in DB.
  const capabilitiesLine = (() => {
    let flows = Array.isArray(business?.flows) && business.flows.length
      ? business.flows
      : null;

    if (!flows && business?.businessMode) {
      const MODE_DEFAULT_FLOWS = {
        RESTAURANT:  ['ORDER', 'BOOKING'],
        SALON:       ['BOOKING', 'WALKIN', 'ORDER'],
        BARBERSHOP:  ['BOOKING', 'WALKIN', 'ORDER'],
        BAKERY:      ['ORDER', 'CUSTOMIZATION'],
        RETAIL:      ['ORDER'],
        FASHION:     ['ORDER', 'ENQUIRY'],
        COSMETICS:   ['ORDER', 'ENQUIRY'],
        ELECTRONICS: ['ORDER', 'ENQUIRY'],
        DELIVERY:    ['ORDER', 'DELIVERY'],
        SERVICES:    ['ENQUIRY', 'CONSULTATION', 'BOOKING'],
        GENERAL:     ['ENQUIRY'],
      };
      flows = MODE_DEFAULT_FLOWS[mode] || null;
    }

    if (!flows) return '';
    const FLOW_LABELS = {
      ORDER:        'food/product ordering via WhatsApp',
      BOOKING:      'table/appointment bookings via WhatsApp',
      WALKIN:       'walk-in queue management via WhatsApp',
      ENQUIRY:      'customer enquiries and quote requests via WhatsApp',
      CONSULTATION: 'personalised consultations via WhatsApp',
      DELIVERY:     'delivery coordination via WhatsApp',
      CUSTOMIZATION:'custom order requests via WhatsApp',
    };
    const labels = flows.map(f => FLOW_LABELS[f.toUpperCase()] || f.toLowerCase()).filter(Boolean);
    return labels.length ? `\nThis business supports: ${labels.join(', ')}.` : '';
  })();

  // [GROQ-OPT-2] Active order context
  const orderLine = orderContext?.item
    ? `\nACTIVE ORDER: Customer has a confirmed order for *${sanitise(orderContext.item, 60)}* (ref #${orderContext.shortId || '?'}) currently being prepared. Any answers about timing, status, or next steps should acknowledge this.`
    : '';

  // [GROQ-V3-8] Session context — active flow context passed by callers (e.g. walk-in queue,
  // post-booking, skincare consultation). Grounds the AI in what's currently happening.
  const sessionLine = sessionContext
    ? `\nCURRENT CONTEXT: ${sanitise(sessionContext, 200)}`
    : '';

  // [GROQ-FIX-2] Intent-specific instruction — covers EVERY intent used in the codebase
  const intentInstruction = getIntentInstruction(intent, mode, name);

  return [
    `You are ${persona} for *${name}*.`,
    desc ? `About us: ${desc}` : '',
    menuLines ? `\nOur offerings:\n${menuLines}` : '',
    hoursLines,
    locationLine,
    paymentLine,
    staffLine,
    capabilitiesLine,
    orderLine,
    sessionLine,
    faqContext || '',
    `\nCRITICAL RULES:`,
    `- Reply in 1-3 short sentences maximum. Never write essays or long lists.`,
    `- Sound like a helpful, friendly human — not a robot or corporate script.`,
    `- Only discuss ${name} and its services/products/policies. Stay on topic.`,
    `- NEVER claim you placed an order, made a booking, or took any action.`,
    // [GROQ-V3-7] Explicit anti-hallucination rules per data type
    `- NEVER make up prices, hours, staff names, or items not listed above. If unsure, say so.`,
    `- NEVER invent stock availability — if not stated in the offerings, say "I'd need to check that".`,
    `- NEVER invent policy details (returns, warranties, delivery fees) not explicitly mentioned.`,
    `- If asked about a capability listed under "This business supports:", confirm it IS available and tell the customer to use the button menu below to get started.`,
    `- If you genuinely don't know something specific, say "I'll need to check that — please contact us directly" rather than guessing.`,
    `- Use WhatsApp formatting: *bold* for emphasis. No markdown headers or bullet lists.`,
    intentInstruction,
  ].filter(Boolean).join('\n');
}

// [GROQ-FIX-2] Full intent-to-instruction map covering every intent in the codebase
function getIntentInstruction(intent, mode, bizName) {
  const instructions = {
    // ── Generic / cross-mode ─────────────────────────────────────────────────
    'FALLBACK':
      `The customer sent an unclear message. Gently ask them to clarify, or offer the main options (e.g. order, book, question).`,
    'FAQ':
      `Answer the customer's question accurately using the information above. If the answer isn't in the provided info, say you'll check and suggest they contact us directly.`,
    'QUESTION':
      `Answer the customer's question accurately using the business information above. Be direct and specific. If unsure, say "let me check that for you".`,
    'SUPPORT':
      `The customer needs human assistance. Acknowledge their concern warmly, apologise for any inconvenience, and reassure them a team member will help shortly.`,
    'COMPLAINT':
      `The customer is unhappy. Be sincerely apologetic and empathetic — never defensive. Focus on solving the problem. Offer to escalate to a real person if needed. Keep it short and genuine.`,
    'COMPLIMENT':
      `The customer is happy and giving a compliment. Respond warmly and personally, express genuine gratitude, and invite them to come back or try something new.`,
    'ACKNOWLEDGEMENT':
      `The customer sent a short acknowledgement (e.g. "thanks", "ok", "great"). Respond briefly and warmly, and offer to help with anything else.`,
    'POST_ORDER':
      `The customer just had their order confirmed. Be warm and reassuring. Briefly confirm the order is being prepared and give an honest sense of timing if you know it.`,
    'RECOMMENDATION':
      `The customer wants a suggestion. Recommend 1–2 specific items or services from the offerings above that best match what they described. Briefly explain why they're a good fit.`,
    'PAYMENT':
      `The customer is asking about payment. Explain the available payment methods listed above clearly. If no methods are listed, say cash on delivery or in-store payment is accepted.`,

    // ── Restaurant ───────────────────────────────────────────────────────────
    'RESTAURANT_QUESTION':
      `The customer is asking about the restaurant (menu, ingredients, allergens, hours, reservations, etc.). Answer specifically from the information above. For allergen questions, always recommend they confirm with staff directly.`,

    // ── Salon / Barbershop ───────────────────────────────────────────────────
    'SALON_QUESTION':
      `The customer is asking about salon services, pricing, availability, aftercare, or preparation tips. Answer specifically and concisely. For pricing, refer to the offerings above or say "I'd need to check the latest pricing for you".`,
    'SALON_CONSULTATION':
      `The customer wants a personalised hair or beauty recommendation. If they haven't described their hair/skin type and goal, ask in one short question. Then recommend a specific service from the offerings above, explain why it suits them, and mention estimated duration if available. End with "Ready to book?" to prompt the next step.`,
    'BARBERSHOP_QUESTION':
      `The customer is asking about barbershop services, cuts, grooming products, or availability. Answer specifically from the services and team listed above. Keep it confident and direct.`,
    'AVAILABILITY_CHECK':
      `The customer is asking if a service, stylist, or time slot is available. Check the hours and team listed above. If you can't confirm availability directly, say "Let me check that — you can also book via the menu and we'll confirm your slot".`,

    // ── Cosmetics / Skincare ─────────────────────────────────────────────────
    'SKINCARE_ADVICE':
      `The customer wants skincare or beauty advice. Recommend specific products or techniques from the offerings above that match their concern (dry skin, acne, dark spots, etc.). Be specific and helpful. If no products match, give general advice and invite them to browse.`,
    'PRODUCT_QUERY':
      `The customer is asking about a specific product — ingredients, usage, suitability, or availability. Answer from the offerings list above. If the product isn't listed, say "I don't see that listed currently — please contact us to check availability".`,

    // ── Electronics ──────────────────────────────────────────────────────────
    'SPEC_REQUEST':
      `The customer wants technical specifications (RAM, storage, processor, camera, battery, etc.) for a product. If the specs are in the offerings above, list them clearly. If not, say "I don't have the full specs on hand — I'd recommend checking the product page or contacting us directly".`,
    'PRODUCT_SEARCH':
      `The customer is searching for a product by name or description. Help them find the closest match in the offerings above. If nothing matches, say "I don't see that in our current range — please contact us and we'll check if we can source it".`,
    'WARRANTY':
      `The customer is asking about warranty, guarantees, or return/exchange policy. Answer from any policy information in the FAQ above, or say "Our standard warranty is [X] — please contact us directly for details on your specific product".`,
    'ELECTRONICS_QUESTION':
      `The customer is asking about electronics products, compatibility, or features. Answer specifically from the offerings and FAQ above. For technical comparisons, be objective and helpful.`,

    // ── Fashion ──────────────────────────────────────────────────────────────
    'FASHION_QUESTION':
      `The customer is asking about clothing, sizing, styles, or availability. Answer from the offerings above. For sizing questions, refer to any size guide mentioned or say "please contact us and we'll help you find the right fit".`,

    // ── Bakery ───────────────────────────────────────────────────────────────
    'BAKERY_QUESTION':
      `The customer is asking about bakery items, custom cakes, ingredients, or collection/delivery. Answer from the offerings above. For custom orders, explain the process briefly and invite them to place a custom order.`,

    // ── Services / Consulting ────────────────────────────────────────────────
    'SERVICES_QUESTION':
      `The customer is asking about the services offered, pricing, process, or availability. Answer from the offerings and FAQ above. For pricing, give ranges if available or say "pricing depends on scope — we'll send a tailored quote after a quick consultation". Keep it professional and solution-focused.`,

    // ── Delivery ─────────────────────────────────────────────────────────────
    'DELIVERY_QUESTION':
      `The customer is asking about delivery — area, timing, fees, or tracking. Answer from the business info above. If delivery area or fees aren't listed, say "please contact us to confirm delivery to your area and any applicable fees".`,

    // ── Retail ───────────────────────────────────────────────────────────────
    'RETAIL_QUESTION':
      `The customer is asking about products, stock, pricing, or policies. Answer from the offerings and FAQ above. For stock queries, say "I'd need to check current stock — please contact us directly".`,
  };

  return instructions[intent] || instructions['FAQ'] || '';
}

// [GROQ-FIX-6] Richer, more mode-specific personas
function getPersona(mode) {
  const map = {
    RESTAURANT:  'a friendly, knowledgeable restaurant assistant who knows every dish, ingredient, and dining experience',
    SALON:       'a professional, warm salon receptionist who knows every service, stylist, and beauty treatment',
    BARBERSHOP:  'a confident, friendly barber assistant who knows every cut, grooming product, and team member',
    BAKERY:      'a warm, enthusiastic bakery assistant who loves fresh baked goods, custom cakes, and helping customers choose',
    FASHION:     'a stylish, helpful fashion consultant who knows every piece in the collection and helps customers find their look',
    COSMETICS:   'a knowledgeable beauty advisor who gives honest skincare and makeup recommendations based on the products available',
    ELECTRONICS: 'a knowledgeable, patient electronics expert who helps customers compare specs and choose the right device',
    RETAIL:      'a helpful, friendly retail assistant who knows the product range and helps customers find what they need',
    DELIVERY:    'an efficient, clear-speaking delivery coordinator who helps customers track and manage their deliveries',
    SERVICES:    'a professional, approachable service consultant who helps customers understand offerings and get a quote',
    GENERAL:     'a helpful, friendly business assistant who answers questions and helps customers get what they need',
  };
  return map[mode] || 'a helpful, friendly business assistant';
}

// ── HTTP call ─────────────────────────────────────────────────────────────────
// [GROQ-V3-1/3-5] model param selects primary (70b) or fast (8b) path.
// temperature defaults differ by model — 0.5 for factual replies, 0.75 for creative.
async function callGroq(messages, { model = GROQ_MODEL_PRIMARY, maxTokens = 350, temperature = 0.5, retryCount = 0 } = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT);

  try {
    const response = await fetch(GROQ_URL, {
      method:  'POST',
      signal:  controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (response.status === 429 && retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1500 * (retryCount + 1)));
        return callGroq(messages, { model, maxTokens, temperature, retryCount: retryCount + 1 });
      }
      // [GROQ-V3-1] If 70b model fails with a model-unavailable error, fall back to 8b.
      // Groq occasionally removes or rate-limits specific models; graceful degradation
      // ensures the bot keeps working rather than throwing to the caller.
      if (response.status === 400 && model === GROQ_MODEL_PRIMARY && retryCount === 0) {
        logger.warn('[Groq] Primary model unavailable — falling back to fast model', { model });
        return callGroq(messages, { model: GROQ_MODEL_FAST, maxTokens, temperature, retryCount: 0 });
      }
      throw new Error(`Groq HTTP ${response.status}: ${errText.slice(0, 120)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    clearTimeout(timer);
    if (retryCount < MAX_RETRIES && err.name !== 'AbortError') {
      await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
      return callGroq(messages, { model, maxTokens, temperature, retryCount: retryCount + 1 });
    }
    throw err;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * getReply({ customerMessage, business, intent, history, orderContext, sessionContext })
 * Returns { text, source: 'groq'|'faq' }
 *
 * [GROQ-V3-1] Primary model upgraded to llama-3.3-70b-versatile — richer contextual replies.
 * [GROQ-V3-5] Temperature tuned per intent type: lower for factual, higher for conversational.
 * [GROQ-V3-6] History window extended to 10 turns for coherent multi-turn FAQ conversations.
 * [GROQ-V3-8] sessionContext: optional string injected into system prompt for active-flow context
 *             (e.g. "Customer is in the walk-in queue for Haircut with Maria.").
 */
export async function getReply({ customerMessage, business, intent = 'FALLBACK', history = [], orderContext = null, sessionContext = null }) {
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

  const faqContext   = buildFaqContext(business);
  const systemPrompt = buildSystemPrompt({ business, intent, faqContext, orderContext, sessionContext });

  const messages = [
    { role: 'system', content: systemPrompt },
    // [GROQ-V3-6] Last 10 turns for coherent multi-turn FAQ conversations (was 8)
    ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: String(customerMessage || '').slice(0, 400) },
  ];

  // [GROQ-V3-5] Factual intents get lower temperature to reduce hallucination.
  // Conversational/emotional intents get higher temp for more natural-sounding replies.
  const FACTUAL_INTENTS = new Set([
    'FAQ', 'QUESTION', 'SPEC_REQUEST', 'PRODUCT_QUERY', 'WARRANTY',
    'AVAILABILITY_CHECK', 'PAYMENT', 'DELIVERY_QUESTION', 'SERVICES_QUESTION',
    'RETAIL_QUESTION', 'ELECTRONICS_QUESTION', 'RESTAURANT_QUESTION',
    'BARBERSHOP_QUESTION', 'BAKERY_QUESTION', 'FASHION_QUESTION', 'SALON_QUESTION',
  ]);
  const temperature = FACTUAL_INTENTS.has((intent || '').toUpperCase()) ? 0.45 : 0.65;

  // [GROQ-V3-1] Use primary 70b model for customer-facing replies
  const text = await callGroq(messages, { model: GROQ_MODEL_PRIMARY, maxTokens: 350, temperature });
  return { text: text || null, source: 'groq' };
}

/**
 * generateGreeting({ business, customerName, lastOrder })
 * [GROQ-OPT-4] Returns { text, source } object.
 * [GROQ-V3-3] Uses fast 8b model — short output, speed matters more than depth for greetings.
 */
export async function generateGreeting({ business, customerName, lastOrder }) {
  const name     = sanitise(business?.name || 'us');
  const custName = customerName ? `, ${customerName}` : '';
  const lastStr  = lastOrder ? ` Last time they ordered *${sanitise(lastOrder, 40)}*.` : '';
  const mode     = (business?.businessMode || 'RETAIL').toUpperCase();

  const modeHints = {
    RESTAURANT:  'Mention something warm about great food or a favourite dish.',
    SALON:       'Mention how great it is to have them back and something about looking great.',
    BARBERSHOP:  'Keep it cool and confident — mention a fresh cut or looking sharp.',
    BAKERY:      'Mention freshly baked goodness or a warm treat waiting for them.',
    FASHION:     'Mention their style or a new arrival they might love.',
    COSMETICS:   'Mention glowing skin or a new product they might like.',
    ELECTRONICS: 'Keep it friendly and tech-savvy.',
    DELIVERY:    'Keep it efficient and reassuring.',
    SERVICES:    'Keep it professional and warm.',
  };

  const hint = modeHints[mode] || 'Keep it warm and friendly.';
  const prompt = `You are a warm ${getPersona(mode)} for ${name}. Write ONE casual, friendly sentence welcoming a returning customer${custName} back.${lastStr} ${hint} Keep it under 20 words. Use one relevant emoji. Do not start with "Hi" or "Hello".`;

  try {
    // [GROQ-V3-3] Fast 8b model for greetings — speed over depth
    const text = await callGroq([{ role: 'user', content: prompt }], {
      model: GROQ_MODEL_FAST, maxTokens: 60, temperature: 0.8,
    });
    return { text: text || `👋 Great to have you back${custName}!`, source: 'groq' };
  } catch (err) {
    logger.debug('[Groq] generateGreeting fallback', { err: err.message });
    return { text: `👋 Great to have you back${custName}!`, source: 'mock' };
  }
}

/**
 * healthCheck()
 * [GROQ-V3-1] Reports both models in health output.
 */
export async function healthCheck() {
  if (!process.env.GROQ_API_KEY) return { ok: false, model: GROQ_MODEL_PRIMARY, error: 'No API key' };
  const start = Date.now();
  try {
    // Use fast model for health ping — no need to warm up the 70b for a ping
    await callGroq([{ role: 'user', content: 'ping' }], { model: GROQ_MODEL_FAST, maxTokens: 5 });
    return { ok: true, primaryModel: GROQ_MODEL_PRIMARY, fastModel: GROQ_MODEL_FAST, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, primaryModel: GROQ_MODEL_PRIMARY, fastModel: GROQ_MODEL_FAST, error: err.message };
  }
}

/**
 * classifyIntent({ message, validIntents, mode })
 *
 * [FIX-CLASSIFY] Lean intent classifier that bypasses the full persona system prompt.
 * [GROQ-V3-2]   Uses fast 8b model — classification is simple and doesn't need 70b depth.
 * [GROQ-FIX-8]  Business mode context so classification leans toward relevant intents.
 */
export async function classifyIntent({ message, validIntents, mode = 'RETAIL' }) {
  if (!process.env.GROQ_API_KEY) return 'UNKNOWN';
  try {
    const modeContext = {
      RESTAURANT:  'a restaurant that takes food orders and table bookings',
      SALON:       'a hair and beauty salon that books appointments and handles walk-ins',
      BARBERSHOP:  'a barbershop that books appointments and handles walk-ins',
      BAKERY:      'a bakery that takes orders for bread, cakes, and pastries',
      RETAIL:      'a retail store that sells products',
      FASHION:     'a fashion store selling clothing and accessories',
      COSMETICS:   'a cosmetics and skincare store',
      ELECTRONICS: 'an electronics store selling phones, laptops, and gadgets',
      DELIVERY:    'a delivery and courier service',
      SERVICES:    'a professional services business (consulting, design, etc.)',
      GENERAL:     'a general business',
    }[mode] || 'a business';

    // [GROQ-V3-2] Fast 8b model — classification is short-context, doesn't need 70b
    const result = await callGroq([
      {
        role: 'system',
        content:
          `You are an intent classifier for ${modeContext} on WhatsApp.\n` +
          `Classify the customer message into exactly ONE of: ${validIntents.join(', ')}\n` +
          `Reply with ONLY the intent word — nothing else, no explanation, no punctuation.`,
      },
      { role: 'user', content: String(message || '').slice(0, 200) },
    ], { model: GROQ_MODEL_FAST, maxTokens: 20, temperature: 0.1 });

    const classified = String(result || '').trim().toUpperCase();
    return validIntents.includes(classified) ? classified : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildFaqContext(business) {
  const faqs = (business?.faq || []).filter(f => f.trigger && f.reply).slice(0, 12);
  if (!faqs.length) return '';
  return '\nKnown Q&A (use these answers exactly when the question matches):\n' +
    faqs.map(f => `• Q: "${f.trigger}" → A: ${f.reply}`).join('\n');
}
