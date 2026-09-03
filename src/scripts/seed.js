/**
 * scripts/seed.js — WhatSalesAgent2
 *
 * Creates demo tenants and business configs for all 6 modules.
 * Run: npm run seed
 *
 * Creates:
 *   1. DreamLine Restaurant (RESTAURANT)
 *   2. Golden Bakery (BAKERY)
 *   3. Studio Cuts (SALON)
 *   4. UrbanWear (FASHION)
 *   5. GlowUp Beauty (COSMETICS)
 *   6. TechHub (ELECTRONICS)
 */

import '../config/env.js';
import mongoose       from 'mongoose';
import { connectToDB } from '../config/database.js';
import { Tenant, BusinessConfig } from '../models/index.js';
import crypto         from 'crypto';

const BUSINESSES = [
  {
    name: 'DreamLine Restaurant01',
    businessMode: 'RESTAURANT',
    adminPhone: '2207000001',
    description: 'Fresh West African cuisine with a modern twist.',
    whatsapp: { phoneNumberId: 'SIM_REST01', accessToken: null },
    menuItems: [
      { name: 'Superkanja', price: 150, description: 'Rich leaf stew with fish', category: 'Mains', available: true },
      { name: 'Benachin', price: 130, description: 'One-pot spiced rice dish', category: 'Mains', available: true },
      { name: 'Tapalapa Bread with Omelette', price: 75, description: 'Freshly baked bread with egg', category: 'Breakfast', available: true },
      { name: 'Yassa Chicken', price: 160, description: 'Marinated chicken with onion sauce', category: 'Mains', available: true },
      { name: 'Domoda', price: 140, description: 'Groundnut stew with rice', category: 'Mains', available: true },
      { name: 'Juice', price: 40, description: 'Fresh seasonal juice', category: 'Drinks', available: true },
    ],
    services: [{ name: 'Indoor Table', available: true }, { name: 'Outdoor Terrace', available: true }],
    payment: { enabled: true, requireProof: true, wavePhone: '2207111111', currency: 'D', channels: [{ provider: 'Wave', accountNo: '2207111111', isDefault: true }] },
    addOns: [{ name: 'Soft Drink', price: 40 }, { name: 'Extra Sauce', price: 25 }, { name: 'Dessert', price: 75 }],
    faq: [
      { trigger: 'opening hours,open,hours', reply: 'We\'re open daily 8am–10pm 🕗' },
      { trigger: 'location,where,address', reply: '📍 Kololi, Senegambia Strip, The Gambia' },
      { trigger: 'delivery,deliver', reply: '🛵 We deliver within Senegambia area. Min order D100.' },
    ],
  },
  {
    name: 'Golden Bakery',
    businessMode: 'BAKERY',
    adminPhone: '2207000002',
    description: 'Artisan breads, pastries and custom cakes baked fresh daily.',
    whatsapp: { phoneNumberId: 'SIM_BAK01', accessToken: null },
    menuItems: [
      { name: 'Tapalapa Loaf', price: 35, description: 'Traditional round bread', available: true },
      { name: 'Croissant', price: 45, description: 'Buttery French pastry', available: true },
      { name: 'Chocolate Cake Slice', price: 80, description: 'Rich moist chocolate cake', available: true },
      { name: 'Meat Pie', price: 50, description: 'Flaky pastry with spiced meat filling', available: true },
      { name: 'Cinnamon Roll', price: 55, description: 'Soft roll with cinnamon glaze', available: true },
    ],
    services: [{ name: 'Custom Cake Order', duration: 0, available: true }, { name: 'Bulk Order Collection', available: true }],
    payment: { enabled: true, requireProof: true, wavePhone: '2207222222', currency: 'D', channels: [{ provider: 'Wave', accountNo: '2207222222', isDefault: true }] },
    faq: [
      { trigger: 'custom cake,cake order', reply: 'We love custom cakes! Tap *Order* → Custom Cake Builder. Min 3 days notice needed 🎂' },
      { trigger: 'open,hours', reply: 'Open Mon–Sat 7am–7pm, Sun 8am–2pm 🥐' },
    ],
  },
  {
    name: 'Studio Cuts',
    businessMode: 'SALON',
    adminPhone: '2207000003',
    description: 'Premium hair salon offering cuts, treatments and styling.',
    whatsapp: { phoneNumberId: 'SIM_SAL01', accessToken: null },
    menuItems: [],
    services: [
      { name: 'Haircut', price: 200, duration: 45, available: true },
      { name: 'Wash & Blow Dry', price: 250, duration: 60, available: true },
      { name: 'Hair Treatment', price: 350, duration: 90, available: true },
      { name: 'Braiding', price: 400, duration: 120, available: true },
      { name: 'Full Package', price: 600, duration: 180, available: true },
    ],
    payment: { enabled: false },
    faq: [
      { trigger: 'price,cost,how much', reply: 'Prices: Haircut D200, Wash & Blow D250, Treatment D350, Braiding D400. Full package D600 💇' },
      { trigger: 'open,hours,available', reply: 'Mon–Sat 9am–7pm. Sunday by appointment only.' },
    ],
  },
  {
    name: 'UrbanWear',
    businessMode: 'FASHION',
    adminPhone: '2207000004',
    description: 'Contemporary African fashion — clothing, accessories and footwear.',
    whatsapp: { phoneNumberId: 'SIM_FASH01', accessToken: null },
    menuItems: [
      { name: 'African Print Dress', price: 850, description: 'Bold Ankara fabric, fitted cut', available: true, variants: ['XS','S','M','L','XL'] },
      { name: 'Kaftan Set', price: 1200, description: 'Traditional two-piece kaftan', available: true, variants: ['S','M','L','XL','XXL'] },
      { name: 'Bucket Hat', price: 350, description: 'Embroidered cotton bucket hat', available: true },
      { name: 'Leather Sandals', price: 650, description: 'Hand-stitched Gambian leather', available: true, variants: ['36','37','38','39','40','41','42','43','44','45'] },
      { name: 'Beaded Bracelet', price: 200, description: 'Handmade West African beads', available: true },
    ],
    services: [],
    payment: { enabled: true, requireProof: true, wavePhone: '2207444444', currency: 'D', channels: [{ provider: 'Wave', accountNo: '2207444444', isDefault: true }] },
    faq: [
      { trigger: 'size guide,sizing,what size', reply: 'Our sizes run true to standard West African sizing. Unsure? Message us with your measurements 📏' },
      { trigger: 'delivery,shipping', reply: 'Local delivery within The Gambia: D50. Orders ready in 1–2 days 🚚' },
    ],
  },
  {
    name: 'GlowUp Beauty',
    businessMode: 'COSMETICS',
    adminPhone: '2207000005',
    description: 'Skincare, makeup and beauty products curated for African skin tones.',
    whatsapp: { phoneNumberId: 'SIM_COS01', accessToken: null },
    menuItems: [
      { name: 'Shea Butter Moisturiser', price: 350, description: 'Natural shea butter, all skin types', available: true },
      { name: 'Vitamin C Serum', price: 550, description: 'Brightening & anti-dark spot formula', available: true },
      { name: 'Matte Foundation', price: 750, description: '24hr wear, shades 30–70', available: true },
      { name: 'Black Castor Oil', price: 300, description: 'Hair growth & scalp treatment', available: true },
      { name: 'Lip Gloss Set', price: 450, description: '5-piece nude collection', available: true },
    ],
    services: [{ name: 'Beauty Consultation', duration: 30, available: true }],
    payment: { enabled: true, requireProof: true, wavePhone: '2207555555', currency: 'D', channels: [{ provider: 'Wave', accountNo: '2207555555', isDefault: true }] },
    leadCapture: { enabled: true, triggerOn: 'AFTER_ORDER', fields: ['name', 'email'] },
    faq: [
      { trigger: 'skin type,dry skin,oily skin', reply: 'For dry skin: Shea Butter Moisturiser + Vitamin C Serum. For oily: Matte Foundation + Vitamin C Serum 💄' },
      { trigger: 'return,exchange,refund', reply: 'Unopened products can be returned within 7 days with receipt 🛍' },
    ],
  },
  {
    name: 'TechHub Electronics',
    businessMode: 'ELECTRONICS',
    adminPhone: '2207000006',
    description: 'Phones, laptops, accessories and tech repairs. Genuine products guaranteed.',
    whatsapp: { phoneNumberId: 'SIM_ELEC01', accessToken: null },
    menuItems: [
      { name: 'Samsung Galaxy A35', price: 12500, description: '6.6" AMOLED · 50MP · 5000mAh · 128GB', available: true },
      { name: 'Tecno Camon 30', price: 9800, description: '6.78" · 50MP AI Camera · 5000mAh · 256GB', available: true },
      { name: 'iPhone 13 (Refurb)', price: 22000, description: '6.1" OLED · 12MP · 3227mAh · 128GB', available: true },
      { name: 'HP 255 G10 Laptop', price: 35000, description: '15.6" · Ryzen 5 · 8GB RAM · 512GB SSD', available: true },
      { name: 'USB-C Fast Charger 65W', price: 1200, description: 'GaN technology, universal compatibility', available: true },
      { name: 'Wireless Earbuds Pro', price: 2500, description: 'ANC · 30hr battery · IPX5 waterproof', available: true },
    ],
    services: [],
    payment: { enabled: true, requireProof: true, wavePhone: '2207666666', currency: 'D', channels: [{ provider: 'Wave', accountNo: '2207666666', isDefault: true }] },
    faq: [
      { trigger: 'warranty,guarantee', reply: 'All phones: 6-month warranty. Laptops: 12-month. Accessories: 3-month ✅' },
      { trigger: 'delivery,shipping', reply: 'Same-day delivery in Greater Banjul Area for orders before 2pm 🚀' },
      { trigger: 'repair,fix,screen', reply: 'We repair most phone brands! Screen, battery, charging port. Contact us for a quote 🔧' },
    ],
  },
];

async function seed() {
  await connectToDB();
  console.log('\n🌱 WhatSalesAgent2 — Seeding demo businesses...\n');

  let created = 0;
  for (const biz of BUSINESSES) {
    try {
      // Check if already seeded (by phoneNumberId)
      const exists = await Tenant.findOne({ 'whatsapp.phoneNumberId': biz.whatsapp.phoneNumberId });
      if (exists) {
        console.log(`  ⏭  ${biz.name} — already seeded`);
        continue;
      }

      // [FIX-SEED-1] Do not pass a raw apiKey — the Tenant pre-validate hook now
      // generates apiKeyHash automatically. Passing apiKey directly bypasses the
      // hash and stores plaintext in the DB (the exact issue FIX-RAWKEY fixed).
      // [FIX-SEED-2] status:'ACTIVE' bypasses the onboarding gate. For dev/sim
      // seeds we force onboardingStep:4 so the activation guard lets messages through.
      const tenant = await Tenant.create({
        name: biz.name, adminPhone: biz.adminPhone, status: 'ACTIVE',
        whatsapp: biz.whatsapp, onboardingStep: 4,
      });
      // The plaintext key is available once via the pre-validate hook transient property.
      const apiKey = tenant._plaintextApiKey || '(see DB — key generated by hook)';

      await BusinessConfig.create({
        tenantId:    String(tenant._id),
        name:        biz.name,
        businessMode: biz.businessMode,
        adminPhone:  biz.adminPhone,
        description: biz.description,
        menuItems:   biz.menuItems,
        services:    biz.services,
        staff:       biz.staff || [],
        hours:       biz.hours || {},
        payment:     biz.payment,
        addOns:      biz.addOns || [],
        faq:         biz.faq || [],
        leadCapture: biz.leadCapture || {},
      });

      console.log(`  ✅  ${biz.name} (${biz.businessMode})`);
      console.log(`      TenantId:  ${tenant._id}`);
      console.log(`      SimPhone:  ${biz.whatsapp.phoneNumberId}`);
      console.log(`      API Key:   ${apiKey}\n`);
      created++;
    } catch (err) {
      console.error(`  ❌  ${biz.name}: ${err.message}`);
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${created} business(es) seeded`);
  console.log('');
  console.log('  Start in simulation mode:');
  console.log('  npm run dev:sim');
  console.log('');
  console.log('  Test with PowerShell:');
  console.log('  Invoke-RestMethod -Method Post http://localhost:5000/api/message \\');
  console.log('    -ContentType "application/json" \\');
  console.log('    -Body \'{"userId":"test001","message":"Hi"}\'');
  console.log('');
  console.log('  Test with curl:');
  console.log('  curl -X POST http://localhost:5000/api/message -H "Content-Type: application/json" -d "{\\"userId\\":\\"test001\\",\\"message\\":\\"Hi\\"}"');
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  await mongoose.disconnect();
}

seed().catch(err => { console.error(err); process.exit(1); });
