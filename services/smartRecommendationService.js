/**
 * services/smartRecommendationService.js — Dreamline Sales Bot v4.0
 *
 * SMART RECOMMENDATION ENGINE
 *
 * Generates AI-powered product/service recommendations mid-conversation.
 * Triggered after item selection (AFTER_ITEM_SELECT) or service selection
 * (AFTER_SERVICE_SELECT) for businesses with smartRecommendations.enabled = true.
 *
 * Strategy:
 *  1. Build a short prompt using the mode's recommendation prompt template.
 *  2. Pass selected item + full menu/services list to Groq.
 *  3. Return a 1-2 sentence recommendation the bot sends before the upsell widget.
 *
 * Rules:
 *  - Never blocks the order flow. If AI times out, skip silently.
 *  - Only fires ONCE per order session (not on every step).
 *  - Recommendation must suggest an item that actually exists in the menu.
 *  - Capped at 2 sentences — WhatsApp is a short-message channel.
 */

import { getModeConfig }   from '../config/modes.js';
import logger              from '../config/logger.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS   = 5000; // Hard timeout — never hold up the order flow

// ─── buildRecommendationPrompt ────────────────────────────────────────────────

function buildRecommendationPrompt(business, selectedItem, modeConfig) {
  const menu = (business?.menu || [])
    .filter(i => i.available !== false && i.name !== selectedItem)
    .map(i => `${i.name}${i.price > 0 ? ` (D${i.price})` : ''}${i.description ? ` — ${i.description}` : ''}`)
    .join(', ');

  const services = (business?.services || [])
    .filter(s => s.available !== false && s.name !== selectedItem)
    .map(s => `${s.name}${s.price > 0 ? ` (D${s.price})` : ''}${s.description ? ` — ${s.description}` : ''}`)
    .join(', ');

  const catalogue = menu || services || 'no other items';
  const persona   = modeConfig?.salesPersona || 'helpful sales assistant';
  const basePrompt = modeConfig?.smartRecommendations?.prompt || 'Suggest ONE complementary item.';

  return {
    system: `You are a ${persona} for ${business?.name || 'this business'} on WhatsApp.
RULES:
- Maximum 2 SHORT sentences.
- You MUST suggest an item that actually exists in the catalogue list below.
- Be natural and conversational — not salesy or pushy.
- Never say "I recommend" — just suggest casually.
- Never mention prices unless the catalogue shows them.
- If there are no suitable items, respond with exactly: SKIP`,

    user: `The customer just selected: "${selectedItem}"
Available catalogue: ${catalogue}
Task: ${basePrompt}`,
  };
}

// ─── getSmartRecommendation ───────────────────────────────────────────────────
/**
 * Returns a short recommendation string, or null if:
 *  - smart recommendations are disabled for this mode
 *  - the AI times out
 *  - the AI says SKIP
 *  - already recommended this session (recommendedThisSession = true)
 */
export async function getSmartRecommendation(business, selectedItem, session) {
  try {
    const modeConfig = getModeConfig(business);
    const recoCfg    = modeConfig?.smartRecommendations;

    if (!recoCfg?.enabled)                     return null;
    if (!process.env.GROQ_API_KEY)             return null;
    if (session?.data?.recommendedThisSession) return null;

    const { system, user } = buildRecommendationPrompt(business, selectedItem, modeConfig);

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(GROQ_API_URL, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model:       'llama-3.1-8b-instant',
        max_tokens:  80,
        temperature: 0.6,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user   },
        ],
      }),
    }).finally(() => clearTimeout(timer));

    if (!response.ok) return null;

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();

    if (!text || text === 'SKIP' || text.toUpperCase().includes('SKIP')) return null;

    logger.info('[SmartReco] Generated recommendation', { selectedItem, text });
    return text;

  } catch (err) {
    if (err.name !== 'AbortError') {
      logger.warn('[SmartReco] Failed (non-fatal):', err.message);
    }
    return null; // Always non-fatal — never block the order flow
  }
}
