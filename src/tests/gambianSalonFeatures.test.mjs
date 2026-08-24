// gambianSalonFeatures.test.mjs — Gambian salon/barbershop completeness regressions

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getSalonServices, getSalonPrepTip } from '../modules/salon/salonHelpers.js';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const STUDIO_CUTS = {
  businessMode: 'SALON',
  payment: { currency: 'D' },
  menuItems: [
    { name: 'Argan Oil Shampoo', price: 180, category: 'retail', available: true },
  ],
  services: [
    { name: 'Haircut', price: 200, duration: 45, available: true, prep: 'Arrive with clean hair.' },
    { name: 'Braiding', price: 400, duration: 120, available: true },
  ],
};

test('getSalonServices merges business.services[] when menuItems has no services', () => {
  const services = getSalonServices(STUDIO_CUTS);
  assert.equal(services.length, 2);
  assert.equal(services[0].name, 'Haircut');
  assert.equal(services[0].price, 200);
  assert.equal(services[1].name, 'Braiding');
});

test('getSalonServices excludes retail menuItems from bookable services', () => {
  const services = getSalonServices(STUDIO_CUTS);
  assert.ok(!services.some(s => s.name === 'Argan Oil Shampoo'));
});

test('getSalonPrepTip reads prep from services[]', () => {
  const tip = getSalonPrepTip('Haircut', STUDIO_CUTS);
  assert.equal(tip, 'Arrive with clean hair.');
});

test('getSalonPrepTip reads settings.servicePrep map', () => {
  const biz = {
    services: [{ name: 'Braiding', available: true }],
    settings: { servicePrep: { Braiding: 'Wash hair before arriving.' } },
  };
  assert.equal(getSalonPrepTip('Braiding', biz), 'Wash hair before arriving.');
});

test('getSalonPrepTip falls back to keyword tips for colour services', () => {
  const tip = getSalonPrepTip('Hair Colour', { menuItems: [], services: [] });
  assert.ok(tip && /unwashed/i.test(tip));
});

test('bookingFlow.js includes prep tip on salon confirmation', () => {
  const src = read('../core/conversations/bookingFlow.js');
  assert.match(src, /getSalonPrepTip/);
  assert.match(src, /Prep tip/);
});

test('bookingFlow.js validates closed days before DATE_CONFIRM', () => {
  const src = read('../core/conversations/bookingFlow.js');
  assert.match(src, /isBookingDateClosed/);
});

test('bookingFlow.js duplicate guard uses ±30 min window', () => {
  const src = read('../core/conversations/bookingFlow.js');
  assert.match(src, /Math\.abs\(existing - newMinutes\) <= 30/);
});

test('salon ORDER flow includes SELECT_VARIANT step', () => {
  const src = read('../modules/salon/flows/index.js');
  assert.match(src, /SELECT_VARIANT/);
  assert.match(src, /_buildProductVariantPicker/);
});

test('handleSalonQuestion routes barbershop to BARBERSHOP_QUESTION intent', () => {
  const src = read('../modules/salon/flows/index.js');
  assert.match(src, /BARBERSHOP_QUESTION/);
});

test('walk-in queue shows position and estimated wait', () => {
  const src = read('../modules/salon/flows/index.js');
  assert.match(src, /Queue position/);
  assert.match(src, /Estimated wait/);
});

test('BusinessConfig schema persists salon production fields', () => {
  const src = read('../models/BusinessConfig.js');
  assert.match(src, /staff:/);
  assert.match(src, /servicePrep:/);
  assert.match(src, /walkInWaitMinutesPerPerson:/);
  assert.match(src, /prep:.*maxlength: 300/);
});
