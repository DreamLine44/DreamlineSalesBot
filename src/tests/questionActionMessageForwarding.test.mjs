// tests/questionActionMessageForwarding.test.mjs
//
// [FIX-QSTART-MSG] Regression tests for the "going in circles" bug: a customer
// typing their real question as free text (e.g. "i want to know the prices of
// your food items") got intent-classified as QUESTION, routed to
// ACTION_REGISTRY's QUESTION handler in moduleRegistry.js, which called
// startFlow('QUESTION', ...) — and startFlow() unconditionally called the flow
// handler with message: null "to trigger first-step UI". That's correct for a
// genuine button tap, but for typed free text it threw the customer's real
// words away and replaced them with the canned "What would you like to know?"
// prompt every single time, so the customer just got the same question back
// forever (see the WhatsApp screenshot: four consecutive "What would you like
// to know?" replies to the same typed question).
//
// Fix, in two parts:
//   1. flowEngine.js's startFlow() now accepts an optional `message` (default
//      null) and forwards it to the handler instead of a hardcoded null.
//   2. moduleRegistry.js's QUESTION action handler now distinguishes a fresh
//      button/list tap (isInteractive, or message === the literal 'QUESTION'
//      button id) from real typed text, and forwards the real text through —
//      both to the mode-specific QUESTION flow handlers, and to the generic
//      AI fallback branch for modes with no dedicated QUESTION flow.
//
// These are source-extraction tests (matching the existing convention in
// questionModeCartPreservation.test.mjs / midFlowOrderBookingSwitch.test.mjs)
// since flowEngine.js and moduleRegistry.js pull in a live Mongo-backed
// sessionService at module scope.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('flowEngine.js startFlow(): accepts an optional message and forwards it to the handler instead of hardcoding null', () => {
  const src = read('../core/conversations/flowEngine.js');

  assert.match(
    src,
    /export async function startFlow\(\{\s*flowName,\s*session,\s*business,\s*tenant,\s*message\s*=\s*null\s*\}\)/,
    'startFlow must accept an optional message parameter defaulting to null (so every existing no-message call site keeps its current behaviour)'
  );

  const callMatch = src.match(/const response = await handler\(\{[^}]*\}\);/);
  assert.ok(callMatch, 'handler invocation inside startFlow not found');
  assert.match(
    callMatch[0],
    /message(?!:\s*null)/,
    'startFlow must call the handler with the forwarded `message`, not a hardcoded null'
  );
  assert.doesNotMatch(
    callMatch[0],
    /message:\s*null/,
    'startFlow must no longer hardcode message: null on the handler call'
  );
});

test("moduleRegistry.js QUESTION action: distinguishes a fresh button tap from typed free text and forwards the real question", () => {
  const src = read('../core/shared/moduleRegistry.js');

  // [FIX-STARTFLOW-FALLBACK] This logic now lives in the standalone
  // handleQuestionAction() function (factored out so other actions can reuse
  // it as a fallback), with registerAction('QUESTION', handleQuestionAction)
  // simply pointing at it — rather than an inline arrow function.
  const start = src.indexOf('async function handleQuestionAction');
  assert.ok(start !== -1, 'handleQuestionAction function not found');
  const end = src.indexOf('\nasync function startFlowOrAnswerQuestion', start);
  assert.ok(end !== -1, 'end of handleQuestionAction function not found');
  const block = src.slice(start, end);

  assert.match(
    src,
    /registerAction\('QUESTION',\s*handleQuestionAction\)/,
    "registerAction('QUESTION', ...) must be wired to handleQuestionAction"
  );

  assert.match(
    block,
    /isInteractive/,
    'QUESTION action handler must inspect isInteractive to detect a genuine button/list tap'
  );
  assert.match(
    block,
    /isFreshTap/,
    'QUESTION action handler must compute an explicit fresh-tap flag rather than always forwarding or always discarding the message'
  );

  // The mode-specific branch must no longer call startFlow without forwarding
  // the customer's real typed text.
  assert.doesNotMatch(
    block,
    /startFlow\(\{\s*flowName:\s*'QUESTION',\s*session,\s*business,\s*tenant\s*\}\)/,
    'must not call startFlow for QUESTION without forwarding the (possibly real) message through'
  );
  assert.match(
    block,
    /startFlow\(\{\s*flowName:\s*'QUESTION',[\s\S]*?message:\s*typedQuestion[\s\S]*?\}\)/,
    'must forward the typed question into startFlow so mode-specific QUESTION handlers answer it immediately'
  );

  // The generic (no dedicated QUESTION flow) fallback must also answer a real
  // typed question immediately, not just persist state and echo the static
  // prompt back at the customer.
  assert.match(
    block,
    /processQuestionMessage/,
    'generic fallback branch must call processQuestionMessage to answer a real typed question on this turn'
  );
});

test('modules/restaurant/flows/orderFlow.js: handleRestaurantQuestion answers immediately when called with real text (not just on message === null)', () => {
  const src = read('../modules/restaurant/flows/orderFlow.js');
  const start = src.indexOf('export async function handleRestaurantQuestion');
  assert.ok(start !== -1, 'handleRestaurantQuestion not found');
  const block = src.slice(start, start + 1500);

  // No message === null INIT branch gating the whole handler — a real
  // message passed straight through should reach processQuestionMessage.
  assert.doesNotMatch(
    block,
    /if\s*\(message === null\)/,
    'handleRestaurantQuestion must not gate on message === null before answering — a forwarded real question must be answered on this call'
  );
  assert.match(
    block,
    /resolveQuestionReply/,
    'handleRestaurantQuestion must answer via resolveQuestionReply when given real text'
  );
});
