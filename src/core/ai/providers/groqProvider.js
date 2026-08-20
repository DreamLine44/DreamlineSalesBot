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
import { formatMoney } from '../../../utils/formatCurrency.js';

const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
// [GROQ-V4-1] llama-3.3-70b-versatile was decommissioned by Groq on 2026-06-17.
// Migrated to openai/gpt-oss-120b per Groq's official deprecation guidance
// (https://console.groq.com/docs/deprecations).
const GROQ_MODEL_PRIMARY   = 'openai/gpt-oss-120b';
// [GROQ-V4-1] llama-3.1-8b-instant was decommissioned in the same wave.
// Migrated to openai/gpt-oss-20b per Groq's official deprecation guidance.
const GROQ_MODEL_FAST      = 'openai/gpt-oss-20b';
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
// Exported (additive only — no behavior change) so it can be covered by a
// direct regression test instead of only indirectly through a live Groq call.
export function buildSystemPrompt({ business, intent, faqContext, orderContext, sessionContext = null, replyMode = null }) {
  const mode    = (business?.businessMode || 'RETAIL').toUpperCase();
  const name    = sanitise(business?.name || 'our business');

  // [PFH-11] Post-flow expression replies: minimal prompt — feeling only, no menu/order/DB item names.
  if (replyMode === 'expression') {
    const sessionLine = sessionContext
      ? sanitise(sessionContext, 500)
      : '';
    return [
      `You are a warm, professional WhatsApp assistant for *${name}*.`,
      sessionLine ? `Context: ${sessionLine}` : '',
      `The customer just finished their visit and is sharing a feeling — not asking a question or placing an order.`,
      `Read their EXACT words and reply in ONE short, natural sentence (max 10 words).`,
      `Respond to their mood and meaning: praise → grateful warmth; thanks/ok/sure → brief friendly close; loyalty → welcome them back; frustration → brief sincere apology.`,
      `NEVER mention food names, dish names, menu items, order numbers, or what they ordered — unless they explicitly named it in THIS message.`,
      `NEVER repeat your previous reply. No upsells, menus, or follow-up questions.`,
    ].filter(Boolean).join('\n');
  }

  const desc    = sanitise(business?.description || '');
  const persona = getPersona(mode);
  const currency = business?.payment?.currency || 'GMD';

  // Menu / services / products list
  // [FIX-AI-FULLCATALOG] Previously hard-capped at 25 items with a fixed "D"
  // currency prefix (wrong for any tenant not using Dalasi) and no grouping,
  // stock, or variant info — the AI effectively only saw a partial, generic
  // slice of the catalog and had no way to answer "what are your drinks" or
  // "is the large size in stock" from anywhere else in the business's data.
  // Now: groups by category (so category-scoped questions can be answered
  // directly), raises the cap, uses the business's actual currency (with a
  // per-item override), and surfaces stock/variant/add-on data so the AI can
  // give a complete, correctly-priced answer instead of "I'd need to check".
  const catalogItems = (business?.menuItems || business?.services || [])
    .filter(i => i.available !== false);

  const formatItemLine = (i) => {
    const cur = i.currency || currency;
    const outOfStock = i.stockCount === 0 ? ' (out of stock)' : '';
    let price = i.price ? ` — ${cur}${formatMoney(i.price)}` : '';
    if (Array.isArray(i.variants) && i.variants.length) {
      const prices = i.variants.map(v => Number(v.price)).filter(n => Number.isFinite(n));
      if (prices.length) {
        const lo = Math.min(...prices), hi = Math.max(...prices);
        price = lo === hi ? ` — ${cur}${formatMoney(lo)}` : ` — ${cur}${formatMoney(lo)}–${formatMoney(hi)}`;
      }
      const variantNames = i.variants.slice(0, 6).map(v => v.name).filter(Boolean).join(', ');
      price += variantNames ? ` (options: ${variantNames})` : '';
    }
    const dur   = i.duration ? ` (${i.duration} min)` : '';
    const desc2 = i.description ? ` — ${sanitise(i.description, 80)}` : '';
    return `• ${i.name}${price}${dur}${outOfStock}${desc2}`;
  };

  const CATALOG_LIMIT = 60;
  const shown = catalogItems.slice(0, CATALOG_LIMIT);
  const hasCategories = shown.some(i => i.category);
  let menuLines;
  if (hasCategories) {
    const groups = new Map();
    for (const i of shown) {
      const cat = i.category || 'Other';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(i);
    }
    menuLines = [...groups.entries()]
      .map(([cat, items]) => `${sanitise(cat, 40)}:\n${items.map(formatItemLine).join('\n')}`)
      .join('\n\n');
  } else {
    menuLines = shown.map(formatItemLine).join('\n');
  }
  if (catalogItems.length > CATALOG_LIMIT) {
    menuLines += `\n_...and ${catalogItems.length - CATALOG_LIMIT} more items — ask about a specific item or category for details._`;
  }

  // [FIX-AI-ADDONS] Add-ons/extras were entirely invisible to the AI, so any
  // "can I add X" or "what extras do you have" question had no data to answer from.
  const addOnsLine = (() => {
    const addOns = Array.isArray(business?.addOns) ? business.addOns.filter(a => a?.name) : [];
    if (!addOns.length) return '';
    const lines = addOns.slice(0, 20).map(a => `• ${a.name}${a.price ? ` — ${currency}${formatMoney(a.price)}` : ''}`).join('\n');
    return `\nAvailable add-ons/extras:\n${lines}`;
  })();

  // [GROQ-OPT-1] Business hours
  // [FIX-GROQ-HOURS] Was reading cfg.openTime/cfg.closeTime — fields that don't exist
  // anywhere in the BusinessConfig schema (hours.days stores decimal open/close NUMBERS,
  // e.g. 8.5 = 08:30, plus a `closed` boolean — see models/BusinessConfig.js). Every
  // business with hours.enabled=true and per-day hours configured had this render as
  // literal "monday: undefined–undefined" and get injected straight into the AI's system
  // prompt verbatim. Also fixed: `cfg?.open ? ... : 'Closed'` treated a midnight opening
  // (open: 0) as falsy and mislabeled it "Closed"; now checks the actual `closed` flag.
  // Also normalises hours.days when it's a live Mongoose Map (Object.entries on a Map
  // instance returns nothing — only .lean()'d docs auto-convert it to a plain object),
  // matching the same normalisation already done in webhookController's isWithinBusinessHours.
  const hoursLines = (() => {
    const hours = business?.hours;
    if (!hours?.enabled) return '';
    const daysRaw = hours.days;
    const days = (daysRaw instanceof Map) ? Object.fromEntries(daysRaw) : (daysRaw || {});

    const formatHour = (h) => {
      if (h === undefined || h === null || Number.isNaN(h)) return null;
      const hh = Math.floor(h);
      const mm = Math.round((h - hh) * 60);
      const period = hh >= 12 ? 'PM' : 'AM';
      const hour12 = hh % 12 === 0 ? 12 : hh % 12;
      return mm > 0 ? `${hour12}:${String(mm).padStart(2, '0')}${period}` : `${hour12}${period}`;
    };

    const lines = Object.entries(days)
      .map(([day, cfg]) => {
        if (cfg?.closed) return `${day}: Closed`;
        const openStr  = formatHour(cfg?.open  ?? hours.open);
        const closeStr = formatHour(cfg?.close ?? hours.close);
        if (openStr === null || closeStr === null) return null;
        return `${day}: ${openStr}–${closeStr}`;
      })
      .filter(Boolean)
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
  const intentInstruction = getIntentInstruction(intent, mode, name, replyMode);

  return [
    `You are ${persona} for *${name}*.`,
    desc ? `About us: ${desc}` : '',
    menuLines ? `\nOur offerings:\n${menuLines}` : '',
    addOnsLine,
    hoursLines,
    locationLine,
    paymentLine,
    staffLine,
    capabilitiesLine,
    orderLine,
    sessionLine,
    faqContext || '',
    `\nCRITICAL RULES:`,
    // [FIX-AI-LISTING] The old blanket "never write long lists" + "no bullet
    // lists" rules meant the AI could never answer "what food do you have and
    // how much" the way a human staff member would — with an actual itemised
    // list of names and prices. That's a core, frequently-asked question type
    // (menu/price/category questions), not an edge case, so it gets an
    // explicit carve-out: keep ordinary replies short, but when the customer
    // is asking about multiple items, a category, or "the menu"/"prices",
    // list each one clearly using the same "• *Name* — price" format as the
    // offerings above, pulling the real name/price/variant/stock data from
    // whichever part of the business info above actually answers it.
    `- For a normal question, reply in 1-3 short sentences. Never pad with filler or write essays.`,
    `- EXCEPTION: if the customer asks about multiple items, a category (e.g. "your drinks", "what desserts do you have"), the full menu, or "how much are your X items", give a clear itemised list — one line per item as "• *Name* — ${currency}Price", pulled directly from the offerings above. Don't compress a real list into one sentence, and don't invent items not listed above.`,
    `- You have access to every section above (offerings, add-ons, hours, location, payment, staff, FAQ) — pull the answer from whichever section actually has it, not just the first one that seems relevant.`,
    `- Sound like a helpful, friendly human — not a robot or corporate script.`,
    `- Only discuss ${name} and its services/products/policies. Stay strictly on topic.`,
    `- NEVER claim you placed an order, made a booking, or took any action.`,
    // [GROQ-V3-7] Explicit anti-hallucination rules per data type
    `- NEVER make up prices, hours, staff names, or items not listed above. If unsure, say so.`,
    `- NEVER invent stock availability — if not stated in the offerings, say "I'd need to check that".`,
    `- NEVER invent policy details (returns, warranties, delivery fees) not explicitly mentioned.`,
    `- If asked about a capability listed under "This business supports:", confirm it IS available and tell the customer to use the button menu below to get started.`,
    `- If you genuinely don't know something specific, say "I'll need to check that — please contact us directly" rather than guessing.`,
    // [GROQ-STRICT-1] Prevent the AI from going off-topic or generating unnecessary responses
    `- If the customer's message has NOTHING to do with ${name} (e.g. general chit-chat, weather, politics, other businesses), politely redirect: "I'm only able to help with ${name} — is there something I can help you with here?"`,
    `- NEVER apologise repeatedly. If unsure, be brief. Never pad responses with filler sentences.`,
    `- NEVER ask more than ONE question in a response.`,
    `- NEVER suggest the customer contact another business, competitor, or third-party service.`,
    `- Use WhatsApp formatting: *bold* for emphasis. No markdown headers (#), tables, or code blocks — for itemised lists use "•" per line as shown in the offerings above, that's the one exception to "no lists".`,
    replyMode === 'expression'
      ? `\nPOST-FLOW REACTION MODE: Feeling-first reply only. No item names.`
      : '',
    intentInstruction,
  ].filter(Boolean).join('\n');
}

// [GROQ-FIX-2] Full intent-to-instruction map covering every intent in the codebase
function getIntentInstruction(intent, mode, bizName, replyMode = null) {
  const instructions = {
    // ── Generic / cross-mode ─────────────────────────────────────────────────
    'FALLBACK':
      `The customer sent an unclear message. Gently ask them to clarify, or offer the main options (e.g. order, book, question).`,
    'FAQ':
      `Answer the customer's question accurately using the information above. If the answer isn't in the provided info, say you'll check and suggest they contact us directly.`,
    'QUESTION':
      replyMode === 'expression'
        ? `Answer in one short sentence only. If unsure, say you'll check.`
        : `Answer the customer's question accurately using the business information above. Be direct and specific. If unsure, say "let me check that for you".`,
    'SUPPORT':
      `The customer needs human assistance. Acknowledge their concern warmly, apologise for any inconvenience, and reassure them a team member will help shortly.`,
    'COMPLAINT':
      replyMode === 'expression'
        ? `The customer is unhappy after their order/booking. One short apology sentence. No defensiveness.`
        : `The customer is unhappy. Be sincerely apologetic and empathetic — never defensive. Focus on solving the problem. Offer to escalate to a real person if needed. Keep it short and genuine.`,
    'COMPLIMENT':
      replyMode === 'expression'
        ? `Legacy — use EXPRESSION intent for post-flow replies instead.`
        : `The customer is happy and giving a compliment. Respond warmly and personally, express genuine gratitude, and invite them to come back or try something new.`,
    'EXPRESSION':
      `Post-flow emotional reaction. One natural sentence matching the customer's feeling from their exact words. Never mention what they ordered.`,
    'ACKNOWLEDGEMENT':
      replyMode === 'expression'
        ? `The customer sent a brief thanks or acknowledgement after their order/booking. One natural sentence — vary wording; do not repeat prior replies.`
        : `The customer sent a short acknowledgement (e.g. "thanks", "ok", "great"). Respond briefly and warmly, and offer to help with anything else.`,
    'POST_ORDER':
      `The customer just had their order confirmed. Be warm and reassuring. Briefly confirm the order is being prepared and give an honest sense of timing if you know it.`,
    'RECOMMENDATION':
      `The customer wants a suggestion. Recommend 1–2 specific items or services from the offerings above that best match what they described. Briefly explain why they're a good fit.`,
    'PAYMENT':
      `The customer is asking about payment. Explain the available payment methods listed above clearly. If no methods are listed, say cash on delivery or in-store payment is accepted.`,

    // ── Restaurant ───────────────────────────────────────────────────────────
    'RESTAURANT_QUESTION':
      `The customer is asking about the restaurant (menu, ingredients, allergens, hours, reservations, etc.). Answer specifically from the information above. If they ask about multiple dishes, a category (e.g. "starters", "drinks"), or "what food do you have and how much", list each matching item with its price (see the listing exception in the rules above) rather than naming just one. For allergen questions, always recommend they confirm with staff directly.`,

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
      `The customer is asking about products, stock, pricing, or policies. Answer from the offerings and FAQ above. If they're asking about a category or several products, list each with its price (see the listing exception in the rules above). For stock queries, say "I'd need to check current stock — please contact us directly".`,
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
export async function getReply({ customerMessage, business, intent = 'FALLBACK', history = [], orderContext = null, sessionContext = null, replyMode = null }) {
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
  const systemPrompt = buildSystemPrompt({ business, intent, faqContext, orderContext, sessionContext, replyMode });

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
  const isExpression = replyMode === 'expression';
  // [FIX-AI-LISTING-TOKENS] 350 tokens was tuned for short 1-3 sentence
  // replies. Now that factual/listing intents are allowed to itemise several
  // menu items with prices (see buildSystemPrompt's listing exception), a
  // real multi-item answer needs more room or it gets cut off mid-list.
  const maxTokens    = isExpression ? 45 : 500;
  const temp         = isExpression ? 0.55 : temperature;

  const text = await callGroq(messages, { model: GROQ_MODEL_PRIMARY, maxTokens, temperature: temp });
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
 * classifyMessageStructured — enhanced NLU with JSON output.
 * Used by core/nlu/enhancedNlu.js; falls back handled by caller.
 */
export async function classifyMessageStructured({
  message,
  validIntents,
  mode = 'RETAIL',
  contextBlock = '',
  history = [],
  menuSample = '',
}) {
  if (!process.env.GROQ_API_KEY) return null;

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
    SERVICES:    'a professional services business',
    GENERAL:     'a general business',
  }[mode] || 'a business';

  const systemPrompt =
    `You are the natural-language understanding layer for ${modeContext} on WhatsApp.\n\n` +
    `Your job: read the ENTIRE customer message (including long paragraphs and multiple sentences), ` +
    `use conversation context, understand what they actually mean — not just keywords — and return ` +
    `structured JSON only.\n\n` +
    `Rules:\n` +
    `- Understand negation, past tense, slang, typos, and indirect phrasing.\n` +
    `- Never treat every message as a product search.\n` +
    `- If the customer asks multiple things, pick the PRIMARY actionable intent and list others in secondaryIntents.\n` +
    `- Extract products with quantities when clearly stated (use exact menu names when possible).\n` +
    `- If the message contains a distinct business question (hours, menu, price, location, availability, etc.) ` +
    `that is separate from the primary intent — e.g. "add 2 Domoda, also what time do you close?" — put that ` +
    `question in entities.questions (short, close to the customer's own words) so it can be answered alongside ` +
    `the primary action. Only include genuine standalone questions here, not the primary request itself.\n` +
    `- Set clarificationNeeded=true ONLY when the primary intent is genuinely unclear after reading everything.\n` +
    `- confidence HIGH = explicit and unambiguous; MEDIUM = likely; LOW = vague.\n` +
    `- primaryIntent must be exactly one of: ${validIntents.join(', ')}\n\n` +
    `Reply with ONLY valid JSON (no markdown prose), shape:\n` +
    `{"primaryIntent":"ORDER","confidence":"HIGH","secondaryIntents":[],"entities":{"products":[{"name":"Domoda","quantity":2}],"questions":[]},"clarificationNeeded":false,"clarificationQuestion":null}\n\n` +
    (menuSample ? `${menuSample}\n\n` : '') +
    (contextBlock ? `Current conversation state:\n${contextBlock}\n` : '');

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-8),
    { role: 'user', content: String(message || '').slice(0, 1200) },
  ];

  const result = await callGroq(messages, {
    model:       GROQ_MODEL_PRIMARY,
    maxTokens:   350,
    temperature: 0.15,
  });

  if (!result) return null;

  let parsed;
  try {
    let text = String(result).trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1) return null;
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  const primaryIntent = String(parsed.primaryIntent || '').trim().split(/[\s.,;:!?—\-]/)[0].toUpperCase();
  const confidence = String(parsed.confidence || 'MEDIUM').trim().toUpperCase();

  return {
    primaryIntent: validIntents.includes(primaryIntent) ? primaryIntent : 'UNKNOWN',
    confidence:    ['HIGH', 'MEDIUM', 'LOW'].includes(confidence) ? confidence : 'MEDIUM',
    secondaryIntents: Array.isArray(parsed.secondaryIntents) ? parsed.secondaryIntents : [],
    entities: {
      products:  Array.isArray(parsed.entities?.products) ? parsed.entities.products : [],
      questions: Array.isArray(parsed.entities?.questions) ? parsed.entities.questions : [],
    },
    clarificationNeeded:    Boolean(parsed.clarificationNeeded),
    clarificationQuestion:  parsed.clarificationQuestion || null,
  };
}

/**
 * classifyIntent({ message, validIntents, mode })
 *
 * [FIX-CLASSIFY] Lean intent classifier that bypasses the full persona system prompt.
 * [GROQ-V3-2]   Uses fast 8b model — classification is simple and doesn't need 70b depth.
 * [GROQ-FIX-8]  Business mode context so classification leans toward relevant intents.
 */
export async function classifyIntent({ message, validIntents, mode = 'RETAIL' }) {
  if (!process.env.GROQ_API_KEY) return { intent: 'UNKNOWN', confidence: 'LOW' };
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

    // [AUDIT-FIX-CLASSIFY-2] Two additions, both scoped to stay inside the
    // existing lean single-line-reply contract (see [FIX-CLASSIFY] above —
    // a fuller persona prompt previously broke that contract entirely):
    //   1. A short negation/full-meaning instruction, so messages like
    //      "I don't want food" or "we already ate" aren't misread as ORDER
    //      just because "food"/"ate" appears.
    //   2. A confidence tier (HIGH/MEDIUM/LOW) appended after a pipe. The
    //      caller (intentEngine.js classifyWithAI/detectIntent) now only
    //      auto-continues a workflow on HIGH; MEDIUM/LOW route through the
    //      existing CLARIFY path instead of acting on a shaky guess.
    const result = await callGroq([
      {
        role: 'system',
        content:
          `You are an intent classifier for ${modeContext} on WhatsApp.\n` +
          `Understand the customer's full meaning, not just keywords — negation, past tense, ` +
          `and context change meaning (e.g. "I don't want food" or "we already ate" is NOT an order request).\n` +
          `Classify the customer message into exactly ONE of: ${validIntents.join(', ')}\n` +
          `Also rate your confidence as HIGH (explicit and unambiguous), MEDIUM (likely but not certain), ` +
          `or LOW (vague or unclear).\n` +
          `Reply with ONLY "INTENT|CONFIDENCE" — nothing else, no explanation, no punctuation. Example: ORDER|HIGH`,
      },
      { role: 'user', content: String(message || '').slice(0, 200) },
    ], { model: GROQ_MODEL_FAST, maxTokens: 20, temperature: 0.1 });

    // [FIX-CLASSIFY-2] The model sometimes returns a word followed by a period or
    // explanation (e.g. "QUESTION." or "BOOKING — the customer wants...").
    // Extract only the first whitespace/punctuation-bounded token and uppercase it.
    const rawResult = String(result || '').trim();
    const [rawIntentPart, rawConfPart] = rawResult.split('|');
    const firstWord = String(rawIntentPart || '').trim().split(/[\s.,;:!?—\-]/)[0].toUpperCase();
    const classified = validIntents.includes(firstWord) ? firstWord : 'UNKNOWN';

    // [AUDIT-FIX-CLASSIFY-2] Parse the confidence tier defensively — older prompt
    // caches, model drift, or a malformed reply could all omit it. Default to
    // MEDIUM (not HIGH) when unparseable, per the "don't inflate confidence"
    // policy: an unlabeled classification should not auto-execute a workflow.
    const confToken = String(rawConfPart || '').trim().split(/[\s.,;:!?—\-]/)[0].toUpperCase();
    const confidence = classified === 'UNKNOWN'
      ? 'LOW'
      : (['HIGH', 'MEDIUM', 'LOW'].includes(confToken) ? confToken : 'MEDIUM');

    return { intent: classified, confidence };
  } catch {
    return { intent: 'UNKNOWN', confidence: 'LOW' };
  }
}

/**
 * parseBookingDate({ message, todayIso, maxIso, tz })
 * Lean date extractor for booking flow — returns YYYY-MM-DD or null.
 */
export async function parseBookingDate({ message, todayIso, maxIso, tz = 'UTC' }) {
  if (!process.env.GROQ_API_KEY || !message) return null;
  try {
    const result = await callGroq([
      {
        role: 'system',
        content:
          `You extract a single booking date from a customer message for a business in timezone ${sanitise(tz, 40)}.\n` +
          `Today is ${todayIso}. Valid range: ${todayIso} through ${maxIso} (inclusive).\n` +
          `Understand numbers and words: "friday", "on the 6th", "8 of december", "19/8/2026", "9.8.2026", etc.\n` +
          `Use DD/MM/YYYY for ambiguous numeric dates (day before month).\n` +
          `Reply with ONLY "YYYY-MM-DD" or "UNPARSEABLE" — nothing else.`,
      },
      { role: 'user', content: String(message || '').slice(0, 120) },
    ], { model: GROQ_MODEL_FAST, maxTokens: 15, temperature: 0.1 });

    const token = String(result || '').trim().split(/[\s.,;:!?]/)[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(token) || token === 'UNPARSEABLE') return null;
    return token;
  } catch (err) {
    logger.debug('[Groq] parseBookingDate fallback', { err: err.message });
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildFaqContext(business) {
  const faqs = (business?.faq || []).filter(f => f.trigger && f.reply).slice(0, 12);
  if (!faqs.length) return '';
  return '\nKnown Q&A (use these answers exactly when the question matches):\n' +
    faqs.map(f => `• Q: "${f.trigger}" → A: ${f.reply}`).join('\n');
}
