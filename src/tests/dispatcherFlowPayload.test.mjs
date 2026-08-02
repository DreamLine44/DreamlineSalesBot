// tests/dispatcherFlowPayload.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SIMULATION_MODE = 'true';

const { dispatchMessage } = await import('../core/whatsapp/dispatcher.js');

test('dispatchMessage: flow type builds interactive flow payload', async () => {
  const ui = {
    type:       'flow',
    body:       'Pick your date',
    header:     '📅 Choose date',
    footer:     'Or type a date',
    flowId:     '999888777',
    flowToken:  'bkdt_test_token',
    flowCta:    '📅 Pick date',
    flowScreen: 'BOOKING_DATE',
    flowData:   { min_date: '2026-08-02', max_date: '2027-08-02' },
  };
  const { payload } = await dispatchMessage('2201234567', ui, {});
  assert.equal(payload.type, 'interactive');
  assert.equal(payload.interactive.type, 'flow');
  assert.equal(payload.interactive.action.parameters.flow_id, '999888777');
  assert.equal(payload.interactive.action.parameters.flow_action_payload.screen, 'BOOKING_DATE');
  assert.deepEqual(payload.interactive.action.parameters.flow_action_payload.data, ui.flowData);
});

test('dispatchMessage: flow without flowId returns null payload', async () => {
  const { payload } = await dispatchMessage('2201234567', { type: 'flow', body: 'x' }, {});
  assert.equal(payload, null);
});
