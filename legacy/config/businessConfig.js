'use strict';

/**
 * Business Configuration — DreamLine Restaurant01
 * Edit this file to customize for any business type.
 */

module.exports = {
  // ─── Business Identity ──────────────────────────────────────────────────────
  name: 'DreamLine Restaurant',
  tagline: 'Authentic Gambian Cuisine',
  type: 'restaurant', // restaurant | pharmacy | supermarket | electronics | fashion | corporate
  currency: 'GMD',
  currencySymbol: 'D',
  timezone: 'Africa/Banjul',

  // ─── Operating Hours ────────────────────────────────────────────────────────
  hours: {
    open: '08:00',
    close: '21:00',
    days: 'Monday – Sunday',
    closedMessage: 'We\'re currently closed. We open at 8:00 AM daily. Feel free to browse our menu!',
  },

  // ─── Contact ────────────────────────────────────────────────────────────────
  contact: {
    phone: process.env.BUSINESS_PHONE || '',
    email: process.env.BUSINESS_EMAIL || '',
    address: process.env.BUSINESS_ADDRESS || 'Banjul, The Gambia',
    adminWhatsApp: process.env.ADMIN_WHATSAPP || '',
  },

  // ─── Delivery Settings ──────────────────────────────────────────────────────
  delivery: {
    enabled: true,
    fee: 50,           // GMD
    freeAbove: 500,    // Free delivery for orders above this amount
    estimatedMinutes: 45,
    zones: ['Banjul', 'Bakau', 'Serrekunda', 'Fajara', 'Kololi', 'Kotu'],
  },

  // ─── Payment Methods ─────────────────────────────────────────────────────────
  payment: {
    methods: [
      { id: 'wave', name: 'Wave Money', number: process.env.WAVE_NUMBER || '', instructions: 'Send to Wave number: *{number}*\nReference: *{orderId}*' },
      { id: 'afrimoney', name: 'AfriMoney', number: process.env.AFRIMONEY_NUMBER || '', instructions: 'Send to AfriMoney: *{number}*\nReference: *{orderId}*' },
      { id: 'cash', name: 'Cash on Delivery', instructions: 'Pay in cash when your order arrives.' },
    ],
    proofRequired: true,
    verificationTimeMinutes: 15,
  },

  // ─── Personality ─────────────────────────────────────────────────────────────
  // Controls tone of all AI-generated responses
  personality: {
    warmth: 'high',      // high | medium | low
    formality: 'semi',   // formal | semi | casual
    emoji: true,
    language: 'en',
  },

  // ─── Welcome Message ─────────────────────────────────────────────────────────
  // NOTE: NO instruction to "type Order" — buttons handle that
  welcome: {
    text: `Welcome to *DreamLine Restaurant* 🍽️\n\nYour home for authentic Gambian cuisine! We're open *8:00 AM – 9:00 PM* daily.\n\nHow can we help you today?`,
    buttons: [
      { id: 'action_order',   title: '🛒 Order Food' },
      { id: 'action_book',    title: '📅 Book a Table' },
      { id: 'action_help',    title: '❓ Ask a Question' },
    ],
  },

  // ─── Menu Categories ──────────────────────────────────────────────────────────
  categories: [
    { id: 'mains',    name: 'Main Dishes',   emoji: '🍛' },
    { id: 'sides',    name: 'Sides & Extras', emoji: '🥗' },
    { id: 'drinks',   name: 'Drinks',         emoji: '🥤' },
    { id: 'desserts', name: 'Desserts',        emoji: '🍰' },
  ],

  // ─── Menu Items ──────────────────────────────────────────────────────────────
  menu: [
    // MAINS
    {
      id: 'domoda_beef',
      name: 'Domoda (Beef)',
      category: 'mains',
      price: 175,
      description: 'Rich peanut butter stew with tender beef, served with rice',
      keywords: ['domoda', 'beef', 'dom', 'peanut stew', 'groundnut stew'],
      available: true,
      popular: true,
      addons: [{ id: 'extra_rice', name: 'Extra Rice', price: 25 }],
    },
    {
      id: 'domoda_chicken',
      name: 'Domoda (Chicken)',
      category: 'mains',
      price: 165,
      description: 'Rich peanut butter stew with chicken, served with rice',
      keywords: ['domoda', 'chicken', 'dom chicken', 'peanut chicken'],
      available: true,
      popular: true,
      addons: [{ id: 'extra_rice', name: 'Extra Rice', price: 25 }],
    },
    {
      id: 'benachin_beef',
      name: 'Benachin (Beef)',
      category: 'mains',
      price: 165,
      description: 'One-pot Gambian jollof rice with beef',
      keywords: ['benachin', 'jollof', 'jollof rice', 'bena', 'rice dish'],
      available: true,
    },
    {
      id: 'benachin_fish',
      name: 'Benachin (Fish)',
      category: 'mains',
      price: 155,
      description: 'One-pot Gambian jollof rice with fresh fish',
      keywords: ['benachin', 'jollof fish', 'fish rice', 'that fish'],
      available: true,
    },
    {
      id: 'superkanja',
      name: 'Super Kanja',
      category: 'mains',
      price: 170,
      description: 'Traditional okra soup with fish and smoked oysters',
      keywords: ['kanja', 'okra', 'superkanja', 'okra soup', 'super'],
      available: true,
    },
    {
      id: 'yassa_chicken',
      name: 'Yassa Chicken',
      category: 'mains',
      price: 175,
      description: 'Marinated chicken in lemon-onion sauce',
      keywords: ['yassa', 'chicken yassa', 'lemon chicken'],
      available: true,
      popular: true,
    },
    // SIDES
    {
      id: 'plain_rice',
      name: 'Plain Rice',
      category: 'sides',
      price: 30,
      description: 'Steamed white rice',
      keywords: ['rice', 'plain rice', 'white rice'],
      available: true,
    },
    {
      id: 'plantain',
      name: 'Fried Plantain',
      category: 'sides',
      price: 40,
      description: 'Sweet golden fried plantain',
      keywords: ['plantain', 'banana', 'fried plantain'],
      available: true,
    },
    {
      id: 'salad',
      name: 'Fresh Salad',
      category: 'sides',
      price: 45,
      description: 'Garden salad with tomatoes, cucumber, and dressing',
      keywords: ['salad', 'fresh salad', 'vegetables'],
      available: true,
    },
    // DRINKS
    {
      id: 'wonjo_juice',
      name: 'Wonjo Juice',
      category: 'drinks',
      price: 35,
      description: 'Refreshing hibiscus drink',
      keywords: ['wonjo', 'hibiscus', 'juice', 'drink', 'red drink'],
      available: true,
    },
    {
      id: 'ginger_beer',
      name: 'Ginger Beer',
      category: 'drinks',
      price: 35,
      description: 'Homemade spiced ginger beer',
      keywords: ['ginger', 'ginger beer', 'drink'],
      available: true,
    },
    {
      id: 'water',
      name: 'Bottled Water',
      category: 'drinks',
      price: 15,
      description: 'Chilled mineral water',
      keywords: ['water', 'bottle water', 'mineral water'],
      available: true,
    },
    // DESSERTS
    {
      id: 'sansanding',
      name: 'Sansanding',
      category: 'desserts',
      price: 60,
      description: 'Traditional Gambian sweet rice porridge with milk',
      keywords: ['sansanding', 'porridge', 'dessert', 'sweet'],
      available: true,
    },
  ],

  // ─── Upsell Pairings ─────────────────────────────────────────────────────────
  // When a customer orders item A, suggest item B
  upsells: {
    domoda_beef:     ['wonjo_juice', 'plantain'],
    domoda_chicken:  ['wonjo_juice', 'plantain'],
    benachin_beef:   ['ginger_beer', 'salad'],
    benachin_fish:   ['wonjo_juice', 'salad'],
    yassa_chicken:   ['ginger_beer', 'plantain'],
    superkanja:      ['wonjo_juice', 'plain_rice'],
  },

  // ─── Table Booking ────────────────────────────────────────────────────────────
  booking: {
    enabled: true,
    minPartySize: 1,
    maxPartySize: 30,
    advanceBookingHours: 1,
    confirmationMessage: 'Your table has been reserved! We look forward to welcoming you. 😊',
  },
};
