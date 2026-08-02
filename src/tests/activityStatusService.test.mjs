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

test('formatOrderStatusCard includes ref, items, status, payment, and last updated', () => {
  const card = formatOrderStatusCard({
    shortId: 'ABC123',
    item: 'Attaya',
    quantity: 2,
    status: 'confirmed',
    paymentStatus: 'verified',
    updatedAt: new Date('2026-07-18T12:00:00Z'),
  }, { payment: { currency: 'GMD' } });

  assert.match(card, /Order #ABC123/);
  assert.match(card, /Attaya/);
  assert.match(card, /Confirmed/i);
  assert.match(card, /Payment:/);
  assert.match(card, /Last updated:/);
});

test('formatBookingStatusCard includes ref, date, time, guests, and status', () => {
  const card = formatBookingStatusCard({
    shortId: 'BK9999',
    date: '2026-07-20',
    time: '7:00 PM',
    partySize: 4,
    status: 'confirmed',
  });

  assert.match(card, /Booking #BK9999/);
  assert.match(card, /2026-07-20/);
  assert.match(card, /7:00 PM/);
  assert.match(card, /Guests: 4/);
  assert.match(card, /Confirmed/i);
});
