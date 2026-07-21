// tests/orderButtonCatalogBypass.test.mjs
//
// [FIX-ORDER-BTN-CATALOG] Regression tests: tapping the "🍔 Order Food" welcome
// button was being silently intercepted by the WA Catalog auto-offer. Any
// tenant with WA Catalog enabled (AI_DECIDES or ALWAYS_OFFER — both defaults
// for an enabled tenant) had shouldOfferCatalog({ intent: 'ORDER' }) return
// true for BOTH a typed "order" message AND a direct button tap, since both
// produce the same classified intent. That meant offerCatalogOnStartOrder()
// sent the WA Catalog message instead of ever calling startFlow('ORDER') —
// the customer tapped "Order Food" and the module's own menu/product list
// (buildMenuUI() etc.) never appeared.
//
// Fix: moduleRegistry.js's registerAction('START_ORDER', ...) now only
// consults offerCatalogOnStartOrder() for non-interactive (typed/AI-classified)
// messages. A direct button tap always calls startFlow('ORDER') and shows the
// real menu — exactly as unambiguous a signal as tapping "🛍 Browse Catalog"
// already is (see waCatalogFlow.js#browseCatalogExplicit's own docstring).
//
// Source-text guard (not a live-DB test), consistent with this codebase's
// established convention for router/registry wiring checks that need a live
// session/Mongo connection to exercise end-to-end (see
// browseCatalogButtonWiring.test.mjs's own header comment).
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const registrySrc = read('../core/shared/moduleRegistry.js');

function extractStartOrderAction(src) {
  const start = src.indexOf("registerAction('START_ORDER'");
  assert.ok(start !== -1, 'registerAction(\'START_ORDER\', ...) not found in moduleRegistry.js');
  // Grab up to the next registerAction( call (or a generous fixed window,
  // whichever comes first) so we only inspect this handler's own body.
  const nextCallOffset = src.indexOf("registerAction(", start + 20);
  const end = nextCallOffset !== -1 ? nextCallOffset : start + 2000;
  return src.slice(start, end);
}

test('moduleRegistry.js: START_ORDER handler destructures isInteractive', () => {
  const body = extractStartOrderAction(registrySrc);
  assert.match(
    body,
    /registerAction\('START_ORDER',\s*async\s*\(\s*\{[^}]*isInteractive[^}]*\}\s*\)/,
    'START_ORDER handler must accept isInteractive to distinguish a button tap from typed text',
  );
});

test('moduleRegistry.js: START_ORDER only calls offerCatalogOnStartOrder for non-interactive messages', () => {
  const body = extractStartOrderAction(registrySrc);
  const catalogCallIdx = body.indexOf('await offerCatalogOnStartOrder(');
  assert.ok(catalogCallIdx !== -1, 'offerCatalogOnStartOrder call not found');
  const guardIdx = body.indexOf('if (!isInteractive)');
  assert.ok(guardIdx !== -1, 'must guard the catalog auto-offer behind !isInteractive');
  assert.ok(
    guardIdx < catalogCallIdx,
    'the !isInteractive guard must wrap the offerCatalogOnStartOrder() call, not just exist somewhere in the handler',
  );
});

test('moduleRegistry.js: START_ORDER always calls startFlow(\'ORDER\') regardless of the catalog branch', () => {
  const body = extractStartOrderAction(registrySrc);
  assert.match(body, /startFlow\(\s*\{\s*flowName:\s*'ORDER'/, 'must still fall through to the real ORDER flow');
});
