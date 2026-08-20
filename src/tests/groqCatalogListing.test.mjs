import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../core/ai/providers/groqProvider.js';

// [FIX-AI-FULLCATALOG] / [FIX-AI-LISTING] regression suite.
//
// Before this change, buildSystemPrompt():
//  - capped the catalog at 25 items with no grouping, so category questions
//    ("what drinks do you have") had nothing to filter against;
//  - hardcoded a "D" currency prefix regardless of the tenant's actual
//    payment.currency;
//  - ignored stockCount, variants, and addOns entirely;
//  - told the model "never write long lists" / "no bullet lists" with no
//    exception, so a genuine "list your menu with prices" request could
//    never be answered the way a human staff member would.

const baseBusiness = {
  businessMode: 'RESTAURANT',
  name: 'Test Diner',
  payment: { currency: 'GMD' },
  menuItems: [
    { name: 'Domoda', price: 200, available: true, category: 'Mains' },
    { name: 'Benachin', price: 180, available: true, category: 'Mains' },
    { name: 'Coke', price: 25, available: true, category: 'Drinks', stockCount: 0 },
    {
      name: 'Milkshake', price: 90, available: true, category: 'Drinks',
      variants: [{ name: 'Small', price: 70 }, { name: 'Large', price: 110 }],
    },
  ],
  addOns: [{ name: 'Extra sauce', price: 10 }],
};

test('buildSystemPrompt groups the catalog by category so category-scoped questions are answerable', () => {
  const prompt = buildSystemPrompt({ business: baseBusiness, intent: 'RESTAURANT_QUESTION' });
  assert.match(prompt, /Mains:/);
  assert.match(prompt, /Drinks:/);
  assert.match(prompt, /Domoda — GMD200/);
  assert.match(prompt, /Benachin — GMD180/);
});

test('buildSystemPrompt uses the business\'s real currency, not a hardcoded "D" prefix', () => {
  const eurBusiness = { ...baseBusiness, payment: { currency: 'EUR' } };
  const prompt = buildSystemPrompt({ business: eurBusiness, intent: 'RESTAURANT_QUESTION' });
  assert.match(prompt, /Domoda — EUR200/);
  assert.doesNotMatch(prompt, /Domoda — D200/);
});

test('buildSystemPrompt surfaces out-of-stock items so the AI doesn\'t claim they\'re available', () => {
  const prompt = buildSystemPrompt({ business: baseBusiness, intent: 'RESTAURANT_QUESTION' });
  assert.match(prompt, /Coke — GMD25 \(out of stock\)/);
});

test('buildSystemPrompt surfaces variant price ranges and option names', () => {
  const prompt = buildSystemPrompt({ business: baseBusiness, intent: 'RESTAURANT_QUESTION' });
  assert.match(prompt, /Milkshake — GMD70–110 \(options: Small, Large\)/);
});

test('buildSystemPrompt surfaces add-ons/extras, previously invisible to the AI', () => {
  const prompt = buildSystemPrompt({ business: baseBusiness, intent: 'RESTAURANT_QUESTION' });
  assert.match(prompt, /Available add-ons\/extras:/);
  assert.match(prompt, /Extra sauce — GMD10/);
});

test('buildSystemPrompt raises the catalog cap and notes remaining items past the limit', () => {
  const bigMenu = {
    ...baseBusiness,
    menuItems: Array.from({ length: 70 }, (_, i) => ({
      name: `Item ${i + 1}`, price: 100 + i, available: true,
    })),
  };
  const prompt = buildSystemPrompt({ business: bigMenu, intent: 'RESTAURANT_QUESTION' });
  assert.match(prompt, /Item 60 — GMD159/);
  assert.doesNotMatch(prompt, /Item 61 —/);
  assert.match(prompt, /and 10 more items/);
});

test('buildSystemPrompt explicitly allows itemised bullet lists with prices (not "never write lists")', () => {
  const prompt = buildSystemPrompt({ business: baseBusiness, intent: 'RESTAURANT_QUESTION' });
  assert.match(prompt, /EXCEPTION: if the customer asks about multiple items/);
  assert.doesNotMatch(prompt, /Never write essays or long lists/);
  assert.doesNotMatch(prompt, /No markdown headers or bullet lists/);
});

test('buildSystemPrompt still keeps the short-reply default for ordinary questions', () => {
  const prompt = buildSystemPrompt({ business: baseBusiness, intent: 'RESTAURANT_QUESTION' });
  assert.match(prompt, /reply in 1-3 short sentences/);
});
