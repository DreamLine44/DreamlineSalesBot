import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../core/ai/providers/groqProvider.js';

// [FIX-GROQ-HOURS] regression: hours.days stores decimal open/close NUMBERS
// (8.5 = 08:30) plus a `closed` boolean — there is no openTime/closeTime field
// anywhere in the schema. The old code read cfg.openTime/cfg.closeTime, which
// rendered as literal "undefined–undefined" in the AI's system prompt for any
// business with day-specific hours configured, and also mislabeled a midnight
// opening (open: 0) as "Closed" because `0` is falsy.

test('buildSystemPrompt: formats day-specific business hours correctly, no "undefined"', () => {
  const business = {
    businessMode: 'RESTAURANT',
    name: 'Test Diner',
    hours: {
      enabled: true,
      open: 8, close: 22,
      days: {
        monday:    { open: 8, close: 22, closed: false },
        tuesday:   { open: 9.5, close: 21.5, closed: false }, // 9:30AM–9:30PM
        wednesday: { closed: true },
      },
    },
  };

  const prompt = buildSystemPrompt({ business, intent: 'QUESTION' });

  assert.ok(!prompt.includes('undefined'), `prompt must never contain "undefined": ${prompt}`);
  assert.ok(prompt.includes('monday: 8AM–10PM'), `expected formatted monday hours, got: ${prompt}`);
  assert.ok(prompt.includes('tuesday: 9:30AM–9:30PM'), `expected formatted tuesday hours with minutes, got: ${prompt}`);
  assert.ok(prompt.includes('wednesday: Closed'), `expected wednesday closed via the closed flag, got: ${prompt}`);
});

test('buildSystemPrompt: a midnight opening (open: 0) is not mislabeled "Closed"', () => {
  const business = {
    businessMode: 'RETAIL',
    name: '24hr Shop',
    hours: {
      enabled: true,
      open: 0, close: 24,
      days: {
        sunday: { open: 0, close: 24, closed: false },
      },
    },
  };

  const prompt = buildSystemPrompt({ business, intent: 'QUESTION' });
  assert.ok(!prompt.includes('sunday: Closed'), `midnight-opening day (open:0) wrongly treated as falsy/closed: ${prompt}`);
  assert.ok(prompt.includes('sunday: 12AM'), `expected sunday to show a 12AM opening, got: ${prompt}`);
});

test('buildSystemPrompt: handles a live Mongoose Map for hours.days, not just plain objects', () => {
  const business = {
    businessMode: 'RETAIL',
    name: 'Map Shop',
    hours: {
      enabled: true,
      open: 8, close: 22,
      days: new Map([
        ['friday', { open: 10, close: 18, closed: false }],
      ]),
    },
  };

  const prompt = buildSystemPrompt({ business, intent: 'QUESTION' });
  assert.ok(prompt.includes('friday: 10AM–6PM'), `expected Map-based days to be read correctly, got: ${prompt}`);
});

test('buildSystemPrompt: hours.enabled=false omits hours entirely (unchanged behavior)', () => {
  const business = { businessMode: 'RETAIL', name: 'Shop', hours: { enabled: false } };
  const prompt = buildSystemPrompt({ business, intent: 'QUESTION' });
  assert.ok(!prompt.includes('Business hours:'));
});
