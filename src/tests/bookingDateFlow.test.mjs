// tests/bookingDateFlow.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBookingDateFlowId,
  shouldUseBookingDateFlow,
  getBookingDateFlowBounds,
  buildBookingDateFlowMessage,
  parseBookingDateFlowReply,
  resolveFlowBookingDate,
  BOOKING_DATE_FLOW_SCREEN,
} from '../services/bookingDateFlow.js';

const TZ = 'Africa/Banjul';

test('shouldUseBookingDateFlow: opt-in only when BOOKING_DATE_FLOW_ENABLED=true', () => {
  const prevId = process.env.BOOKING_DATE_FLOW_ID;
  const prevEn = process.env.BOOKING_DATE_FLOW_ENABLED;
  process.env.BOOKING_DATE_FLOW_ID = '123';
  process.env.BOOKING_DATE_FLOW_ENABLED = 'false';
  assert.equal(shouldUseBookingDateFlow({}, {}), false);
  process.env.BOOKING_DATE_FLOW_ENABLED = 'true';
  assert.equal(shouldUseBookingDateFlow({}, {}), true);
  process.env.BOOKING_DATE_FLOW_ID = prevId;
  process.env.BOOKING_DATE_FLOW_ENABLED = prevEn;
});

test('resolveBookingDateFlowId: business config beats env', () => {
  const prev = process.env.BOOKING_DATE_FLOW_ID;
  process.env.BOOKING_DATE_FLOW_ID = 'env_flow';
  assert.equal(resolveBookingDateFlowId({ whatsappFlows: { bookingDateFlowId: 'biz_flow' } }, {}), 'biz_flow');
  assert.equal(resolveBookingDateFlowId({}, { whatsapp: { bookingDateFlowId: 'tenant_flow' } }), 'tenant_flow');
  assert.equal(resolveBookingDateFlowId({}, {}), 'env_flow');
  process.env.BOOKING_DATE_FLOW_ID = prev;
});

test('getBookingDateFlowBounds: returns YYYY-MM-DD min/max', () => {
  const { min_date, max_date } = getBookingDateFlowBounds(TZ);
  assert.match(min_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(max_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(max_date >= min_date);
});

test('buildBookingDateFlowMessage: flow UI payload', () => {
  const ui = buildBookingDateFlowMessage({
    flowId: '123456789',
    tz: TZ,
    customerPhone: '2201234567',
  });
  assert.equal(ui.type, 'flow');
  assert.equal(ui.flowId, '123456789');
  assert.equal(ui.flowScreen, BOOKING_DATE_FLOW_SCREEN);
  assert.ok(ui.flowData.min_date);
  assert.ok(ui.flowData.max_date);
  assert.ok(ui.flowToken.startsWith('bkdt_'));
});

test('parseBookingDateFlowReply: extracts booking_date', () => {
  assert.equal(parseBookingDateFlowReply({ booking_date: '2026-08-15' }), '2026-08-15');
  assert.equal(parseBookingDateFlowReply({ date: '2026-12-01' }), '2026-12-01');
  assert.equal(parseBookingDateFlowReply({}), null);
});

test('resolveFlowBookingDate: validates future date', async () => {
  const future = new Date();
  future.setUTCMonth(future.getUTCMonth() + 2);
  const iso = `${future.getUTCFullYear()}-${String(future.getUTCMonth() + 1).padStart(2, '0')}-15`;
  const resolved = await resolveFlowBookingDate(iso, TZ);
  assert.equal(resolved.ok, true);
  assert.ok(resolved.parsed instanceof Date);
});

test('resolveFlowBookingDate: rejects invalid format', async () => {
  const resolved = await resolveFlowBookingDate('not-a-date', TZ);
  assert.equal(resolved.ok, false);
});
