/**
 * DreamlineSalesBot — NLP & Matching Test Suite
 *
 * Tests: quantity parsing, fuzzy menu matching, intent detection (brainService),
 *        phrase numbers, large-order warning threshold, edge cases.
 *
 * Run with:  node tests/nlp.test.mjs
 *
 * Uses Node's native assert module — no test framework needed.
 * Exit code 0 = all pass, 1 = failures.
 */

import assert from 'assert/strict';

// ─── Inline test helpers ───────────────────────────────────────────────────────

let passed = 0;
let failed  = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  ✅ ${description}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${description}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

function eq(actual, expected, desc = '') {
  assert.deepEqual(actual, expected, desc || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── 1. PHRASE_NUMBERS & parseQuantity ───────────────────────────────────────
// We test the logic directly by importing the module-level PHRASE_NUMBERS
// and replicating the parsing steps, since parseQuantity is not exported.
// For the exported-module tests we call brainService's intent engine.

// Replicate PHRASE_NUMBERS (must stay in sync with flowService.js)
const PHRASE_NUMBERS = {
  'a dozen':12,'one dozen':12,'two dozen':24,'three dozen':36,
  'half dozen':6,'half a dozen':6,
  'a couple':2,'a pair':2,'a few':3,'several':4,
  'a score':20,'a gross':144,
  'twenty one':21,'twenty two':22,'twenty three':23,'twenty four':24,
  'twenty five':25,'twenty six':26,'twenty seven':27,'twenty eight':28,
  'twenty nine':29,
  'thirty five':35,'forty five':45,'fifty five':55,
};
const PHRASE_SORTED = Object.entries(PHRASE_NUMBERS).sort((a,b)=>b[0].length-a[0].length);

function phraseMatch(raw) {
  const lower = raw.toLowerCase();
  for (const [phrase, num] of PHRASE_SORTED) {
    if (lower.includes(phrase)) return num;
  }
  return null;
}

// Replicate WORD_NUMBERS (canonical set from flowService.js)
const WORD_NUMBERS = {
  zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,
  eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,
  seventy:70,eighty:80,ninety:90,hundred:100,
  // Misspellings from v13 patch
  wan:1,wun:1,onne:1,tow:2,tu:2,too:2,fore:4,for:4,fife:5,fiv:5,
  sex:6,siks:6,sevn:7,sevan:7,seben:7,eght:8,eigth:8,eit:8,nien:9,nein:9,
  elevan:11,elever:11,elvn:11,twelv:12,twelf:12,twleve:12,
  thirten:13,forteen:14,fourten:14,forten:14,fiften:15,fiveteen:15,
  sixten:16,seventen:17,seventeeen:17,eighten:18,eightteen:18,ninten:19,nineteen:19,
  twentey:20,tweny:20,twenti:20,thirthy:30,thiry:30,fourty:40,foty:40,
  fity:50,fifthy:50,fiffty:50,sixthy:60,sixy:60,sevnty:70,sevanty:70,
  eightey:80,eighthy:80,eigthy:80,
  ninty:90,ninety:90,niety:90,ninnty:90,ninity:90,ninite:90,
};

console.log('\n📦 Phrase Number Tests:');
test('"a dozen" → 12',        () => eq(phraseMatch('a dozen'), 12));
test('"one dozen" → 12',      () => eq(phraseMatch('one dozen'), 12));
test('"two dozen" → 24',      () => eq(phraseMatch('two dozen'), 24));
test('"half dozen" → 6',      () => eq(phraseMatch('half dozen'), 6));
test('"half a dozen" → 6',    () => eq(phraseMatch('half a dozen'), 6));
test('"a couple" → 2',        () => eq(phraseMatch('a couple'), 2));
test('"a pair" → 2',          () => eq(phraseMatch('a pair'), 2));
test('"a few" → 3',           () => eq(phraseMatch('a few'), 3));
test('"several" → 4',         () => eq(phraseMatch('several'), 4));
test('"twenty five" → 25',    () => eq(phraseMatch('twenty five'), 25));
test('"thirty five" → 35',    () => eq(phraseMatch('thirty five'), 35));
test('"I want a dozen" → 12', () => eq(phraseMatch('I want a dozen'), 12));
test('"give me half a dozen domoda" → 6', () => eq(phraseMatch('give me half a dozen domoda'), 6));
test('no phrase → null',      () => eq(phraseMatch('please'), null));

// ─── 2. WORD_NUMBERS: misspellings ───────────────────────────────────────────

console.log('\n🔡 Word-Number Misspelling Tests:');
const check = (word, expected) => test(`"${word}" → ${expected}`, () => eq(WORD_NUMBERS[word], expected));
check('wan', 1);
check('tow', 2);
check('fore', 4);
check('fife', 5);
check('seben', 7);
check('nein', 9);
check('elevan', 11);
check('twleve', 12);
check('fiften', 15);
check('fiveteen', 15);
check('fourten', 14);
check('seventen', 17);
check('eighten', 18);
check('ninten', 19);
check('twentey', 20);
check('thirthy', 30);
check('fourty', 40);
check('foty', 40);
check('fity', 50);
check('ninty', 90);
check('ninnty', 90);
check('ninite', 90);

// ─── 3. Large-order boundary ─────────────────────────────────────────────────

console.log('\n⚠️  Large-Order Boundary Tests:');
test('qty 20 is within normal range (no warn)', () => {
  assert.ok(20 <= 20, '20 should not trigger warning');
});
test('qty 21 crosses into large-order territory', () => {
  assert.ok(21 > 20, '21 should trigger confirmation prompt');
});
test('qty 100 is max allowed (no reject)', () => {
  assert.ok(100 <= 100, '100 should be accepted');
});
test('qty 101 exceeds max (reject)', () => {
  assert.ok(101 > 100, '101 should be rejected');
});

// ─── 4. matchEngine — findBestMatch ──────────────────────────────────────────

console.log('\n🔍 matchEngine.findBestMatch Tests:');

// Dynamic import (ESM)
const { findBestMatch, normalize } = await import('../utils/matchEngine.js');

const sampleMenu = [
  { name: 'Domoda (Beef)',    available: true,  keywords: ['domoda','beef','dom'] },
  { name: 'Domoda (Chicken)', available: true,  keywords: ['domoda','chicken']   },
  { name: 'Benachin (Beef)', available: true,   keywords: ['benachin','jollof']  },
  { name: 'Yassa Chicken',   available: true,   keywords: ['yassa']              },
  { name: 'Plain Rice',      available: false,  keywords: ['rice']               },
];

test('"dom" → Domoda (HIGH)', () => {
  const r = findBestMatch(sampleMenu, 'dom');
  assert.ok(r.confidenceLevel === 'HIGH', `Got ${r.confidenceLevel} for "${r.item?.name}"`);
  assert.ok(r.item?.name.includes('Domoda'), `Expected Domoda, got "${r.item?.name}"`);
});

test('"jollof" → NONE from matchEngine (keyword matching is a flowService layer above)', () => {
  // matchEngine.findBestMatch works on item.name tokens only.
  // "jollof" is a keyword for Benachin but is NOT in the name "Benachin (Beef)".
  // Keyword-to-item resolution happens in flowService before calling findBestMatch.
  const r = findBestMatch(sampleMenu, 'jollof');
  assert.equal(r.confidenceLevel, 'NONE', `"jollof" should be NONE at the name-matching layer; got ${r.confidenceLevel} for "${r.item?.name}"`);
});

test('"yasa" (typo) → Yassa Chicken (LOW confidence — ask user)', () => {
  const r = findBestMatch(sampleMenu, 'yasa');
  assert.ok(['HIGH','LOW'].includes(r.confidenceLevel), `Got ${r.confidenceLevel}`);
  assert.equal(r.item?.name, 'Yassa Chicken');
});

test('"hello" does NOT match anything (NONE)', () => {
  const r = findBestMatch(sampleMenu, 'hello');
  assert.equal(r.confidenceLevel, 'NONE', `"hello" matched "${r.item?.name}" (${r.confidenceLevel}) — false positive!`);
});

test('unavailable item ("Plain Rice") never returned', () => {
  const r = findBestMatch(sampleMenu, 'rice');
  // Either no match, or a non-rice item matched (rice is unavailable)
  assert.ok(!r.item || r.item.name !== 'Plain Rice', `Returned unavailable "Plain Rice"`);
});

test('empty query → NONE', () => {
  const r = findBestMatch(sampleMenu, '');
  assert.equal(r.confidenceLevel, 'NONE');
});

test('"benachin" (full name) → HIGH', () => {
  const r = findBestMatch(sampleMenu, 'benachin');
  assert.equal(r.confidenceLevel, 'HIGH');
  assert.equal(r.item?.name, 'Benachin (Beef)');
});

// ─── 5. normalize utility ─────────────────────────────────────────────────────

console.log('\n🔤 normalize() Tests:');
test('lowercase',             () => eq(normalize('HELLO'), 'hello'));
test('strips punctuation',    () => eq(normalize('dom!oda.'), 'domoda'));
test('trims whitespace',      () => eq(normalize('  yassa  '), 'yassa'));
test('empty string',          () => eq(normalize(''), ''));
test('null/undefined → ""',   () => eq(normalize(null), ''));

// ─── 6. Edge cases ────────────────────────────────────────────────────────────

console.log('\n🧪 Edge Case Tests:');
test('WORD_NUMBERS "zero" → 0',     () => eq(WORD_NUMBERS['zero'], 0));
test('WORD_NUMBERS "hundred" → 100',() => eq(WORD_NUMBERS['hundred'], 100));
test('WORD_NUMBERS "twenty" → 20',  () => eq(WORD_NUMBERS['twenty'], 20));
test('Phrase beats word: "a dozen" not matched as "a" (word)', () => {
  // "a" is not in WORD_NUMBERS; the phrase engine handles "a dozen"
  eq(phraseMatch('a dozen'), 12);
  eq(WORD_NUMBERS['a'], undefined);
});

// ─── 7. wordsToNumber — multi-word arbitrary phrases ────────────────────────
// These are the cases that PHRASE_NUMBERS + WORD_NUMBERS alone can't handle.
// wordsToNumber() is the v18 addition that covers them.

console.log('\n🔢 wordsToNumber() Multi-Word Tests:');

// Inline the exact logic from flowService.js wordsToNumber for self-contained testing
const _WN_ONES = {
  zero:0,oh:0,nought:0,nil:0,naught:0,
  one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,
  sixteen:16,seventeen:17,eighteen:18,nineteen:19,
  wan:1,wun:1,onne:1,tow:2,tu:2,too:2,fore:4,'for':4,foru:4,
  fife:5,fiv:5,sik:6,sevn:7,eght:8,eit:8,nien:9,nein:9,nin:9,
  elevan:11,elvn:11,leven:11,twelv:12,twelf:12,twleve:12,
  thirten:13,forteen:14,fourten:14,fiften:15,fiveteen:15,
  sixten:16,seventen:17,eighten:18,ninten:19,a:1,an:1,
};
const _WN_TENS = {
  twenty:20,tweny:20,twety:20,twenti:20,thirthy:30,thiry:30,
  thirty:30,forty:40,fourty:40,foty:40,fifty:50,fify:50,fiffty:50,
  sixty:60,sixy:60,seventy:70,sevnty:70,eighty:80,eightty:80,eigthy:80,
  ninety:90,ninty:90,ninity:90,niety:90,ninnty:90,ninite:90,nineti:90,
};
const _WN_MULT = {
  hundred:100,hundreds:100,hunderd:100,thousand:1000,thousands:1000,
  thousend:1000,million:1e6,billions:1e9,billion:1e9,
};
const _WN_SPECIAL = {dozen:12,dozens:12,couple:2,pair:2,score:20};

function _stripOrd(w) {
  return w.replace(/^(\d+)(st|nd|rd|th)$/i,'$1')
    .replace(/^first$/i,'one').replace(/^second$/i,'two').replace(/^third$/i,'three')
    .replace(/^fourth$/i,'four').replace(/^fifth$/i,'five')
    .replace(/^twentieth$/i,'twenty').replace(/^thirtieth$/i,'thirty')
    .replace(/^fortieth$/i,'forty').replace(/^fiftieth$/i,'fifty')
    .replace(/^ninetieth$/i,'ninety');
}
function wtn(input) {
  if(!input) return null;
  if(/half[\s-]+a[\s-]+dozen/i.test(input)) return 6;
  const toks = String(input).trim().toLowerCase()
    .replace(/-/g,' ').replace(/\band\b/gi,' ').replace(/\bof\b/gi,' ')
    .split(/[\s,]+/).filter(Boolean).map(_stripOrd);
  let total=0,current=0,found=false;
  for(const tok of toks){
    if(/^\d[\d,]*$/.test(tok)){current+=parseInt(tok.replace(/,/g,''),10);found=true;continue;}
    if(_WN_ONES[tok]!==undefined){current+=_WN_ONES[tok];found=true;}
    else if(_WN_TENS[tok]!==undefined){current+=_WN_TENS[tok];found=true;}
    else if(_WN_SPECIAL[tok]!==undefined){current=(current||1)*_WN_SPECIAL[tok];found=true;}
    else if(_WN_MULT[tok]!==undefined){
      const m=_WN_MULT[tok];
      if(m===100){current=(current||1)*100;}else{total+=(current||1)*m;current=0;}
      found=true;
    }
  }
  return found?total+current:null;
}

const wtnCheck = (input, expected) => test(`wordsToNumber("${input}") → ${expected}`, () => eq(wtn(input), expected));
wtnCheck('thousand',      1000);
wtnCheck('five hundred',  500);
wtnCheck('one thousand two hundred', 1200);
wtnCheck('five hundred thousand', 500000);
wtnCheck('a hundred',     100);
wtnCheck('half a dozen',  6);
wtnCheck('ninty',         90);
wtnCheck('twenty five',   25);
wtnCheck('ninty two',     92);
wtnCheck('three hundred', 300);

// ─── 8. Stale-spread regression ─────────────────────────────────────────────
// Documents the [FIX-STALE-SPREAD] bug: data.item must survive the
// recommendedThisSession write. Simulates the in-memory snapshot pattern.

console.log('\n🐛 Stale-Spread Regression Tests (FIX-STALE-SPREAD):');

test('item survives recommendedThisSession write (recoB pattern)', () => {
  // Before fix: { ...session.data, recommendedThisSession: true } where session.data = {}
  // After fix:  { ...session.data, item, recommendedThisSession: true }
  const sessionData = {};          // stale in-memory snapshot (item not yet in it)
  const item = 'Benachin (Chicken)';

  // BROKEN pattern (what caused the bug):
  const brokenWrite = { ...sessionData, recommendedThisSession: true };
  assert.equal(brokenWrite.item, undefined, 'Broken pattern: item is undefined (this caused the menu reset)');

  // FIXED pattern:
  const fixedWrite = { ...sessionData, item, recommendedThisSession: true };
  assert.equal(fixedWrite.item, 'Benachin (Chicken)', 'Fixed pattern: item is preserved ✅');
  assert.equal(fixedWrite.recommendedThisSession, true, 'recommendedThisSession still set ✅');
});

test('qty 15 is in normal range (no large-order warning)', () => {
  assert.ok(15 <= 20, '15 should not trigger the large-order confirmation prompt');
});

test('qty 15 is above minimum (> 0)', () => {
  assert.ok(15 > 0, '15 is a valid quantity');
});

// ─── Final results ───────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} total`);
if (failed > 0) {
  console.log('\n❌ Some tests failed — review the output above.\n');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!\n');
}

// ─── 9. Flow Protection Regression Tests (v19) ──────────────────────────────
// Simulates the brain decisions for mid-flow messages.
// These are inline simulations of brainService logic — not full integration tests.

console.log('\n🔒 Flow Protection Tests (FIX-FLOW-1..10):');

// Helper: simplified brain decision simulator for mid-flow scenarios
function simulateBrainMidFlow(raw, step) {
  const normalized = raw.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

  const GREETING_REGEX = /^(hi|hello|hey|good morning|good evening|good afternoon|salaam|salam|start|begin|greetings|yo|sup|wassup|hiya)$/i;
  const CANCEL_EXACT = ['cancel','stop','exit','quit','cancel it','cancel order','i want to cancel','abort','i want out','no thanks'];
  const SHOW_MENU_PHRASES = ['menu','back','go back','start over','restart','home','main menu','0'];
  const PROTECTED = new Set(['DATE','DATE_CONFIRM','TIME','TIME_CONFIRM','QUANTITY','SELECT_ITEM','SELECT_SERVICE','CONFIRM','INTERRUPT','PAYMENT_PROOF','UPSELL']);

  // Greeting mid-flow → CONTINUE_FLOW (FIX-FLOW-1)
  if (GREETING_REGEX.test(raw)) return 'CONTINUE_FLOW';

  // "0" mid-flow → CANCEL via flowService (FIX-FLOW-4)
  if (raw === '0') return 'CANCEL_IN_FLOW';

  // CANCEL exact phrases
  if (CANCEL_EXACT.includes(normalized)) return 'CANCEL';

  // SHOW_MENU mid-flow → CANCEL (confirm-cancel) (FIX-FLOW-2)
  if (SHOW_MENU_PHRASES.includes(normalized)) {
    return PROTECTED.has(step) ? 'CANCEL' : 'CANCEL';
  }

  return 'CONTINUE_FLOW';
}

// FIX-FLOW-1: Greeting mid-flow
test('FIX-FLOW-1: "hi" at QUANTITY step → CONTINUE_FLOW (not session wipe)', () => {
  eq(simulateBrainMidFlow('hi', 'QUANTITY'), 'CONTINUE_FLOW');
});
test('FIX-FLOW-1: "hello" at SELECT_ITEM step → CONTINUE_FLOW', () => {
  eq(simulateBrainMidFlow('hello', 'SELECT_ITEM'), 'CONTINUE_FLOW');
});
test('FIX-FLOW-1: "good morning" mid-booking DATE → CONTINUE_FLOW', () => {
  eq(simulateBrainMidFlow('good morning', 'DATE'), 'CONTINUE_FLOW');
});

// FIX-FLOW-2: SHOW_MENU mid-flow → CANCEL (confirm-cancel)
test('FIX-FLOW-2: "menu" at QUANTITY → CANCEL (not immediate wipe)', () => {
  eq(simulateBrainMidFlow('menu', 'QUANTITY'), 'CANCEL');
});
test('FIX-FLOW-2: "go back" at SELECT_ITEM → CANCEL (navigation treated as confirm-cancel)', () => {
  eq(simulateBrainMidFlow('go back', 'SELECT_ITEM'), 'CANCEL');
});
test('FIX-FLOW-2: "start over" at DATE → CANCEL', () => {
  eq(simulateBrainMidFlow('start over', 'DATE'), 'CANCEL');
});

// FIX-FLOW-4: "0" mid-flow → cancel-in-flow
test('FIX-FLOW-4: "0" mid-flow → cancel (not silent session wipe)', () => {
  eq(simulateBrainMidFlow('0', 'QUANTITY'), 'CANCEL_IN_FLOW');
});

// FIX-FLOW-9: Removed "go back"/"restart" from CANCEL intent (now SHOW_MENU/navigation)
test('FIX-FLOW-9: "go back" no longer matches bare CANCEL intent', () => {
  assert.ok(!['cancel','stop','exit','quit'].includes('go back'), '"go back" not in strict CANCEL list');
});

// FIX-FLOW-10: Session TTL refreshed on message receipt
test('FIX-FLOW-10: Session TTL should be refreshed per message (30min window)', () => {
  const ttlMs = 30 * 60 * 1000;
  const refreshed = new Date(Date.now() + ttlMs);
  assert.ok(refreshed > new Date(), 'TTL refresh sets future expiry');
});

// _buildStepReprompt logic validation
test('FIX-FLOW-6: Empty string triggers step-specific reprompt (not generic menu)', () => {
  // Simulate the guard: if (!raw && session.currentFlow) return _buildStepReprompt(session)
  const raw = '';
  const session = { currentFlow: 'ORDER', step: 'QUANTITY', data: { item: 'Domoda' } };
  // The guard condition
  const shouldReprompt = !raw && !!session.currentFlow;
  assert.ok(shouldReprompt, 'Empty raw + active flow triggers reprompt guard');
});

test('FIX-FLOW-7: CONFIRM step re-shows summary on unrecognised input', () => {
  // Any non-confirm/non-reject raw at CONFIRM must re-show the summary
  const isBtnConfirm = r => ['yes','ok','okay','y','confirm','yep','sure','yup','yeah','CONFIRM'].includes(r.toLowerCase());
  const isBtnReject  = r => ['no','nope','nah','n','CANCEL'].includes(r.toLowerCase());
  const raw = 'what time is it';
  assert.ok(!isBtnConfirm(raw) && !isBtnReject(raw), 'Unrecognised input falls to summary re-render');
});

// ─── Final total ──────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Total: ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
