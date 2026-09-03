// tests/salonParity.test.mjs — salon/barbershop parity with restaurant fixes

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('SALON_CONFIG: welcomeList includes shop products and browse catalog', () => {
  const src = read('../modules/salon/flows/index.js');
  const salonBlock = src.slice(src.indexOf('export const SALON_CONFIG'), src.indexOf('export const BARBERSHOP_CONFIG'));
  assert.match(salonBlock, /welcomeList/);
  assert.match(salonBlock, /id: 'ORDER'/);
  assert.match(salonBlock, /id: 'BROWSE_CATALOG'/);
  assert.match(salonBlock, /Shop Products/);
});

test('salon product flow: quantity picker has no typing footer', () => {
  const src = read('../modules/salon/flows/index.js');
  assert.ok(!src.includes("footer: 'Or type any number'"));
  assert.ok(!src.includes('Tap a service or type its name'));
});

test('bookingFlow.js: buildRescheduleDatePicker opens shared date picker', () => {
  const src = read('../core/conversations/bookingFlow.js');
  assert.match(src, /export async function buildRescheduleDatePicker/);
  assert.match(src, /handleBookingFlow\(/);
});

test('postFlowHandler.js: RESCHEDULE uses buildRescheduleDatePicker', () => {
  const src = read('../services/shared/postFlowHandler.js');
  assert.match(src, /buildRescheduleDatePicker/);
});

test('adminCommandService.js: confirmed booking offers reschedule button', () => {
  const src = read('../services/admin/adminCommandService.js');
  const block = src.slice(src.indexOf('confirmBooking'), src.indexOf('// [v14-UPSELL]'));
  assert.match(block, /RESCHEDULE/);
});

test('getSalonServices export exists for services[]-only tenants', async () => {
  const { getSalonServices } = await import('../modules/salon/salonHelpers.js');
  const list = getSalonServices({
    businessMode: 'SALON',
    menuItems: [],
    services: [{ name: 'Haircut', price: 200, available: true }],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Haircut');
});
