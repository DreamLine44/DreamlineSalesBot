/**
 * questionAnswerService.js
 *
 * DB-first Q&A layer for Ask a Question mode.
 * Retrieves real business data before falling back to Groq AI.
 */

import { formatMoney } from '../utils/formatCurrency.js';
import { findBestMatch } from '../utils/matchEngine.js';
import { normalizeHoursDays } from '../utils/businessHoursUtils.js';
import { getAIReply } from '../core/ai/providers/aiRouter.js';
import { getAiHistoryMessages, buildConversationContext } from '../core/nlu/nluContext.js';
import {
  extractShortId,
  lookupActivityByReference,
  recoverRecentActivities,
  formatLookupFailureMessage,
  isValidShortIdFormat,
} from './activityLookupService.js';
import {
  formatOrderStatusCard,
  formatBookingStatusCard,
  detectStatusScope,
} from './activityStatusService.js';
import {
  isBusinessScopeQuestion,
  mergeQuestionContext,
  buildQuestionContextBlock,
} from './questionModeHelper.js';

// Includes conversational references to the menu just shown. Customers naturally
// ask "are these the only ones you have?" instead of repeating the word "menu".
// Resolve those against the real catalog rather than making the AI infer availability.
const MENU_RE = /\b(menu|what do you (have|serve|sell|offer)|today'?s menu|show menu|view menu|see menu|what('s| is) (on|in) (the )?menu|list (of )?(food|items|products|dishes|services)|price list|catalog|available (food|items|products|dishes|services)|are (these|those) (all|the only)( ones)? (you have|available|there is)|is (that|this) all (you have|that is available)|anything else (available|on the menu)|what else do you have)\b/i;
const HOURS_RE = /\b(hours|opening hours|business hours|when do you (open|close)|what time do you (open|close|close today|open today)|are you open|closing time|opening time|open today|close today)\b/i;
const PRICE_RE = /\b(how much|price|cost|what does .+ cost)\b/i;
const STATUS_RE = /\b(track|status|where is my|check my|my order|my booking|my appointment|order update|booking update)\b/i;
const ADDRESS_RE = /\b(address|location|where are you|find you|directions|located)\b/i;
const PAYMENT_RE = /\b(payment|pay|wave|cash|mobile money|how (can|do) i pay)\b/i;

function formatHourDecimal(h) {
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
export function formatMenuText(business, { maxItems = 30, heading = null } = {}) {
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

export function formatHoursText(business) {
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

function tryFaqMatch(message, business) {
  const raw = String(message || '').trim().toLowerCase();
  const faqs = business?.faq || [];
  for (const faq of faqs) {
    const trigger = String(faq.trigger || '').trim().toLowerCase();
    if (!trigger || trigger.length < 2) continue;
    const re = new RegExp(`\\b${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(raw)) return faq.answer;
  }
  return null;
}

function classifyQuestion(message, session, business) {
  const raw = String(message || '').trim();
  const ctx = session?.data?._questionCtx || {};

  if (extractShortId(raw) || STATUS_RE.test(raw)) return 'STATUS';
  if (ctx.lastTopic === 'ORDER_TRACKING' && /\b(deleted|removed|cancelled|canceled|missing|gone|lost|where|what happened)\b/i.test(raw)) {
    return 'STATUS';
  }
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

/** Default Q&A buttons — soft CTAs, no forced ordering. */
export function buildQuestionButtons(business, { includeOrder = true } = {}) {
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  const buttons = [{ id: 'QUESTION', title: '❓ Ask Another' }];

  if (includeOrder && ['RESTAURANT', 'BAKERY', 'DELIVERY', 'RETAIL', 'FASHION', 'COSMETICS', 'ELECTRONICS', 'SALON', 'BARBERSHOP'].includes(mode)) {
    const orderLabel = (mode === 'SALON' || mode === 'BARBERSHOP') ? '📅 Book' : '🛍 Order';
    buttons.push({ id: mode === 'SALON' || mode === 'BARBERSHOP' ? 'BOOK' : 'ORDER', title: orderLabel });
  }

  buttons.push({ id: 'SUPPORT', title: '💬 Contact Support' });
  return buttons.slice(0, 3);
}

/**
 * Process a question-mode message: DB-first, then AI fallback.
 * Returns a WhatsApp UI payload (buttons/text).
 */
export async function processQuestionMessage({ session, message, business, tenant, intent = 'FAQ' }) {
  const raw = String(message || '').trim();

  if (!isBusinessScopeQuestion(raw, business)) {
    return {
      type: 'buttons',
      body: "I'm here to help with questions about our business — menu, services, hours, orders, and bookings. What would you like to know?",
      buttons: buildQuestionButtons(business),
      context: mergeQuestionContext(session, { lastMessage: raw }),
    };
  }

  const dbAnswer = await tryDatabaseAnswer({ message: raw, business, session });
  if (dbAnswer.handled && dbAnswer.body) {
    return {
      type: 'buttons',
      body: dbAnswer.body,
      buttons: dbAnswer.stayOnTopic
        ? [{ id: 'QUESTION', title: '❓ Ask Another' }, { id: 'SUPPORT', title: '💬 Contact Support' }]
        : buildQuestionButtons(business, { includeOrder: dbAnswer.routingDecision !== 'TRACK_ORDER' }),
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
    type: 'buttons',
    body: aiReply || "Great question! Please contact us directly and we'll be happy to help.",
    buttons: buildQuestionButtons(business),
    context: mergeQuestionContext(session, { lastMessage: raw, lastTopic: 'GENERAL' }),
  };
}

/** Persist question-mode session state (stay in Q&A). */
export async function persistQuestionSession(session, tenant, context = {}) {
  const { updateSession } = await import('../core/sessions/sessionService.js');
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
