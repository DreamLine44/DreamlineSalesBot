/**
 * nluContext.js — conversation context for enhanced NLU (read-only, no side effects).
 */

import { formatCartSummary } from '../shared/cartEngine.js';

const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_CHARS = 120;

/** Whether enhanced NLU is enabled (default: on when Groq key present). */
export function isEnhancedNluEnabled() {
  if (process.env.ENHANCED_NLU === 'false') return false;
  return Boolean(process.env.GROQ_API_KEY);
}

/** Trim and sanitise customer text for prompts. */
export function sanitiseNluMessage(message, maxLen = 1200) {
  return String(message || '')
    .slice(0, maxLen)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>]/g, '')
    .trim();
}

/** Build a compact state summary the classifier can use. */
export function buildConversationContext({ session, business } = {}) {
  const parts = [];
  const flow = session?.currentFlow || null;
  const step = session?.step || null;

  if (flow) parts.push(`Active flow: ${flow}${step ? ` (step: ${step})` : ''}`);
  if (session?.postFlowAck) parts.push(`Recently completed: ${session.postFlowAck}`);
  if (session?.orderChannel) parts.push(`Shopping channel: ${session.orderChannel}`);

  const cart = session?.data?.cart;
  if (Array.isArray(cart) && cart.length > 0) {
    try {
      parts.push(`Cart: ${formatCartSummary(cart, business).slice(0, 200)}`);
    } catch {
      parts.push(`Cart: ${cart.length} item(s)`);
    }
  }

  if (session?.data?.item?.name) {
    parts.push(`Selecting: ${session.data.item.name}`);
  }

  if (session?.customerName) {
    parts.push(`Customer name: ${session.customerName}`);
  }

  return parts.join('\n') || 'No active flow — fresh conversation.';
}

/** Normalise aiHistory from session into Groq message pairs. */
export function getAiHistoryMessages(session) {
  const raw = session?.aiHistory;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  return raw
    .slice(-MAX_HISTORY_TURNS)
    .filter(t => t?.role && t?.content)
    .map(t => ({
      role:    t.role === 'assistant' ? 'assistant' : 'user',
      content: String(t.content).slice(0, MAX_HISTORY_CHARS),
    }));
}

/** Append a turn to aiHistory (returns new array — caller persists via updateSession). */
export function appendAiHistoryTurn(session, role, content) {
  const prev = Array.isArray(session?.aiHistory) ? session.aiHistory : [];
  const entry = {
    role:    role === 'assistant' ? 'assistant' : 'user',
    content: String(content || '').slice(0, MAX_HISTORY_CHARS),
    at:      new Date().toISOString(),
  };
  return [...prev, entry].slice(-MAX_HISTORY_TURNS);
}

/** Extract plain text from a bot reply payload for history storage. */
export function extractReplyText(reply) {
  if (!reply) return null;
  const payloads = Array.isArray(reply) ? reply : [reply];
  const texts = payloads
    .map(p => (typeof p?.body === 'string' ? p.body : null))
    .filter(Boolean);
  return texts.length ? texts.join('\n').slice(0, MAX_HISTORY_CHARS) : null;
}
