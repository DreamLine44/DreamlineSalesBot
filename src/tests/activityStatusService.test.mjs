// tests/activityStatusService.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectStatusScope,
  formatOrderStatusCard,
  formatBookingStatusCard,
} from '../services/activityStatusService.js';

test('detectStatusScope: booking-only phrases query bookings only', () => {
  assert.equal(detectStatusScope('track my booking'), 'BOOKING');
  assert.equal(detectStatusScope('booking status'), 'BOOKING');
  assert.equal(detectStatusScope('check my appointment'), 'BOOKING');
});

test('detectStatusScope: order-only phrases query orders only', () => {
  assert.equal(detectStatusScope('track my order'), 'ORDER');
  assert.equal(detectStatusScope('order status'), 'ORDER');
  assert.equal(detectStatusScope("where's my food"), 'ORDER');
});

test('detectStatusScope: generic status checks both', () => {
  assert.equal(detectStatusScope('status'), 'BOTH');
  assert.equal(detectStatusScope('my activities'), 'BOTH');
});

test('formatOrderStatusCard matches the clean Order Update layout', () => {
  const card = formatOrderStatusCard({
    shortId: '86294A',
    item: 'Superkanja',
    quantity: 1,
    status: 'completed',
    paymentStatus: 'confirmed',
    updatedAt: new Date('2026-07-18T12:00:00Z'),
  }, { payment: { currency: 'GMD' } });

  assert.match(card, /📦 \*Order Update\*/);
  assert.match(card, /• Item: \*Superkanja\* × 1/);
  assert.match(card, /• Ref: \*#86294A\*/);
  assert.match(card, /• Status: ✅ Completed — thank you!/);
  assert.match(card, /• Payment: ✅ Payment confirmed/);
  assert.ok(!card.includes('Updated:'), 'completed orders should not show Updated line');
});

test('formatOrderStatusCard shows Updated for in-progress orders', () => {
  const card = formatOrderStatusCard({
    shortId: 'ABC123',
    item: 'Attaya',
    quantity: 2,
    status: 'preparing',
    paymentStatus: 'verified',
    updatedAt: new Date('2026-07-18T12:00:00Z'),
  }, {});

  assert.match(card, /• Updated:/);
});

test('formatBookingStatusCard matches the clean Booking Update layout', () => {
  const card = formatBookingStatusCard({
    shortId: 'BK9999',
    date: '2026-07-20',
    time: '7:00 PM',
    partySize: 4,
    status: 'confirmed',
  });

  assert.match(card, /📅 \*Booking Update\*/);
  assert.match(card, /• Ref: \*#BK9999\*/);
  assert.match(card, /• Date: \*2026-07-20\*/);
  assert.match(card, /• Time: \*7:00 PM\*/);
  assert.match(card, /• Guests: 4/);
  assert.match(card, /• Status: ✅ Confirmed — see you soon!/);
});
