/**
 * questionAnswerService.js
 *
 * DB-first Q&A layer for Ask a Question mode.
 * Retrieves real business data before falling back to Groq AI.
 */

import { formatMoney } from '../../utils/formatCurrency.js';
import { cartTotal, cartItemCount, formatCartSummary } from '../../core/shared/cartEngine.js';
import { findBestMatch, getAIReply, getAiHistoryMessages, buildConversationContext } from '../../core/nlu/nluFeature.js';
import { normalizeHoursDays } from '../../utils/businessHoursUtils.js';
import {
  extractShortId,
  lookupActivityByReference,
  recoverRecentActivities,
  formatLookupFailureMessage,
  isValidShortIdFormat,
  formatOrderStatusCard,
  formatBookingStatusCard,
  detectStatusScope,
} from '../activity/activityFeature.js';
import {
  isBusinessScopeQuestion,
  mergeQuestionContext,
  buildQuestionContextBlock,
} from './questionModeHelper.js';

// Includes conversational references to the menu just shown. Customers naturally
// ask "are these the only ones you have?" instead of repeating the word "menu".
// Resolve those against the real catalog rather than making the AI infer availability.
const MENU_RE = /\b(menu|what do you (have|serve|sell|offer)|today'?s menu|show menu|view menu|see menu|what('s| is) (on|in) (the )?menu|list (of )?(food|items|products|dishes|services)|price list|catalog|available (food|items|products|dishes|services)|are (these|those) (all|the only)( ones)? (you have|available|there is)|is (that|this) all (you have|that is available)|anything else (available|on the menu)|what else do you have)\b/i;
// [FIX-HOURS-NATURAL] Customers rarely say "opening hours" — they ask "are
// you open on sundays?", "what days are you open", or just "you open?". The
// old pattern only matched "are you open" (no day) and "open/close today",
// so day-specific and terse phrasing fell through to GENERAL.
const HOURS_RE = /\b(hours|opening hours|business hours|when do you (open|close)|what time do you (open|close|close today|open today)|are you open|you open\b|closing time|opening time|open today|close today|open (on |every )?(mon|tues?|wednes|thurs?|fri|satur|sun)\w*days?|open (on )?weekends?|what days are you open|which days are you open|do you open on)\b/i;
// [FIX-PRICE-PLURAL] \bprice\b / \bcost\b never matched the far more common
// plural phrasing "what are the prices of your food items" / "what are the
// costs" — the word-boundary after "price"/"cost" fails when an "s" follows
// with no boundary in between, so classifyQuestion() fell through to
// 'GENERAL' for exactly the plural questions customers actually ask, and the
// message went to the ORDER-phrase detectors instead of this PRICE handler.
const PRICE_RE = /\b(how much|prices?|costs?|what does .+ cost)\b/i;
const AVAILABILITY_RE = /\b(do you have|is there|is .+ available|available)\b/i;
const STATUS_RE = /\b(track|status|where is my|check my|my order|my booking|my appointment|order update|booking update)\b/i;
const ADDRESS_RE = /\b(address|location|where are you|find you|directions|located)\b/i;
// [FIX-CONTACT-NATURAL] "how do I reach you" / "get in touch" / "your whatsapp"
// are common ways customers ask for contact info without saying "phone" or
// "contact number" verbatim.
const CONTACT_RE = /\b(phone|phone number|telephone|call|contact number|whatsapp number|(your|ur) whatsapp|reach you|get in touch|get a hold of you|email|e-mail)\b/i;
// [FIX-PAYMENT-NATURAL] "do you accept card payments" / "credit card" never
// matched because the old pattern required the bare words "payment"/"pay"/
// "wave"/"cash"/"mobile money" — "accept ... card" phrasing fell through.
const PAYMENT_RE = /\b(payment|pay|wave|cash|mobile money|how (can|do) i pay|accept (cards?|visa|mastercard|credit|debit)|credit card|debit card|card payment)\b/i;

const formatHourDecimal = (h) => {
  if (h == null || h === '') return null;
  const n = Number(h);
  if (!Number.isFinite(n)) return String(h);
  const hrs = Math.floor(n);
  const mins = Math.round((n - hrs) * 60);
  const suffix = hrs >= 12 ? 'PM' : 'AM';
  const h12 = hrs % 12 || 12;
  return mins ? `${h12}:${String(mins).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`;
}

/** Format menu items / services as WhatsApp-friendly text. */
export const formatMenuText = (business, { maxItems = 30, heading = null } = {}) => {
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  const isSalon = mode === 'SALON' || mode === 'BARBERSHOP';
  const currency = business?.payment?.currency || 'GMD';

  const menuItems = (business?.menuItems || []).filter(i => i.available !== false);
  const services = (business?.services || []).filter(s => s.available !== false);

  const items = isSalon && services.length
    ? services.map(s => ({ name: s.name, price: s.price, emoji: '💇' }))
    : menuItems.map(i => ({ name: i.name, price: i.price, emoji: '🍽️' }));

  if (!items.length) {
    return 'Our menu is being updated. Please contact us directly for current availability.';
  }

  const shown = items.slice(0, maxItems);
  const lines = shown.map(i => {
    const priceStr = i.price != null ? ` — ${currency}${formatMoney(i.price)}` : '';
    return `${i.emoji} *${i.name}*${priceStr}`;
  });

  const title = heading || (isSalon ? '💇 Our Services' : '🍽️ Today\'s Menu');
  let body = `${title}\n\n${lines.join('\n')}`;
  if (items.length > maxItems) {
    body += `\n\n_...and ${items.length - maxItems} more._`;
  }
  return body;
}

export const formatHoursText = (business) => {
  const hours = business?.hours;
  if (!hours?.enabled) {
    return business?.adminPhone
      ? `Please contact us at 📞 *${business.adminPhone}* for our opening hours.`
      : 'Please contact us directly for our opening hours.';
  }

  const daysRaw = normalizeHoursDays(hours);
  const dayOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const lines = [];

  for (const day of dayOrder) {
    const cfg = daysRaw[day];
    if (!cfg) continue;
    const label = day.charAt(0).toUpperCase() + day.slice(1);
    if (cfg.closed) {
      lines.push(`• *${label}:* Closed`);
    } else {
      const open = formatHourDecimal(cfg.open ?? hours.open);
      const close = formatHourDecimal(cfg.close ?? hours.close);
      if (open && close) lines.push(`• *${label}:* ${open} – ${close}`);
    }
  }

  if (!lines.length) {
    const open = formatHourDecimal(hours.open);
    const close = formatHourDecimal(hours.close);
    if (open && close) return `🕐 *Opening Hours*\n\n${open} – ${close}`;
    return 'Please contact us directly for our opening hours.';
  }

  return `🕐 *Opening Hours*\n\n${lines.join('\n')}`;
}

const tryFaqMatch = (message, business) => {
  const raw = String(message || '').trim().toLowerCase();
  const faqs = business?.faq || [];
  for (const faq of faqs) {
    const trigger = String(faq.trigger || '').trim().toLowerCase();
    if (!trigger || trigger.length < 2) continue;
    const re = new RegExp(`\\b${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(raw)) return faq.reply;
  }
  return null;
}

const classifyQuestion = (message, session, business) => {
  const raw = String(message || '').trim();
  const ctx = session?.data?._questionCtx || {};

  if (extractShortId(raw) || STATUS_RE.test(raw)) return 'STATUS';
  if (ctx.lastTopic === 'ORDER_TRACKING' && /\b(deleted|removed|cancelled|canceled|missing|gone|lost|where|what happened)\b/i.test(raw)) {
    return 'STATUS';
  }
  if (CONTACT_RE.test(raw)) return 'CONTACT';
  if (AVAILABILITY_RE.test(raw) && !MENU_RE.test(raw)) return 'AVAILABILITY';
  if (MENU_RE.test(raw)) return 'MENU';
  if (HOURS_RE.test(raw)) return 'HOURS';
  if (PRICE_RE.test(raw)) return 'PRICE';
  if (ADDRESS_RE.test(raw)) return 'ADDRESS';
  if (PAYMENT_RE.test(raw)) return 'PAYMENT';
  if (tryFaqMatch(raw, business)) return 'FAQ';
  return 'GENERAL';
}

async function answerStatusQuestion({ message, business, session }) {
  const phone = session.customerPhone;
  const tenantId = session.tenantId;
  const scope = detectStatusScope(message);
  const ctx = session?.data?._questionCtx || {};
  const ref = extractShortId(message) || ctx.lastReference || null;
  const adminPhone = business?.adminPhone;

  if (ref && isValidShortIdFormat(ref)) {
    const { order, booking } = await lookupActivityByReference({
      shortId: ref,
      tenantId,
      customerPhone: phone,
      scope,
    });

    if (order && (scope === 'ORDER' || scope === 'BOTH')) {
      if (phone && order.customerPhone && order.customerPhone !== phone) {
        return {
          body: `Order *#${ref}* exists but may belong to a different number. Please contact us for help.${adminPhone ? `\n\n📞 *${adminPhone}*` : ''}`,
          context: { lastReference: ref, lastTopic: 'ORDER_TRACKING', lastMessage: message },
        };
      }
      return {
        body: formatOrderStatusCard(order, business),
        context: { lastReference: ref, lastTopic: 'ORDER_TRACKING', lastMessage: message },
      };
    }

    if (booking && (scope === 'BOOKING' || scope === 'BOTH')) {
      if (phone && booking.customerPhone && booking.customerPhone !== phone) {
        return {
          body: `Booking *#${ref}* exists but may belong to a different number. Please contact us for help.${adminPhone ? `\n\n📞 *${adminPhone}*` : ''}`,
          context: { lastReference: ref, lastTopic: 'BOOKING_TRACKING', lastMessage: message },
        };
      }
      return {
        body: formatBookingStatusCard(booking, business),
        context: { lastReference: ref, lastTopic: 'BOOKING_TRACKING', lastMessage: message },
      };
    }

    const { checks } = await lookupActivityByReference({ shortId: ref, tenantId, customerPhone: phone, scope });
    await recoverRecentActivities({ customerPhone: phone, tenantId, scope });
    return {
      body: formatLookupFailureMessage({ shortId: ref, checks, adminPhone }),
      context: { lastReference: ref, lastTopic: 'ORDER_TRACKING', lastMessage: message },
      stayOnTopic: true,
    };
  }

  // Follow-up without explicit ref but prior tracking context
  if (ctx.lastReference && /\b(deleted|removed|cancelled|canceled|missing|gone|lost|what happened|still)\b/i.test(message)) {
    return answerStatusQuestion({
      message: `#${ctx.lastReference} ${message}`,
      business,
      session,
    });
  }

  return null;
}

/**
 * Try to answer from database/templates before calling Groq.
 * @returns {{ handled: boolean, body?: string, routingDecision?: string, context?: object, stayOnTopic?: boolean }}
 */
export async function tryDatabaseAnswer({ message, business, session }) {
  const raw = String(message || '').trim();
  if (!raw) return { handled: false };

  const faqAnswer = tryFaqMatch(raw, business);
  if (faqAnswer) {
    return { handled: true, body: faqAnswer, routingDecision: 'FAQ', context: { lastMessage: raw, lastTopic: 'FAQ' } };
  }

  const qType = classifyQuestion(raw, session, business);

  if (qType === 'STATUS') {
    const statusAnswer = await answerStatusQuestion({ message: raw, business, session });
    if (statusAnswer) {
      return { handled: true, routingDecision: 'TRACK_ORDER', ...statusAnswer };
    }
  }

  if (qType === 'MENU') {
    const menuText = formatMenuText(business);
    return {
      handled: true,
      body: `${menuText}\n\n_Would you like to view the full catalog or order something?_`,
      routingDecision: 'VIEW_MENU',
      context: { lastMessage: raw, lastTopic: 'MENU' },
    };
  }

  if (qType === 'AVAILABILITY') {
    const menu = [
      ...(business?.menuItems || []).filter(i => i.available !== false),
      ...(business?.services || []).filter(s => s.available !== false),
    ];
    const query = raw
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\b(do you have|is there|is|are there|are|available|any)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const candidates = menu.filter(item => {
      const itemName = String(item.name || '').toLowerCase();
      return query.split(/\s+/).some(token => token.length > 2 && itemName.includes(token));
    });
    if (candidates.length === 1) {
      return { handled: true, body: `✅ Yes, *${candidates[0].name}* is currently available.`, routingDecision: 'QUESTION', context: { lastMessage: raw, lastTopic: 'AVAILABILITY' } };
    }
    if (candidates.length > 1) {
      return { handled: true, body: `Which item do you mean — ${candidates.slice(0, 4).map(item => `*${item.name}*`).join(', ')}?`, routingDecision: 'QUESTION', context: { lastMessage: raw, lastTopic: 'AVAILABILITY' } };
    }
    return { handled: true, body: `I couldn't find that item on the current menu.`, routingDecision: 'QUESTION', context: { lastMessage: raw, lastTopic: 'AVAILABILITY' } };
  }

  if (qType === 'HOURS') {
    return {
      handled: true,
      body: formatHoursText(business),
      routingDecision: 'QUESTION',
      context: { lastMessage: raw, lastTopic: 'HOURS' },
    };
  }

  if (qType === 'PRICE') {
    const menu = [
      ...(business?.menuItems || []).filter(i => i.available !== false),
      ...(business?.services || []).filter(s => s.available !== false).map(s => ({ ...s, name: s.name })),
    ];
    const priceStopWords = ['how', 'much', 'does', 'cost', 'costs', 'price', 'prices', 'the', 'your', 'for', 'and', 'are', 'what'];
    const queryWords = raw.toLowerCase().split(/\s+/).filter(word => word.length > 2 && !priceStopWords.includes(word));
    const candidates = menu.filter(item => queryWords.some(word => String(item.name || '').toLowerCase().includes(word)));
    if (candidates.length > 1) {
      return { handled: true, body: `Which one do you mean — ${candidates.slice(0, 4).map(item => `*${item.name}*`).join(', ')}?`, routingDecision: 'QUESTION', context: { lastMessage: raw, lastTopic: 'PRICE' } };
    }
    const { item, confidenceLevel } = findBestMatch(menu, raw);
    if (item && confidenceLevel === 'HIGH') {
      const currency = business?.payment?.currency || 'GMD';
      const priceStr = item.price != null ? `${currency}${formatMoney(item.price)}` : 'contact us for pricing';
      return {
        handled: true,
        body: `💰 *${item.name}* — ${priceStr}`,
        routingDecision: 'QUESTION',
        context: { lastMessage: raw, lastTopic: 'PRICE' },
      };
    }
    // [FIX-PRICE-GENERAL] A price question that doesn't name a specific item
    // ("what are the prices of your food items", "how much is everything")
    // has no single item to match against, so candidates is empty and
    // findBestMatch never reaches HIGH confidence. This used to fall all the
    // way through the function to `{ handled: false }`, handing a plain
    // price question to the ORDER-phrase detectors upstream (which then
    // tried to parse it as a product name and reported a catalogue miss —
    // see [FIX-QUESTION-VS-ORDER] in intentEngine.js/webhookController.js).
    // The business's own priced menu answers this directly, so show it
    // instead of reporting a dead end.
    if (menu.length) {
      const menuText = formatMenuText(business, { heading: '💰 Prices' });
      return {
        handled: true,
        body: `${menuText}\n\n_Ask about a specific item for its exact price._`,
        routingDecision: 'QUESTION',
        context: { lastMessage: raw, lastTopic: 'PRICE' },
      };
    }
  }

  if (qType === 'ADDRESS' || qType === 'CONTACT') {
    const addr = business?.address;
    const phone = business?.adminPhone || business?.phone || business?.contactPhone;
    const email = business?.email || business?.contactEmail;
    const parts = [];
    if (qType === 'ADDRESS' && addr) parts.push(`📍 *Location*\n\n${addr}`);
    if (phone) parts.push(`📞 *${phone}*`);
    if (email) parts.push(`✉️ *${email}*`);
    if (parts.length) return { handled: true, body: parts.join('\n\n'), routingDecision: 'QUESTION', context: { lastMessage: raw, lastTopic: qType } };
  }

  if (/\b(total|how much is everything|cart total|what is my total)\b/i.test(raw)) {
    const cart = Array.isArray(session?.data?.cart) ? session.data.cart : [];
    const total = cartTotal(cart);
    if (cart.length && total != null) {
      const currency = business?.payment?.currency || 'GMD';
      return { handled: true, body: `🧾 *Your cart*\n\n${formatCartSummary(cart, business)}\n\nItems: ${cartItemCount(cart)}\nTotal: ${currency}${formatMoney(total)}`, routingDecision: 'QUESTION', context: { lastMessage: raw, lastTopic: 'CART' } };
    }
  }

  if (qType === 'ADDRESS') {
    const addr = business?.address;
    const phone = business?.adminPhone;
    if (addr || phone) {
      let body = '📍 *Location*\n\n';
      if (addr) body += addr;
      if (phone) body += `${addr ? '\n\n' : ''}📞 *${phone}*`;
      return { handled: true, body, routingDecision: 'QUESTION', context: { lastMessage: raw, lastTopic: 'ADDRESS' } };
    }
  }

  if (qType === 'PAYMENT') {
    const channels = business?.payment?.channels || [];
    if (channels.length) {
      return {
        handled: true,
        body: `💳 *Payment Methods*\n\nWe accept: ${channels.join(', ')}`,
        routingDecision: 'QUESTION',
        context: { lastMessage: raw, lastTopic: 'PAYMENT' },
      };
    }
  }

  return { handled: false };
}

/**
 * Process a question-mode message: DB-first, then AI fallback.
 *
 * Question Mode is answer-only: no buttons are ever attached here. The
 * customer stays in Q&A and can ask another question freely; switching to
 * another activity (ordering, booking, etc.) is detected upstream from their
 * own words (see webhookController's mid-flow switch detector /
 * _detectMidFlowSwitchRequest) rather than offered as a tap target after
 * every answer.
 */
export async function processQuestionMessage({ session, message, business, tenant, intent = 'FAQ' }) {
  const raw = String(message || '').trim();

  if (!isBusinessScopeQuestion(raw, business)) {
    return {
      type: 'text',
      body: "I'm here to help with questions about our business — menu, services, hours, orders, and bookings. What would you like to know?",
      context: mergeQuestionContext(session, { lastMessage: raw }),
    };
  }

  const dbAnswer = await tryDatabaseAnswer({ message: raw, business, session });
  if (dbAnswer.handled && dbAnswer.body) {
    return {
      type: 'text',
      body: dbAnswer.body,
      context: mergeQuestionContext(session, dbAnswer.context || { lastMessage: raw }),
    };
  }

  const ctxBlock = buildQuestionContextBlock(session);
  const aiReply = await getAIReply({
    customerMessage: raw,
    business,
    session,
    intent,
    history: getAiHistoryMessages(session),
    sessionContext: [buildConversationContext({ session, business }), ctxBlock].filter(Boolean).join('\n'),
  });

  return {
    type: 'text',
    body: aiReply || "Great question! Please contact us directly and we'll be happy to help.",
    context: mergeQuestionContext(session, { lastMessage: raw, lastTopic: 'GENERAL' }),
  };
}

/** Persist question-mode session state (stay in Q&A). */
export async function persistQuestionSession(session, tenant, context = {}) {
  const { updateSession } = await import('../../core/sessions/sessionService.js');
  const data = {
    ...(session.data || {}),
    _questionCtx: mergeQuestionContext(session, context),
  };
  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'QUESTION',
    step: 'AWAITING_QUESTION',
    data,
  });
  return { ...session, currentFlow: 'QUESTION', step: 'AWAITING_QUESTION', data };
}

