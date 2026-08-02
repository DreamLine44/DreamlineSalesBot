/**
 * core/ai/providers/mockProvider.js
 *
 * Deterministic fallback AI that costs nothing and never fails.
 * Used when: GROQ_API_KEY missing · rate-limited · local testing · CI.
 *
 * Produces sensible, contextual responses based on business type + intent.
 * NOT a real LLM — never pretend it is.
 */

const FALLBACK_BY_INTENT = {
  FALLBACK:         'I\'m not sure I understood that. Could you try rephrasing? 😊',
  RECOMMENDATION:   'Based on what others love, I\'d suggest our most popular item — want to see the menu?',
  SUPPORT:          'I\'ve passed this to our team. Someone will be with you shortly! 🙏',
  GREETING:         'Hello! 👋 Great to have you here. How can I help?',
  ABOUT:            'Let me get you the right information. What specifically would you like to know?',
  UPSELL:           'Here\'s something that pairs perfectly with your choice — interested?',
};

const FALLBACK_BY_INDUSTRY = {
  RESTAURANT: 'Our team is happy to help. Would you like to order, book a table, or ask a question?',
  SALON:      'Happy to help! Would you like to book an appointment or ask about our services?',
  BAKERY:     'Fresh and ready for you! Would you like to place an order or schedule a collection?',
  FASHION:    'Let me help you find the perfect piece. Would you like to browse our collection?',
  COSMETICS:  'Ready to help you glow! Would you like to shop or get beauty advice?',
  ELECTRONICS:'Here to help with your tech needs! Would you like to browse products or ask a question?',
  RETAIL:     'Happy to help! Would you like to shop or ask a question?',
};

/** [PFH-10] One-liners for post-flow thanks / complaints / compliments — varied by tone. */
const EXPRESSION_BY_INTENT = {
  COMPLAINT:       'Sorry about that — we\'ll make it right. 😔',
  COMPLIMENT:      'Thank you so much! 😊',
  QUESTION:        'Happy to help! 😊',
  SUPPORT:         'We\'re on it — team will help shortly. 🙏',
  ACKNOWLEDGEMENT: 'You\'re welcome! 😊',
  FALLBACK:        'Got it! 😊',
};

function mockExpressionReply({ customerMessage, intent, sessionContext }) {
  const lower = String(customerMessage || '').toLowerCase();
  const ctx   = String(sessionContext || '').toLowerCase();
  if (/\b(always|come back|again|loyal|favourite|favorite)\b/.test(lower) || ctx.includes('tone: loyalty')) {
    return 'We can\'t wait to see you again! 🙏';
  }
  if (/\b(wow|amazing|incredible|delicious|love|best)\b/.test(lower)) {
    return 'So glad you loved it! 😊';
  }
  const key = (intent || 'FALLBACK').toUpperCase();
  return EXPRESSION_BY_INTENT[key] || EXPRESSION_BY_INTENT.FALLBACK;
}

/**
 * getReply({ customerMessage, business, intent, industry, replyMode })
 * Returns { text, source: 'mock' }
 */
export async function getReply({ customerMessage, business, intent = 'FALLBACK', industry = 'RETAIL', replyMode = null, sessionContext = null }) {
  const businessName = business?.name || 'us';
  const industryKey  = (industry || business?.businessMode || 'RETAIL').toUpperCase();

  if (replyMode === 'expression') {
    return {
      text: mockExpressionReply({ customerMessage, intent, sessionContext }),
      source: 'mock',
    };
  }

  // [MOCK-FIX-1] FAQ short-circuit — whole-word regex, not substring includes().
  // groqProvider was fixed (GROQ-OPT-3) but mockProvider still used lower.includes(t)
  // meaning "price" matched "surprised", "priceless", "apprise", etc.
  // Now consistent with groqProvider: whole-word boundary match only.
  const faqs = business?.faq || [];
  if (faqs.length && customerMessage) {
    const lower = customerMessage.toLowerCase();
    for (const faq of faqs) {
      const triggers = String(faq.trigger || '').split(',').map(t => t.trim().toLowerCase());
      const matched = triggers.some(t => {
        if (!t) return false;
        const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return re.test(lower);
      });
      if (matched) return { text: faq.reply, source: 'faq' };
    }
  }

  const byIntent   = FALLBACK_BY_INTENT[intent?.toUpperCase()];
  const byIndustry = FALLBACK_BY_INDUSTRY[industryKey];

  return {
    text:   byIntent || byIndustry || `Thanks for reaching out to *${businessName}*! How can I help you today?`,
    source: 'mock',
  };
}

export async function generateGreeting({ business, customerName }) {
  const name = customerName ? `, ${customerName}` : '';
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  const greetings = {
    RESTAURANT: `👋 Welcome back${name}! Ready to order?`,
    SALON:      `👋 Great to hear from you${name}! Looking to book?`,
    BAKERY:     `🥐 Welcome back${name}! What freshly baked goodness can we get you?`,
    FASHION:    `✨ Welcome back${name}! Checking out the new collection?`,
    COSMETICS:  `💄 Welcome back${name}! Ready to glow?`,
    ELECTRONICS:`📱 Welcome back${name}! Looking for something new?`,
  };
  return { text: greetings[mode] || `👋 Welcome back${name}!`, source: 'mock' };
}

export const healthCheck = async () => ({ ok: true, model: 'mock', latencyMs: 0 });
