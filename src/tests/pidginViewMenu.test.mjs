// tests/pidginViewMenu.test.mjs
//
// [FIX-PIDGIN-VIEWMENU] Regression tests.
//
// BUG: Deterministic menu-request detection (VIEW_MENU_DIRECT_RE in
// intentEngine.js, and the exact-match VIEW_MENU keyword list in
// patterns.js) only covered Standard-English phrasings ("what do you
// have", "can I see the menu", etc). West African Pidgin/Krio phrasings —
// the everyday register for a large share of this platform's actual
// Gambian customers ("wetin una get", "make i see menu") — matched
// neither list, so they always fell through to Groq step-7 classification
// with no deterministic, zero-cost, zero-latency fallback if Groq was
// disabled/unavailable/uncertain.
//
// FIX (two cooperating pieces):
//   1. core/intents/intentEngine.js — VIEW_MENU_DIRECT_RE gained a pidgin
//      alternative group (VIEW_MENU_PIDGIN_RE_SRC) covering common
//      "wetin ... get" / "make i see menu" / "show me wetin ..." shapes.
//   2. core/intents/patterns.js — VIEW_MENU's exact-match keyword list
//      gained the most common literal pidgin phrasings.
//
// A companion, non-code-tested change also localized the Groq system
// prompt (core/ai/providers/groqProvider.js, classifyMessageStructured)
// with Pidgin examples and an explicit instruction not to default to
// LOW/MEDIUM confidence just because a message is in Pidgin — that part
// is verified here via a source-text assertion (same convention used by
// viewMenuFeature.test.mjs for controller-layer changes), since it's a
// prompt string, not something unit-testable in isolation.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VIEW_MENU_DIRECT_RE } from '../core/intents/intentEngine.js';
import { INTENT_PATTERNS } from '../core/intents/patterns.js';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── 1. intentEngine.js — regex catches pidgin menu requests ────────────────

test('VIEW_MENU_DIRECT_RE matches common pidgin menu-request phrasings', () => {
  const positives = [
    'wetin una get',
    'wetin you get',
    'una get wetin',
    'wetin dey for menu',
    'wetin dey inside menu',
    'make i see menu',
    'make una see the menu',
    'make we see wetin una get',
    'show me wetin una get',
    'show us wetin you get',
    'wetin una get for chop',
    'wetin you get to eat',
  ];
  for (const phrase of positives) {
    assert.ok(
      VIEW_MENU_DIRECT_RE.test(phrase),
      `expected VIEW_MENU_DIRECT_RE to match: "${phrase}"`
    );
  }
});

test('VIEW_MENU_DIRECT_RE still matches the pre-existing Standard English phrasings', () => {
  const positives = [
    'what do you have',
    "what's on the menu",
    'can i see the menu',
    'i want to see your catalog',
    'show me the food options',
    'what can i eat',
  ];
  for (const phrase of positives) {
    assert.ok(
      VIEW_MENU_DIRECT_RE.test(phrase),
      `expected VIEW_MENU_DIRECT_RE to still match: "${phrase}"`
    );
  }
});

test('VIEW_MENU_DIRECT_RE does not match unrelated messages', () => {
  const negatives = [
    'i want to book a table',
    'thank you',
    'how much is delivery',
    'cancel my order',
  ];
  for (const phrase of negatives) {
    assert.ok(
      !VIEW_MENU_DIRECT_RE.test(phrase),
      `expected VIEW_MENU_DIRECT_RE NOT to match: "${phrase}"`
    );
  }
});

// ── 2. patterns.js — exact-match keyword list gained pidgin entries ────────

test('patterns.js: VIEW_MENU keyword list contains common pidgin phrasings', () => {
  const menuKeywords = INTENT_PATTERNS.VIEW_MENU;
  assert.ok(menuKeywords.includes('wetin una get'));
  assert.ok(menuKeywords.includes('wetin you get'));
  assert.ok(menuKeywords.includes('una get wetin'));
  // Pre-existing Standard English entries must be unchanged.
  assert.ok(menuKeywords.includes('menu'));
  assert.ok(menuKeywords.includes('view menu'));
});

// ── 3. groqProvider.js — system prompt localized for Pidgin/Krio ───────────

test('groqProvider.js: classifyMessageStructured system prompt includes Pidgin guidance', () => {
  const src = readSource('../core/ai/providers/groqProvider.js');
  assert.match(src, /Pidgin/);
  assert.match(src, /wetin una get/);
  assert.match(src, /clarificationNeeded=true just because a message is in Pidgin/);
});
