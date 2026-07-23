# development/CODE_EXAMPLES.md

Concrete, real (lightly trimmed) code from this codebase for the patterns
an AI is most likely to need to reproduce. Prefer copying these shapes
over inventing a new one — consistency across 11 verticals is what makes
this codebase navigable.

## UIResponse shapes

```js
// Plain text
{ type: 'text', body: 'Thanks for your order!' }

// Buttons — MAX 3, dispatcher.js silently drops the rest
{
  type: 'buttons',
  body: '✅ No problem! What would you like to do?',
  buttons: [
    { id: 'ORDER',     title: '🛍 New Order' },
    { id: 'SUPPORT',   title: '💬 Contact Support' },
    { id: 'SHOW_MENU', title: '🔄 Start Over' },
  ],
}

// List — max 10 rows TOTAL across all sections
{
  type: 'list',
  header: 'Our Menu',                 // optional, ≤60 chars
  body: 'Choose an item ▼',
  footer: 'Prices in GMD',            // optional, ≤60 chars
  button: 'View Items',               // list-open button label, ≤20 chars
  rows: [
    { id: 'ITEM_0', title: 'Jollof Rice',  description: 'D150' }, // description optional, ≤72 chars
    { id: 'ITEM_1', title: 'Chicken Yassa', description: 'D200' },
  ],
  // OR sectioned:
  // sections: [{ title: 'Mains', rows: [...] }, { title: 'Drinks', rows: [...] }]
}

// Image
{ type: 'image', url: 'https://res.cloudinary.com/.../item.jpg', caption: 'Jollof Rice — D150' }
```

## A real per-step flow handler branch (`modules/restaurant/flows/orderFlow.js`, `SELECT_ITEM`)

Demonstrates the full "resolve free-text against known items" pattern used
throughout every vertical — numeric index (only trusted after the menu was
actually shown), cancel-keyword escape, too-short nudge, casual/gibberish
detection (so a stray "lol" doesn't get treated as a product name), and
finally fuzzy matching via `findBestMatch()` with confidence-gated behavior:

```js
case 'SELECT_ITEM': {
  const isPureNumeric = /^\d+$/.test(raw.trim());
  const numIndex = WORD_NUMS[clean] ?? (isPureNumeric ? parseInt(raw, 10) - 1 : NaN);
  const isNum    = !isNaN(numIndex) && numIndex >= 0;

  if (isNum) {
    // Only trust a numeric tap if the customer actually saw the menu first —
    // otherwise "2" typed cold could silently hijack an arbitrary menu index.
    const trustedPick = isInteractive || session.menuViewed;
    if (!trustedPick) {
      await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
      return buildMenuUI(business);
    }
    const item = menu[numIndex];
    if (!item) return buildMenuUI(business);
    return await _selectItem(item, session, business, data);
  }

  if (/^(cancel|stop|exit|back|menu|home)$/i.test(clean)) return buildMenuUI(business);

  if (clean.length < 3) {
    return {
      type: 'buttons',
      body: `Please type the name of what you'd like to order, or tap *View Menu*:`,
      buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
    };
  }

  // ... casual/gibberish detection omitted for brevity, see the real file ...

  const { item, confidenceLevel } = findBestMatch(menu, clean);

  if (confidenceLevel === 'HIGH') return await _selectItem(item, session, business, data);

  if (confidenceLevel === 'LOW') {
    // NEVER auto-select on LOW confidence — always confirm first.
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SUGGESTION_CONFIRM', data: { ...data, suggestion: item.name },
    });
    return {
      type: 'buttons',
      body: `🤔 Did you mean *${item.name}*?`,
      buttons: [
        { id: 'CONFIRM',   title: `✅ Yes, ${item.name.slice(0,15)}` },
        { id: 'SHOW_MENU', title: '🔄 Start Over' },
      ],
    };
  }

  // NONE — no auto-anything, just a helpful nudge back to browsing.
  return {
    type: 'buttons',
    body: `I couldn't find "*${raw.slice(0,30)}*" on our menu.\n\nTap below to browse all items:`,
    buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
  };
}
```

## Minimal skeleton for a brand-new flow handler

```js
// modules/<vertical>/flows/index.js
export const MYVERTICAL_CONFIG = {
  businessMode: 'MYVERTICAL',
  flows: ['ORDER'],
  persona: 'friendly, concise, knows the product line well',
  steps: { ORDER: ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'] },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: '🛍 Shop' },      // max 3 buttons total
      { id: 'QUESTION', title: '❓ Question' },
    ],
  },
};

export async function handleMyVerticalOrder({ session, message, business, tenant, isInteractive = false }) {
  const step = session.step;
  const data = session.data || {};
  const raw  = String(message || '').trim();

  // message === null on first entry (called via startFlow) → render first-step UI
  if (!step) {
    await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM' });
    return buildItemListUI(business);
  }

  switch (step) {
    case 'SELECT_ITEM': {
      // ... resolve raw/isInteractive against business.menuItems, see the
      //     SELECT_ITEM example above for the full pattern to follow ...
    }
    case 'QUANTITY': {
      // ... parseQuantity(raw), update data.item.quantity, move to CONFIRM ...
    }
    case 'CONFIRM': {
      // ... on CONFIRM button/keyword: services/orderService.js saveOrder(),
      //     then flowEngine.completeFlow(session, 'ORDER', business, tenant) ...
    }
    default:
      return { type: 'buttons', body: '⚠️ Something went wrong.',
        buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }] };
  }
}
```

Then in `core/shared/moduleRegistry.js`:
```js
const { handleMyVerticalOrder } = await import('../../modules/myvertical/flows/index.js');
registerFlow('MYVERTICAL', 'ORDER', handleMyVerticalOrder);
```
And in `config/modes.js`'s `MODE_MAP`, plus `BusinessConfig.businessMode`'s
enum. See `.ai/flows/FLOW_ENGINE.md`'s full "adding a new vertical"
checklist for everything else this needs (intents, button IDs,
`STEP_VALID_BUTTONS`, tests).

## Regression test skeleton (behavior-test style)

```js
// tests/myNewFix.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { myPureFunction } from '../services/myService.js';

// Bug: <one-paragraph root-cause explanation, matching the style of
// existing test file headers — this file IS the documentation of the bug>
test('myPureFunction: <specific behavior being fixed>', () => {
  const result = myPureFunction(/* input that only passes with the fix */);
  assert.equal(result, /* correct value */, 'explain why this is correct');
});
```

## Regression test skeleton (source-text-guard style, when live Mongo would
be required to import directly)

```js
// tests/myNewFix.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}
const src = read('../controllers/someController.js');

test('someController: <fix description>', () => {
  assert.match(src, /the specific fixed pattern/);
  // Prefer ALSO copying the actual fixed logic verbatim and exercising it
  // in isolation (see tests/waCatalogPartialUpdate.test.mjs for the
  // canonical example) so the test fails on behavior regression, not just
  // on source-text drift.
});
```
