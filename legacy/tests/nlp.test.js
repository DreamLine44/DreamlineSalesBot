'use strict';

/**
 * NLP Engine Tests — Run with: node tests/nlp.test.js
 */

const { parseQuantity, detectIntent, fuzzyMatchMenuItem, validateQuantity } = require('../utils/nlp');

let passed = 0;
let failed = 0;

function test(description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✅ ${description}`);
    passed++;
  } else {
    console.log(`  ❌ ${description}`);
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Got:      ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ─── Quantity Parsing ─────────────────────────────────────────────────────────
console.log('\n📊 Quantity Parsing Tests:');
test('digit "2"',               parseQuantity('2'),              2);
test('digit "11"',              parseQuantity('11'),             11);
test('"eleven"',                parseQuantity('eleven'),         11);
test('"Eleven"',                parseQuantity('Eleven'),         11);
test('"twelve"',                parseQuantity('twelve'),         12);
test('"twleve" (typo)',         parseQuantity('twleve'),         12);
test('"a dozen"',               parseQuantity('a dozen'),        12);
test('"one dozen"',             parseQuantity('one dozen'),      12);
test('"two dozen"',             parseQuantity('two dozen'),      24);
test('"two plates"',            parseQuantity('two plates'),     2);
test('"5 meals"',               parseQuantity('5 meals'),        5);
test('"three portions of rice"',parseQuantity('three portions of rice'), 3);
test('"a couple"',              parseQuantity('a couple'),       2);
test('null for empty string',   parseQuantity(''),               null);
test('null for no number',      parseQuantity('please order'),   null);

// ─── Intent Detection ─────────────────────────────────────────────────────────
console.log('\n🧠 Intent Detection Tests:');
test('"hi" → GREETING',        detectIntent('hi').primary,         'GREETING');
test('"hello there" → GREETING', detectIntent('hello there').primary, 'GREETING');
test('"order" → ORDER',        detectIntent('order').primary,      'ORDER');
test('"I want domoda" → ORDER', detectIntent('I want domoda').primary, 'ORDER');
test('"menu" → MENU',          detectIntent('menu').primary,       'MENU');
test('"book a table" → BOOK',  detectIntent('book a table').primary, 'BOOK');
test('"checkout" → CHECKOUT',  detectIntent('checkout').primary,   'CHECKOUT');
test('"cancel" → CANCEL',      detectIntent('cancel').primary,     'CANCEL');
test('"yes" → YES',            detectIntent('yes').primary,        'YES');
test('"yeah" → YES',           detectIntent('yeah').primary,       'YES');
test('"no" → NO',              detectIntent('no').primary,         'NO');
test('"proof" → PAYMENT_PROOF',detectIntent('proof').primary,      'PAYMENT_PROOF');
test('"i paid" → PAYMENT_PROOF',detectIntent('i paid').primary,    'PAYMENT_PROOF');

// ─── Fuzzy Menu Matching ──────────────────────────────────────────────────────
const sampleMenu = [
  { id: 'domoda_beef',    name: 'Domoda (Beef)',    keywords: ['domoda', 'beef', 'dom'], category: 'mains' },
  { id: 'domoda_chicken', name: 'Domoda (Chicken)', keywords: ['domoda', 'chicken'],     category: 'mains' },
  { id: 'benachin_beef',  name: 'Benachin (Beef)',  keywords: ['benachin', 'jollof'],   category: 'mains' },
  { id: 'yassa_chicken',  name: 'Yassa Chicken',    keywords: ['yassa'],                category: 'mains' },
];

console.log('\n🔍 Fuzzy Menu Matching Tests:');
test('"dom" matches domoda',    fuzzyMatchMenuItem('dom', sampleMenu)[0]?.item.id.startsWith('domoda'), true);
test('"beef" top match',        fuzzyMatchMenuItem('beef', sampleMenu)[0]?.item.id,  'domoda_beef');
test('"the beef one"',          fuzzyMatchMenuItem('the beef one', sampleMenu)[0]?.confidence !== 'low', true);
test('"jollof" → benachin',     fuzzyMatchMenuItem('jollof', sampleMenu)[0]?.item.id, 'benachin_beef');
test('"yasa" (typo) → yassa',   fuzzyMatchMenuItem('yasa', sampleMenu)[0]?.item.id,   'yassa_chicken');

// ─── Quantity Validation ──────────────────────────────────────────────────────
console.log('\n✅ Quantity Validation Tests:');
test('qty 1 is valid',   validateQuantity(1).valid,  true);
test('qty 5 is valid',   validateQuantity(5).valid,  true);
test('qty 25 is warn',   validateQuantity(25).valid, 'warn');
test('qty 101 is invalid', validateQuantity(101).valid, false);
test('qty 0 is invalid', validateQuantity(0).valid, false);

// ─── Results ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('All tests passed! 🎉\n');
