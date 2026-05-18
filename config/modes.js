/**
 * config/modes.js — Dreamline Sales Bot v11.0 (Merged)
 *
 * 10 INDUSTRY MODES — each a complete pre-packaged config bundle.
 * Every mode is sellable out of the box with zero code changes.
 *
 * Core modes (v11 — fully featured with personalisation, tracking, upsell):
 *   RESTAURANT  — dine-in orders + table booking + FAQ
 *   SALON       — appointment booking + FAQ
 *   RETAIL      — generic product orders + FAQ
 *
 * Extended modes (from v10, upgraded with v11 labels where applicable):
 *   BAKERY      — pre-orders + daily specials + collection time
 *   SUPERMARKET — product orders + delivery/pickup
 *   FASHION     — browse catalogue + size guide + order
 *   COSMETICS   — product orders + beauty advice + upsell
 *   ELECTRONICS — product enquiry + orders + warranty info
 *   PHARMACY    — OTC orders + health Q&A + prescription handling
 *   DELIVERY    — delivery order + tracking + scheduling
 *
 * v11 UPGRADES (applied to all 10 modes):
 * - All modes get expanded addOns lists
 * - New labels: trackOrderMsg, repeatOrderMsg, nameReceivedMsg, welcomePersonalised
 * - Personalised welcome: welcomePersonalised label
 * - Improved bookingSuccess messages: include service for RESTAURANT
 * - Better cancelMsg: context-aware redirect
 * - SHOW_MENU button added to fallbackButtons for all modes
 * - smartRecommendations config preserved from v10 for extended modes
 */

export const MODES = {

  // ─────────────────────────────────────────────────────────────────────────
  // RESTAURANT — order food + book a table + FAQ
  // ─────────────────────────────────────────────────────────────────────────
  RESTAURANT: {
    flows: ['ORDER', 'BOOKING', 'INQUIRY'],

    salesPersona: 'friendly restaurant host who knows every dish and loves upselling sides and drinks',

    intentMap: {
      ORDER:   'START_ORDER',
      BOOKING: 'START_BOOKING',
      INQUIRY: 'ABOUT',
      UNKNOWN: 'FALLBACK',
    },

    tone: { style: 'FRIENDLY', industry: 'RESTAURANT' },

    addOns: [
      { name: 'Soft Drink',       price: 50  },
      { name: 'Bottled Water',    price: 30  },
      { name: 'Extra Sauce',      price: 25  },
      { name: 'Dessert',          price: 75  },
      { name: 'Extra Portion',    price: 60  },
    ],

    smartRecommendations: {
      enabled: true,
      trigger: 'AFTER_ITEM_SELECT',
      prompt: 'Based on the item selected, suggest ONE popular complementary item from the menu as a casual recommendation.',
    },

    labels: {
      welcome:              '👋 Welcome! What would you like to do today?',
      welcomePersonalised:  (name) => `👋 Welcome back, *${name}*! Great to have you. What would you like today?`,
      nameReceivedMsg:      (name) => `Nice to meet you, *${name}*! 😊 How can I help you today?`,
      orderBtn:             '🍔 Order Food',
      bookBtn:              '📅 Book a Table',
      orderPrompt:          "Here's our menu — choose an item:",
      bookPrompt:           'What date would you like to book? 📅',
      servicePrompt:        'Please choose a table type or service:',
      timePrompt:           'What time works for you? ⏰',

      confirmOrder: (item, qty, price) =>
        `🧾 *Order Summary*\n\n🍽️ *${item}* × ${qty}` +
        (price ? `\n💰 Total: *D${price}*` : ''),

      confirmBooking: (serviceOrDate, dateOrTime, timeOrUndefined) => {
        const hasService = timeOrUndefined !== undefined;
        const service = hasService ? serviceOrDate : null;
        const date    = hasService ? dateOrTime    : serviceOrDate;
        const time    = hasService ? timeOrUndefined : dateOrTime;
        return (
          `📋 *Booking Summary*\n\n` +
          (service ? `🍽️ *${service}*\n` : '') +
          `📅 *${date}*` +
          (time ? `\n⏰ *${time}*` : '')
        );
      },

      orderSuccess: (item, qty) =>
        `✅ *Order placed!*\n\n🍳 *${qty}× ${item}* — we're preparing it now.\n\nThank you! 😊\n\nType *0* to return to main menu.`,

      bookingSuccess: (date, time, service) =>
        `✅ *Booking confirmed!*\n\n` +
        (service ? `🍽️ *${service}*\n` : '') +
        `📅 *${date}*` +
        (time ? `\n⏰ *${time}*` : '') +
        '\n\nWe look forward to seeing you! 😊\n\nType *0* to return to main menu.',

      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\n` +
        `Total: *D${amount}*\n` +
        `Send via *Wave* to: *${wavePhone}*\n\n` +
        `After paying, send your *screenshot* here to complete your order.`,

      paymentProofReceived:
        `✅ *Payment proof received.*\n\n⏳ We're verifying your payment — this usually takes a few minutes.\n\nWe'll notify you once confirmed!`,

      paymentConfirmed:
        `✅ *Payment confirmed!*\n\nYour order is now being processed. Thank you! 🙏\n\nType *0* to return to menu.`,

      paymentRejected:
        `❌ *Payment could not be verified.*\n\nPlease check the amount and Wave number, then try again.\n\nType *Order* to start a new order, or contact us directly.`,

      cancelMsg:    '✅ No problem! Type *Order* to order food, *Book* to reserve a table, or *Question* to ask us anything.',

      trackOrderMsg: (adminPhone) =>
        `📦 *Order Tracking*\n\n` +
        `To get a real-time update on your order, please contact us directly.\n\n` +
        (adminPhone ? `📞 *${adminPhone}*` : 'Please call the restaurant directly.'),

      repeatOrderMsg: (lastItem) =>
        lastItem
          ? `🔄 *Repeat Order*\n\nWould you like to order *${lastItem}* again?\n\nTap *Order* to start and select your item.`
          : `🔄 Tap *Order* to place a new order from our menu!`,

      fallback:     "What would you like to do — *order*, *book*, or ask a *question*?",
      loopFallback: "Let me help you get started:",

      upsellPrompt: (addOnName, addOnPrice) =>
        `Would you like to add a *${addOnName}* for D${addOnPrice}? 🥤`,
    },

    ui: {
      welcomeButtons: [
        { id: 'ORDER',    title: '🍔 Order Food' },
        { id: 'BOOK',     title: '📅 Book a Table' },
        { id: 'QUESTION', title: '❓ Ask a Question' },
      ],
      confirmButtons: [
        { id: 'CONFIRM', title: '✅ Confirm' },
        { id: 'CANCEL',  title: '❌ Cancel' },
      ],
      switchButtons: [
        { id: 'SWITCH_YES', title: '✅ Yes, switch' },
        { id: 'SWITCH_NO',  title: '❌ No, continue' },
      ],
      fallbackButtons: [
        { id: 'ORDER',    title: '🍔 Order' },
        { id: 'BOOK',     title: '📅 Book' },
        { id: 'QUESTION', title: '❓ Question' },
      ],
      upsellButtons: [
        { id: 'UPSELL_YES', title: '✅ Yes, add it' },
        { id: 'UPSELL_NO',  title: '❌ No thanks' },
      ],
    },

    orderSteps:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    bookingSteps: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SALON — appointment booking + FAQ
  // ─────────────────────────────────────────────────────────────────────────
  SALON: {
    flows: ['BOOKING', 'INQUIRY'],

    salesPersona: 'professional, welcoming salon receptionist who helps clients book appointments and answers questions about services',

    intentMap: {
      BOOKING: 'START_BOOKING',
      INQUIRY: 'ABOUT',
      UNKNOWN: 'FALLBACK',
    },

    tone: { style: 'PROFESSIONAL', industry: 'SALON' },

    addOns: [
      { name: 'Deep Conditioning Treatment', price: 100 },
      { name: 'Scalp Massage',               price: 75  },
      { name: 'Eyebrow Shaping',             price: 50  },
    ],

    smartRecommendations: {
      enabled: false,
      trigger: null,
      prompt:  null,
    },

    labels: {
      welcome:              '👋 Welcome! How can we help you today?',
      welcomePersonalised:  (name) => `👋 Hello, *${name}*! Great to hear from you. How can we help? 💅`,
      nameReceivedMsg:      (name) => `Lovely to meet you, *${name}*! 😊 How can I help you today?`,
      bookBtn:              '💇 Book Appointment',
      contactBtn:           '📞 Contact Us',
      orderPrompt:          null,
      bookPrompt:           'Which service would you like to book?',
      servicePrompt:        'Please choose a service:',
      timePrompt:           'What time works best for you? ⏰',

      confirmBooking: (service, date, time) =>
        `📋 *Appointment Summary*\n\n💅 *${service}*\n📅 *${date}*` +
        (time ? `\n⏰ *${time}*` : ''),

      bookingSuccess: (date, time, service) =>
        `✅ *Appointment confirmed!*\n\n` +
        (service ? `💅 *${service}*\n` : '') +
        `📅 *${date}*` +
        (time ? `\n⏰ *${time}*` : '') +
        '\n\nSee you then! ✨\n\nType *0* to return to menu.',

      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\nTotal: *D${amount}*\nWave to: *${wavePhone}*\n\nSend your screenshot here after paying.`,

      paymentProofReceived:
        `✅ *Screenshot received.*\n\n⏳ We're verifying your payment — we'll confirm shortly.`,

      paymentConfirmed:
        `✅ *Payment confirmed!* Your appointment is booked. See you soon! 💇\n\nType *0* to return to menu.`,

      paymentRejected:
        `❌ *Payment could not be verified.*\n\nPlease check the amount and try again, or contact us directly.`,

      cancelMsg:    '✅ No problem! Type *Book* whenever you\'re ready, or *Question* to ask us anything.',

      trackOrderMsg: (adminPhone) =>
        `📅 *Appointment Status*\n\n` +
        `For updates on your appointment, please contact us directly.\n\n` +
        (adminPhone ? `📞 *${adminPhone}*` : 'Please call us directly.'),

      repeatOrderMsg: (lastService) =>
        lastService
          ? `🔄 Would you like to book *${lastService}* again?\n\nTap *Book* to schedule your next appointment.`
          : `🔄 Tap *Book* to schedule your next appointment!`,

      fallback:     'Would you like to *book an appointment* or ask a *question*?',
      loopFallback: 'Let me help you schedule your appointment:',

      upsellPrompt: (addOnName, addOnPrice) =>
        `Would you like to add *${addOnName}* to your appointment for D${addOnPrice}? ✨`,
    },

    ui: {
      welcomeButtons: [
        { id: 'BOOK',     title: '💇 Book Appointment' },
        { id: 'QUESTION', title: '❓ Ask a Question' },
      ],
      confirmButtons: [
        { id: 'CONFIRM', title: '✅ Confirm' },
        { id: 'CANCEL',  title: '❌ Cancel' },
      ],
      switchButtons: [
        { id: 'SWITCH_YES', title: '✅ Yes, switch' },
        { id: 'SWITCH_NO',  title: '❌ No, continue' },
      ],
      fallbackButtons: [
        { id: 'BOOK',     title: '💇 Book Appointment' },
        { id: 'QUESTION', title: '❓ Question' },
      ],
      upsellButtons: [
        { id: 'UPSELL_YES', title: '✅ Yes, add it' },
        { id: 'UPSELL_NO',  title: '❌ No thanks' },
      ],
    },

    orderSteps:   [],
    bookingSteps: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // RETAIL — browse & order products + FAQ
  // ─────────────────────────────────────────────────────────────────────────
  RETAIL: {
    flows: ['ORDER', 'INQUIRY'],

    salesPersona: 'helpful, professional retail assistant who helps customers find and order products',

    intentMap: {
      ORDER:   'START_ORDER',
      INQUIRY: 'ABOUT',
      UNKNOWN: 'FALLBACK',
    },

    tone: { style: 'PROFESSIONAL', industry: 'RETAIL' },

    addOns: [
      { name: 'Gift Wrapping',        price: 30 },
      { name: 'Express Delivery',     price: 50 },
      { name: 'Protective Case',      price: 80 },
      { name: 'Extended Warranty',    price: 100 },
    ],

    smartRecommendations: {
      enabled: false,
      trigger: null,
      prompt:  null,
    },

    labels: {
      welcome:              '👋 Welcome! What would you like to do?',
      welcomePersonalised:  (name) => `👋 Welcome back, *${name}*! Great to see you. What can we help you with today? 🛍️`,
      nameReceivedMsg:      (name) => `Nice to meet you, *${name}*! 😊 How can I help you today?`,
      orderBtn:             '🛍️ View Products',
      orderPrompt:          'Here are our products — choose one:',
      bookPrompt:           null,
      servicePrompt:        null,
      timePrompt:           null,

      confirmOrder: (item, qty, price) =>
        `🧾 *Order Summary*\n\n📦 *${item}* × ${qty}` +
        (price ? `\n💰 Total: *D${price}*` : ''),

      orderSuccess: (item, qty) =>
        `✅ *Order received!*\n\n📦 *${qty}× ${item}*\n\nWe'll process your order shortly. Thank you! 🙏\n\nType *0* to return to menu.`,

      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\nTotal: *D${amount}*\nWave to: *${wavePhone}*\n\nSend your payment screenshot here.`,

      paymentProofReceived:
        `✅ *Payment proof received.*\n\n⏳ We're verifying — this usually takes a few minutes.`,

      paymentConfirmed:
        `✅ *Payment confirmed!* Your order is being processed. Thank you!\n\nType *0* to return to menu.`,

      paymentRejected:
        `❌ *Payment could not be verified.*\n\nPlease check the amount and try again.\nType *Order* to start a new order.`,

      cancelMsg:    '✅ No problem! Type *Order* to shop again, or *Question* to ask us anything.',

      trackOrderMsg: (adminPhone) =>
        `📦 *Order Tracking*\n\n` +
        `For your order status, please contact us directly.\n\n` +
        (adminPhone ? `📞 *${adminPhone}*` : 'Please contact the store directly.'),

      repeatOrderMsg: (lastItem) =>
        lastItem
          ? `🔄 Would you like to order *${lastItem}* again?\n\nTap *Order* and select your item to proceed.`
          : `🔄 Tap *Order* to browse our products and place a new order!`,

      fallback:     "Would you like to *view our products* or ask a *question*?",
      loopFallback: 'Let me show you what we have:',

      upsellPrompt: (addOnName, addOnPrice) =>
        `Would you like to add *${addOnName}* for D${addOnPrice}? 🎁`,
    },

    ui: {
      welcomeButtons: [
        { id: 'ORDER',    title: '🛍️ View Products' },
        { id: 'QUESTION', title: '❓ Ask a Question' },
      ],
      confirmButtons: [
        { id: 'CONFIRM', title: '✅ Confirm Order' },
        { id: 'CANCEL',  title: '❌ Cancel' },
      ],
      switchButtons: [
        { id: 'SWITCH_YES', title: '✅ Yes, switch' },
        { id: 'SWITCH_NO',  title: '❌ No, continue' },
      ],
      fallbackButtons: [
        { id: 'ORDER',    title: '🛍️ View Products' },
        { id: 'QUESTION', title: '❓ Question' },
      ],
      upsellButtons: [
        { id: 'UPSELL_YES', title: '✅ Yes, add it' },
        { id: 'UPSELL_NO',  title: '❌ No thanks' },
      ],
    },

    orderSteps:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    bookingSteps: [],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // BAKERY — pre-orders + daily specials + collection time
  // ─────────────────────────────────────────────────────────────────────────
  BAKERY: {
    flows: ['ORDER', 'BOOKING', 'INQUIRY'],
    salesPersona: 'warm bakery assistant who loves talking about freshly baked goods, suggests add-ons, and reminds customers about daily specials',
    intentMap: { ORDER: 'START_ORDER', BOOKING: 'START_BOOKING', INQUIRY: 'ABOUT', UNKNOWN: 'FALLBACK' },
    tone: { style: 'FRIENDLY', industry: 'RETAIL' },
    addOns: [
      { name: 'Box of Cookies', price: 60 },
      { name: 'Hot Chocolate',  price: 45 },
      { name: 'Gift Wrapping',  price: 30 },
      { name: 'Extra Icing',    price: 20 },
    ],
    smartRecommendations: {
      enabled: true,
      trigger: 'AFTER_ITEM_SELECT',
      prompt: 'Suggest ONE complementary baked item (e.g. a drink, a treat to go with it) in a warm, bakery-style tone.',
    },
    labels: {
      welcome:              '🥐 Welcome! Fresh baked just for you. What can we get you?',
      welcomePersonalised:  (name) => `🥐 Welcome back, *${name}*! Great to have you. What would you like today?`,
      nameReceivedMsg:      (name) => `Nice to meet you, *${name}*! 😊 What can I get you today?`,
      orderBtn:             '🧁 Order Now',
      bookBtn:              '📅 Schedule Collection',
      orderPrompt:          "🎂 Here's what's fresh today — choose your item:",
      servicePrompt:        'What would you like to schedule?',
      bookPrompt:           'What date would you like to collect? 📅',
      timePrompt:           'What time would you like to collect? ⏰',
      confirmOrder: (item, qty, price) =>
        `🧾 *Order Summary*\n\n🧁 *${item}* × ${qty}` +
        (price ? `\n💰 Total: *D${price}*` : '') +
        '\n\n📦 We\'ll prepare it fresh for you.',
      confirmBooking: (serviceOrDate, dateOrTime, timeOrUndefined) => {
        const hasService = timeOrUndefined !== undefined;
        const service = hasService ? serviceOrDate : null;
        const date    = hasService ? dateOrTime    : serviceOrDate;
        const time    = hasService ? timeOrUndefined : dateOrTime;
        return `📋 *Collection Summary*\n\n` +
          (service ? `🧁 *${service}*\n` : '') +
          `📅 *${date}*` + (time ? `\n⏰ *${time}*` : '');
      },
      orderSuccess: (item, qty) =>
        `✅ *Order placed!*\n\n🎂 *${qty}× ${item}* — baking with love!\n\nWe'll message you when it's ready. 🥐\n\nType *0* to return to menu.`,
      bookingSuccess: (date, time, service) =>
        `✅ *Collection scheduled!*\n\n` +
        (service ? `🧁 *${service}*\n` : '') +
        `📅 *${date}*` +
        (time ? `\n⏰ *${time}*` : '') +
        '\n\nFreshly baked and ready for you! 🎂\n\nType *0* to return to menu.',
      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\nTotal: *D${amount}*\nWave to: *${wavePhone}*\n\nSend your screenshot here to confirm. 📸`,
      paymentProofReceived: `✅ *Screenshot received!* We're confirming your payment — just a moment. ☕`,
      paymentConfirmed:     `✅ *Payment confirmed!* Your order is being prepared with love. 🎂`,
      paymentRejected:      `❌ *Payment not verified.* Please double-check and resend, or type *Order* to restart.`,
      cancelMsg:    '✅ Cancelled! Come back any time — we bake fresh daily 🥐',
      trackOrderMsg: (adminPhone) =>
        `📦 *Order Status*\n\nFor updates on your order, contact us directly.\n\n` +
        (adminPhone ? `📞 *${adminPhone}*` : 'Please call us directly.'),
      repeatOrderMsg: (lastItem) =>
        lastItem
          ? `🔄 Would you like to order *${lastItem}* again?\n\nTap *Order* to get started!`
          : `🔄 Tap *Order* to browse what's fresh today!`,
      fallback:     'Would you like to *order* something, *schedule a collection*, or do you have a *question*?',
      loopFallback: "Here's what I can help you with:",
      upsellPrompt: (name, price) => `Would you also like *${name}* for D${price}? 🍪`,
    },
    ui: {
      welcomeButtons:  [{ id: 'ORDER', title: '🧁 Place an Order' }, { id: 'BOOK', title: '📅 Schedule Collection' }, { id: 'QUESTION', title: '❓ Ask a Question' }],
      confirmButtons:  [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
      switchButtons:   [{ id: 'SWITCH_YES', title: '✅ Yes, switch' }, { id: 'SWITCH_NO', title: '❌ No, continue' }],
      fallbackButtons: [{ id: 'ORDER', title: '🧁 Order' }, { id: 'BOOK', title: '📅 Collect' }, { id: 'QUESTION', title: '❓ Question' }],
      upsellButtons:   [{ id: 'UPSELL_YES', title: '✅ Add it' }, { id: 'UPSELL_NO', title: '❌ No thanks' }],
    },
    orderSteps:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    bookingSteps: ['DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SUPERMARKET — product orders + delivery/pickup
  // ─────────────────────────────────────────────────────────────────────────
  SUPERMARKET: {
    flows: ['ORDER', 'INQUIRY'],
    salesPersona: 'helpful supermarket assistant who helps customers find products, check availability, and place orders for delivery or pickup',
    intentMap: { ORDER: 'START_ORDER', INQUIRY: 'ABOUT', UNKNOWN: 'FALLBACK' },
    tone: { style: 'PROFESSIONAL', industry: 'RETAIL' },
    addOns: [
      { name: 'Reusable Bag',     price: 15 },
      { name: 'Express Delivery', price: 50 },
    ],
    smartRecommendations: {
      enabled: true,
      trigger: 'AFTER_ITEM_SELECT',
      prompt: 'Suggest ONE related everyday product the customer might have forgotten, in a helpful grocery-assistant tone.',
    },
    labels: {
      welcome:              '🛒 Welcome! Shop from home — what do you need today?',
      welcomePersonalised:  (name) => `🛒 Welcome back, *${name}*! Great to see you. What do you need today?`,
      nameReceivedMsg:      (name) => `Nice to meet you, *${name}*! 😊 What can I help you find?`,
      orderBtn:             '🛒 Shop Now',
      orderPrompt:          "📦 Here's our product list — choose an item to order:",
      servicePrompt:        null,
      bookPrompt:           null,
      timePrompt:           null,
      confirmOrder: (item, qty, price) =>
        `🧾 *Order Summary*\n\n🛒 *${item}* × ${qty}` +
        (price ? `\n💰 Total: *D${price}*` : '') +
        "\n\n🚚 Delivery or pickup? Reply *Deliver* or *Pickup*.",
      orderSuccess: (item, qty) =>
        `✅ *Order received!*\n\n📦 *${qty}× ${item}*\n\nWe'll confirm delivery details shortly. Thank you! 🛒\n\nType *0* to return to menu.`,
      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\nTotal: *D${amount}*\nWave to: *${wavePhone}*\n\nSend your payment screenshot to confirm. 📸`,
      paymentProofReceived: `✅ *Screenshot received!* We're verifying your payment now.`,
      paymentConfirmed:     `✅ *Paid!* Your order is being packed. Delivery/pickup details coming shortly. 🛒`,
      paymentRejected:      `❌ *Payment not verified.* Please resend or type *Order* to try again.`,
      cancelMsg:    '✅ Order cancelled. Type *Order* to shop again anytime. 🛒',
      trackOrderMsg: (adminPhone) =>
        `📦 *Order Tracking*\n\nFor delivery updates, contact us directly.\n\n` +
        (adminPhone ? `📞 *${adminPhone}*` : 'Please call us directly.'),
      repeatOrderMsg: (lastItem) =>
        lastItem
          ? `🔄 Would you like to order *${lastItem}* again?\n\nTap *Order* to get started!`
          : `🔄 Tap *Order* to browse our products!`,
      fallback:     'Would you like to *shop*, or do you have a *question* about a product?',
      loopFallback: 'Let me help you find what you need:',
      upsellPrompt: (name, price) => `Would you also like *${name}* for D${price}? 🛍️`,
    },
    ui: {
      welcomeButtons:  [{ id: 'ORDER', title: '🛒 Shop Now' }, { id: 'QUESTION', title: '❓ Product Info' }],
      confirmButtons:  [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
      switchButtons:   [{ id: 'SWITCH_YES', title: '✅ Yes, switch' }, { id: 'SWITCH_NO', title: '❌ No, continue' }],
      fallbackButtons: [{ id: 'ORDER', title: '🛒 Shop' }, { id: 'QUESTION', title: '❓ Question' }],
      upsellButtons:   [{ id: 'UPSELL_YES', title: '✅ Add it' }, { id: 'UPSELL_NO', title: '❌ No thanks' }],
    },
    orderSteps:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    bookingSteps: [],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // FASHION — browse catalogue + size guide + order
  // ─────────────────────────────────────────────────────────────────────────
  FASHION: {
    flows: ['ORDER', 'INQUIRY'],
    salesPersona: 'stylish fashion consultant who helps customers find their perfect fit, suggests matching pieces, and drives conversions with confidence',
    intentMap: { ORDER: 'START_ORDER', INQUIRY: 'ABOUT', UNKNOWN: 'FALLBACK' },
    tone: { style: 'PREMIUM', industry: 'RETAIL' },
    addOns: [
      { name: 'Gift Box Packaging', price: 35 },
      { name: 'Express Delivery',   price: 75 },
      { name: 'Style Consultation', price: 0  },
    ],
    smartRecommendations: {
      enabled: true,
      trigger: 'AFTER_ITEM_SELECT',
      prompt: 'Suggest ONE matching accessory or complementary clothing piece in a stylish, confident fashion-consultant tone. Keep it short and aspirational.',
    },
    labels: {
      welcome:              "✨ Welcome! Let's find something perfect for you. What are you looking for?",
      welcomePersonalised:  (name) => `✨ Welcome back, *${name}*! Great to have you. What are we styling today?`,
      nameReceivedMsg:      (name) => `Lovely to meet you, *${name}*! 😊 Let's find you something special.`,
      orderBtn:             '👗 Shop Collection',
      orderPrompt:          '👗 Our latest collection — choose an item:',
      servicePrompt:        null,
      bookPrompt:           null,
      timePrompt:           null,
      confirmOrder: (item, qty, price) =>
        `🧾 *Your Order*\n\n👗 *${item}* × ${qty}` +
        (price ? `\n💰 Total: *D${price}*` : '') +
        '\n\n📦 We\'ll contact you about sizing and delivery details.',
      orderSuccess: (item, qty) =>
        `✅ *Order confirmed!*\n\n👗 *${qty}× ${item}*\n\nWe'll prepare your item and reach out with delivery details. Thank you! ✨\n\nType *0* to return to menu.`,
      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\nTotal: *D${amount}*\nWave to: *${wavePhone}*\n\nSend your payment screenshot here. 📸`,
      paymentProofReceived: `✅ *Screenshot received!* We're processing your payment now.`,
      paymentConfirmed:     `✅ *Payment confirmed!* Your order is being prepared. We'll be in touch soon. 👗`,
      paymentRejected:      `❌ *Payment not verified.* Please resend the correct amount, or type *Order* to restart.`,
      cancelMsg:    '✅ Cancelled. Browse our collection anytime — type *Shop* to continue. 👗',
      trackOrderMsg: (adminPhone) =>
        `📦 *Order Status*\n\nFor updates on your order, contact us directly.\n\n` +
        (adminPhone ? `📞 *${adminPhone}*` : 'Please call us directly.'),
      repeatOrderMsg: (lastItem) =>
        lastItem
          ? `🔄 Would you like to order *${lastItem}* again?\n\nTap *Shop* to get started!`
          : `🔄 Tap *Shop* to browse our latest collection!`,
      fallback:     'Would you like to *browse our collection*, or do you have a *style question*?',
      loopFallback: "Here's what I can help you with:",
      upsellPrompt: (name, price) => price > 0
        ? `Would you like to add *${name}* for D${price}? ✨`
        : `Would you like a *${name}*? It's complimentary! ✨`,
    },
    ui: {
      welcomeButtons:  [{ id: 'ORDER', title: '👗 Shop Collection' }, { id: 'QUESTION', title: '❓ Style Help' }],
      confirmButtons:  [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
      switchButtons:   [{ id: 'SWITCH_YES', title: '✅ Yes, switch' }, { id: 'SWITCH_NO', title: '❌ No, continue' }],
      fallbackButtons: [{ id: 'ORDER', title: '👗 Shop' }, { id: 'QUESTION', title: '❓ Question' }],
      upsellButtons:   [{ id: 'UPSELL_YES', title: '✅ Yes please' }, { id: 'UPSELL_NO', title: '❌ No thanks' }],
    },
    orderSteps:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    bookingSteps: [],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // COSMETICS — product orders + beauty advice + upsell
  // ─────────────────────────────────────────────────────────────────────────
  COSMETICS: {
    flows: ['ORDER', 'BOOKING', 'INQUIRY'],
    salesPersona: 'knowledgeable beauty advisor who gives personalised skincare and makeup recommendations, answers ingredient questions, and upsells complementary products naturally',
    intentMap: { ORDER: 'START_ORDER', BOOKING: 'START_BOOKING', INQUIRY: 'ABOUT', UNKNOWN: 'FALLBACK' },
    tone: { style: 'FRIENDLY', industry: 'RETAIL' },
    addOns: [
      { name: 'Travel Pouch',   price: 40 },
      { name: 'Makeup Sponge',  price: 30 },
      { name: 'Gift Wrapping',  price: 25 },
    ],
    smartRecommendations: {
      enabled: true,
      trigger: 'AFTER_ITEM_SELECT',
      prompt: 'Suggest ONE complementary skincare or beauty product that pairs well with the selected item. Give a one-sentence reason why they go together. Keep it friendly and beauty-expert in tone.',
    },
    labels: {
      welcome:              '💄 Welcome! Ready to glow? What can I help you find today?',
      welcomePersonalised:  (name) => `💄 Welcome back, *${name}*! Great to have you. What are we working on today? ✨`,
      nameReceivedMsg:      (name) => `Lovely to meet you, *${name}*! 😊 Let me help you find your perfect product.`,
      orderBtn:             '💋 Shop Products',
      bookBtn:              '💅 Book Consultation',
      orderPrompt:          '✨ Our bestsellers — choose a product:',
      servicePrompt:        'What type of consultation would you like?',
      bookPrompt:           'What date would you like your consultation? 📅',
      timePrompt:           'What time works best? ⏰',
      confirmOrder: (item, qty, price) =>
        `🧾 *Your Order*\n\n💄 *${item}* × ${qty}` +
        (price ? `\n💰 Total: *D${price}*` : ''),
      confirmBooking: (service, date, time) =>
        `📋 *Consultation Summary*\n\n💅 *${service}*\n📅 *${date}*` +
        (time ? `\n⏰ *${time}*` : ''),
      orderSuccess: (item, qty) =>
        `✅ *Order placed!*\n\n💋 *${qty}× ${item}*\n\nYour beauty is on its way! We'll confirm delivery details shortly. ✨\n\nType *0* to return to menu.`,
      bookingSuccess: (date, time, service) =>
        `✅ *Consultation booked!*\n\n` +
        (service ? `💅 *${service}*\n` : '') +
        `📅 *${date}*` +
        (time ? `\n⏰ *${time}*` : '') +
        '\n\nSee you then! ✨\n\nType *0* to return to menu.',
      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\nTotal: *D${amount}*\nWave to: *${wavePhone}*\n\nSend your payment screenshot here. 💄`,
      paymentProofReceived: `✅ Got your screenshot! Verifying payment now — almost there! 💋`,
      paymentConfirmed:     `✅ *Payment confirmed!* Your order is on its way. Enjoy! ✨`,
      paymentRejected:      `❌ *Payment couldn't be verified.* Please resend or type *Order* to restart.`,
      cancelMsg:    '✅ Cancelled! Come back anytime — we love helping you glow 💄',
      trackOrderMsg: (adminPhone) =>
        `📦 *Order Status*\n\nFor updates on your order, contact us directly.\n\n` +
        (adminPhone ? `📞 *${adminPhone}*` : 'Please call us directly.'),
      repeatOrderMsg: (lastItem) =>
        lastItem
          ? `🔄 Would you like to order *${lastItem}* again?\n\nTap *Shop* to get started!`
          : `🔄 Tap *Shop* to browse our products!`,
      fallback:     'Would you like to *shop* our products, *book a consultation*, or do you have a *beauty question*?',
      loopFallback: "Let me help you find the perfect product:",
      upsellPrompt: (name, price) => price > 0
        ? `Would you also like *${name}* for D${price}? It pairs perfectly! 💋`
        : `Would you like to add a *${name}* — complimentary with your order? ✨`,
    },
    ui: {
      welcomeButtons:  [{ id: 'ORDER', title: '💄 Shop Products' }, { id: 'BOOK', title: '💅 Book Consultation' }, { id: 'QUESTION', title: '❓ Beauty Advice' }],
      confirmButtons:  [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
      switchButtons:   [{ id: 'SWITCH_YES', title: '✅ Yes, switch' }, { id: 'SWITCH_NO', title: '❌ No, continue' }],
      fallbackButtons: [{ id: 'ORDER', title: '💄 Shop' }, { id: 'BOOK', title: '💅 Consult' }, { id: 'QUESTION', title: '❓ Question' }],
      upsellButtons:   [{ id: 'UPSELL_YES', title: '✅ Add it' }, { id: 'UPSELL_NO', title: '❌ No thanks' }],
    },
    orderSteps:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    bookingSteps: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // ELECTRONICS — product enquiry + orders + warranty info
  // ─────────────────────────────────────────────────────────────────────────
  ELECTRONICS: {
    flows: ['ORDER', 'INQUIRY'],
    salesPersona: 'knowledgeable electronics sales expert who answers spec questions accurately, helps customers pick the right product for their budget, and explains warranty and return policies clearly',
    intentMap: { ORDER: 'START_ORDER', INQUIRY: 'ABOUT', UNKNOWN: 'FALLBACK' },
    tone: { style: 'PROFESSIONAL', industry: 'RETAIL' },
    addOns: [
      { name: 'Extended Warranty (1yr)', price: 150 },
      { name: 'Screen Protector',        price: 50  },
      { name: 'Protective Case',         price: 75  },
      { name: 'Delivery & Setup',        price: 100 },
    ],
    smartRecommendations: {
      enabled: true,
      trigger: 'AFTER_ITEM_SELECT',
      prompt: 'Suggest ONE practical accessory that complements the selected electronics item. Include a brief technical reason (e.g. protects the screen, extends battery life). Professional tone.',
    },
    labels: {
      welcome:              "📱 Welcome! Looking for the best tech deals? Let's find the right product for you.",
      welcomePersonalised:  (name) => `📱 Welcome back, *${name}*! Great to have you. What are you looking for today?`,
      nameReceivedMsg:      (name) => `Nice to meet you, *${name}*! 😊 Let me help you find the right product.`,
      orderBtn:             '📱 Browse Products',
      orderPrompt:          "🖥️ Here's our product range — choose an item:",
      servicePrompt:        null,
      bookPrompt:           null,
      timePrompt:           null,
      confirmOrder: (item, qty, price) =>
        `🧾 *Order Summary*\n\n📱 *${item}* × ${qty}` +
        (price ? `\n💰 Total: *D${price}*` : '') +
        "\n\n🔧 We'll confirm availability and delivery timeline.",
      orderSuccess: (item, qty) =>
        `✅ *Order received!*\n\n📦 *${qty}× ${item}*\n\nWe'll verify stock and reach out with delivery details. Thank you! 📱\n\nType *0* to return to menu.`,
      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\nTotal: *D${amount}*\nWave to: *${wavePhone}*\n\nSend payment screenshot to confirm your order. 📸`,
      paymentProofReceived: `✅ *Screenshot received!* Verifying your payment now.`,
      paymentConfirmed:     `✅ *Paid!* Your order is confirmed. We'll arrange delivery shortly. 📦`,
      paymentRejected:      `❌ *Payment not verified.* Please resend the correct amount or type *Order* to restart.`,
      cancelMsg:    '✅ Order cancelled. Type *Browse* to shop again. 📱',
      trackOrderMsg: (adminPhone) =>
        `📦 *Order Tracking*\n\nFor delivery updates, contact us directly.\n\n` +
        (adminPhone ? `📞 *${adminPhone}*` : 'Please call us directly.'),
      repeatOrderMsg: (lastItem) =>
        lastItem
          ? `🔄 Would you like to order *${lastItem}* again?\n\nTap *Browse* to get started!`
          : `🔄 Tap *Browse* to see our latest products!`,
      fallback:     'Would you like to *browse products*, get *tech advice*, or place an *order*?',
      loopFallback: 'Let me help you find the right product:',
      upsellPrompt: (name, price) => `Would you also like to add *${name}* for D${price}? 🔧`,
    },
    ui: {
      welcomeButtons:  [{ id: 'ORDER', title: '📱 Browse Products' }, { id: 'QUESTION', title: '❓ Tech Question' }],
      confirmButtons:  [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
      switchButtons:   [{ id: 'SWITCH_YES', title: '✅ Yes, switch' }, { id: 'SWITCH_NO', title: '❌ No, continue' }],
      fallbackButtons: [{ id: 'ORDER', title: '📱 Browse' }, { id: 'QUESTION', title: '❓ Question' }],
      upsellButtons:   [{ id: 'UPSELL_YES', title: '✅ Add it' }, { id: 'UPSELL_NO', title: '❌ No thanks' }],
    },
    orderSteps:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    bookingSteps: [],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // PHARMACY — OTC orders + health Q&A + prescription handling
  // ─────────────────────────────────────────────────────────────────────────
  PHARMACY: {
    flows: ['ORDER', 'INQUIRY'],
    salesPersona: 'professional, empathetic pharmacist assistant who helps customers find the right OTC medicines, answers health questions clearly, and always recommends consulting a pharmacist for prescription queries',
    intentMap: { ORDER: 'START_ORDER', INQUIRY: 'ABOUT', UNKNOWN: 'FALLBACK' },
    tone: { style: 'PROFESSIONAL', industry: 'RETAIL' },
    addOns: [
      { name: 'Delivery to Your Door', price: 50  },
      { name: 'Pill Organiser',        price: 35  },
      { name: 'First Aid Kit',         price: 120 },
    ],
    smartRecommendations: {
      enabled: true,
      trigger: 'AFTER_ITEM_SELECT',
      prompt: 'Suggest ONE complementary health or wellness product (e.g. a vitamin, first aid item, or related OTC product). Always note this is a general suggestion and to ask a pharmacist for medical advice. Keep it brief and professional.',
    },
    labels: {
      welcome:              '💊 Welcome to your pharmacy! How can we help you today?',
      welcomePersonalised:  (name) => `💊 Welcome back, *${name}*! How can we help you today?`,
      nameReceivedMsg:      (name) => `Nice to meet you, *${name}*! 😊 How can I help you today?`,
      orderBtn:             '💊 Order Medicines',
      orderPrompt:          '🏥 Our available products — choose one to order:',
      servicePrompt:        null,
      bookPrompt:           null,
      timePrompt:           null,
      confirmOrder: (item, qty, price) =>
        `🧾 *Order Summary*\n\n💊 *${item}* × ${qty}` +
        (price ? `\n💰 Total: *D${price}*` : '') +
        '\n\n⚕️ *Note: For prescription medicines, please have your prescription ready.*',
      orderSuccess: (item, qty) =>
        `✅ *Order placed!*\n\n💊 *${qty}× ${item}*\n\nWe'll prepare your order. Delivery details to follow. Stay well! 🏥\n\nType *0* to return to menu.`,
      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\nTotal: *D${amount}*\nWave to: *${wavePhone}*\n\nSend your payment screenshot here. 📸`,
      paymentProofReceived: `✅ *Screenshot received!* We're verifying your payment now.`,
      paymentConfirmed:     `✅ *Paid!* Your medicines are being prepared. Thank you! 💊`,
      paymentRejected:      `❌ *Payment not verified.* Please resend or type *Order* to restart.`,
      cancelMsg:    "✅ Order cancelled. Type *Order* when you're ready. Stay healthy! 💊",
      trackOrderMsg: (adminPhone) =>
        `📦 *Order Status*\n\nFor updates on your order, contact us directly.\n\n` +
        (adminPhone ? `📞 *${adminPhone}*` : 'Please call us directly.'),
      repeatOrderMsg: (lastItem) =>
        lastItem
          ? `🔄 Would you like to order *${lastItem}* again?\n\nTap *Order* to get started!`
          : `🔄 Tap *Order* to browse our products!`,
      fallback:     'Would you like to *order medicines*, or do you have a *health question*?',
      loopFallback: 'Let me help you find what you need:',
      upsellPrompt: (name, price) => `Would you also like *${name}* for D${price}? 💊`,
    },
    ui: {
      welcomeButtons:  [{ id: 'ORDER', title: '💊 Order Medicines' }, { id: 'QUESTION', title: '❓ Health Question' }],
      confirmButtons:  [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
      switchButtons:   [{ id: 'SWITCH_YES', title: '✅ Yes, switch' }, { id: 'SWITCH_NO', title: '❌ No, continue' }],
      fallbackButtons: [{ id: 'ORDER', title: '💊 Order' }, { id: 'QUESTION', title: '❓ Question' }],
      upsellButtons:   [{ id: 'UPSELL_YES', title: '✅ Add it' }, { id: 'UPSELL_NO', title: '❌ No thanks' }],
    },
    orderSteps:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    bookingSteps: [],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // BARBERSHOP — appointment booking + walk-in queue + FAQ
  // Shares the same booking flow as SALON but with barbershop-specific
  // persona, labels, and service terminology.
  // ─────────────────────────────────────────────────────────────────────────
  BARBERSHOP: {
    flows: ['BOOKING', 'INQUIRY'],

    salesPersona: 'friendly, professional barber who helps clients book appointments, answers questions about cuts and styles, and keeps things short and confident',

    intentMap: {
      BOOKING: 'START_BOOKING',
      INQUIRY: 'ABOUT',
      UNKNOWN: 'FALLBACK',
    },

    tone: { style: 'FRIENDLY', industry: 'SALON' },

    addOns: [
      { name: 'Hot Towel Shave',   price: 75  },
      { name: 'Beard Trim',        price: 50  },
      { name: 'Hair Treatment',    price: 100 },
      { name: 'Eyebrow Threading', price: 40  },
    ],

    smartRecommendations: {
      enabled: false,
      trigger: null,
      prompt:  null,
    },

    labels: {
      welcome:              '✂️ Welcome! Ready for a fresh cut? What can we do for you?',
      welcomePersonalised:  (name) => `✂️ Welcome back, *${name}*! Good to see you. What are we doing today? 💈`,
      nameReceivedMsg:      (name) => `Nice to meet you, *${name}*! 😊 Let me get you booked in.`,
      bookBtn:              '💈 Book Appointment',
      contactBtn:           '📞 Contact Us',
      orderPrompt:          null,
      bookPrompt:           'Which service would you like? 💈',
      servicePrompt:        'Please choose a service:',
      timePrompt:           'What time works best for you? ⏰',

      confirmBooking: (service, date, time) =>
        `📋 *Booking Summary*\\n\\n💈 *${service}*\\n📅 *${date}*` +
        (time ? `\\n⏰ *${time}*` : ''),

      bookingSuccess: (date, time, service) =>
        `✅ *Booking confirmed!*\\n\\n` +
        (service ? `💈 *${service}*\\n` : '') +
        `📅 *${date}*` +
        (time ? `\\n⏰ *${time}*` : '') +
        '\\n\\nSee you then! ✂️\\n\\nType *0* to return to menu.',

      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\\n\\nTotal: *D${amount}*\\nWave to: *${wavePhone}*\\n\\nSend your screenshot here after paying.`,

      paymentProofReceived:
        `✅ *Screenshot received.*\\n\\n⏳ Verifying your payment — we'll confirm shortly.`,

      paymentConfirmed:
        `✅ *Payment confirmed!* Your appointment is locked in. See you soon! 💈\\n\\nType *0* to return to menu.`,

      paymentRejected:
        `❌ *Payment could not be verified.*\\n\\nPlease check the amount and try again, or contact us directly.`,

      cancelMsg:    "✅ No problem! Type *Book* whenever you're ready, or *Question* to ask us anything.",

      trackOrderMsg: (adminPhone) =>
        `📅 *Appointment Status*\\n\\nFor updates on your appointment, please contact us directly.\\n\\n` +
        (adminPhone ? `📞 *${adminPhone}*` : 'Please call us directly.'),

      repeatOrderMsg: (lastService) =>
        lastService
          ? `🔄 Would you like to book *${lastService}* again?\\n\\nTap *Book* to schedule your next cut.`
          : `🔄 Tap *Book* to schedule your next appointment!`,

      fallback:     'Would you like to *book an appointment* or ask a *question*?',
      loopFallback: 'Let me help you get booked in:',

      upsellPrompt: (addOnName, addOnPrice) =>
        `Would you like to add *${addOnName}* for D${addOnPrice}? ✂️`,
    },

    ui: {
      welcomeButtons: [
        { id: 'BOOK',     title: '💈 Book Appointment' },
        { id: 'QUESTION', title: '❓ Ask a Question' },
      ],
      confirmButtons: [
        { id: 'CONFIRM', title: '✅ Confirm' },
        { id: 'CANCEL',  title: '❌ Cancel' },
      ],
      switchButtons: [
        { id: 'SWITCH_YES', title: '✅ Yes, switch' },
        { id: 'SWITCH_NO',  title: '❌ No, continue' },
      ],
      fallbackButtons: [
        { id: 'BOOK',     title: '💈 Book Appointment' },
        { id: 'QUESTION', title: '❓ Question' },
      ],
      upsellButtons: [
        { id: 'UPSELL_YES', title: '✅ Yes, add it' },
        { id: 'UPSELL_NO',  title: '❌ No thanks' },
      ],
    },

    orderSteps:   [],
    bookingSteps: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // DELIVERY — delivery order + tracking + scheduling
  // ─────────────────────────────────────────────────────────────────────────
  DELIVERY: {
    flows: ['ORDER', 'BOOKING', 'INQUIRY'],
    salesPersona: 'efficient, friendly delivery coordinator who collects delivery details, confirms pickup and drop-off, and gives clear time estimates',
    intentMap: { ORDER: 'START_ORDER', BOOKING: 'START_BOOKING', INQUIRY: 'ABOUT', UNKNOWN: 'FALLBACK' },
    tone: { style: 'FRIENDLY', industry: 'RETAIL' },
    addOns: [
      { name: 'Priority Delivery', price: 75 },
      { name: 'Fragile Handling',  price: 50 },
      { name: 'Proof of Delivery', price: 25 },
    ],
    smartRecommendations: {
      enabled: false,
      trigger: null,
      prompt:  null,
    },
    labels: {
      welcome:              '🚚 Welcome! Fast, reliable delivery. What do you need today?',
      welcomePersonalised:  (name) => `🚚 Welcome back, *${name}*! Great to have you. What would you like to send today?`,
      nameReceivedMsg:      (name) => `Nice to meet you, *${name}*! 😊 Let me help you book a delivery.`,
      orderBtn:             '📦 Place Delivery',
      bookBtn:              '📅 Schedule Pickup',
      orderPrompt:          '📦 Choose your delivery service:',
      servicePrompt:        'What type of delivery?',
      bookPrompt:           'What date should we pick up? 📅',
      timePrompt:           'What time works for pickup? ⏰',
      confirmOrder: (item, qty, price) =>
        `🧾 *Delivery Summary*\n\n📦 *${item}* × ${qty}` +
        (price ? `\n💰 Total: *D${price}*` : '') +
        "\n\n📍 Please send your *pickup address* next.",
      confirmBooking: (serviceOrDate, dateOrTime, timeOrUndefined) => {
        const hasService = timeOrUndefined !== undefined;
        const service = hasService ? serviceOrDate : null;
        const date    = hasService ? dateOrTime    : serviceOrDate;
        const time    = hasService ? timeOrUndefined : dateOrTime;
        return `📋 *Pickup Summary*\n\n` +
          (service ? `📦 *${service}*\n` : '') +
          `📅 *${date}*` + (time ? `\n⏰ *${time}*` : '');
      },
      orderSuccess: (item, qty) =>
        `✅ *Delivery booked!*\n\n🚚 *${qty}× ${item}*\n\nOur rider will be in touch. Thank you! 🚀\n\nType *0* to return to menu.`,
      bookingSuccess: (date, time, service) =>
        `✅ *Pickup scheduled!*\n\n` +
        (service ? `📦 *${service}*\n` : '') +
        `📅 *${date}*` +
        (time ? `\n⏰ *${time}*` : '') + '\n\nOur driver will be there. 🚚',
      paymentInstructions: (amount, wavePhone) =>
        `💳 *Payment*\n\nTotal: *D${amount}*\nWave to: *${wavePhone}*\n\nSend screenshot to confirm. 📸`,
      paymentProofReceived: `✅ *Screenshot received!* Confirming your booking now.`,
      paymentConfirmed:     `✅ *Paid!* Your delivery is confirmed. Rider details incoming. 🚚`,
      paymentRejected:      `❌ *Payment not verified.* Please resend or type *Order* to restart.`,
      cancelMsg:    '✅ Cancelled. Type *Order* to book a new delivery anytime. 🚚',
      trackOrderMsg: (adminPhone) =>
        `🚚 *Delivery Tracking*\n\nFor live updates on your delivery, contact us directly.\n\n` +
        (adminPhone ? `📞 *${adminPhone}*` : 'Please call us directly.'),
      repeatOrderMsg: (lastItem) =>
        lastItem
          ? `🔄 Would you like to book *${lastItem}* again?\n\nTap *Order* to get started!`
          : `🔄 Tap *Order* to book a new delivery!`,
      fallback:     'Would you like to *place a delivery*, *schedule a pickup*, or ask a *question*?',
      loopFallback: 'Let me help you book your delivery:',
      upsellPrompt: (name, price) => `Would you like to add *${name}* for D${price}? 🚚`,
    },
    ui: {
      welcomeButtons:  [{ id: 'ORDER', title: '📦 Place Delivery' }, { id: 'BOOK', title: '📅 Schedule Pickup' }, { id: 'QUESTION', title: '❓ Ask a Question' }],
      confirmButtons:  [{ id: 'CONFIRM', title: '✅ Confirm' }, { id: 'CANCEL', title: '❌ Cancel' }],
      switchButtons:   [{ id: 'SWITCH_YES', title: '✅ Yes, switch' }, { id: 'SWITCH_NO', title: '❌ No, continue' }],
      fallbackButtons: [{ id: 'ORDER', title: '📦 Delivery' }, { id: 'BOOK', title: '📅 Pickup' }, { id: 'QUESTION', title: '❓ Question' }],
      upsellButtons:   [{ id: 'UPSELL_YES', title: '✅ Add it' }, { id: 'UPSELL_NO', title: '❌ No thanks' }],
    },
    orderSteps:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    bookingSteps: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },
};

// ─── getModeConfig ────────────────────────────────────────────────────────────

export function getModeConfig(businessOrMode) {
  const raw =
    typeof businessOrMode === 'string'
      ? businessOrMode
      : (businessOrMode?.businessMode || businessOrMode?.mode || 'RESTAURANT');

  const legacyMap = { BOTH: 'RESTAURANT', ORDER: 'RETAIL', BOOKING: 'SALON', BARBERSHOP: 'BARBERSHOP' };
  const key = legacyMap[raw?.toUpperCase()] ?? raw?.toUpperCase();

  return MODES[key] ?? MODES.RESTAURANT;
}

export function isFlowEnabled(business, flowName) {
  return getModeConfig(business).flows.includes(flowName);
}

// ─── getLabel ─────────────────────────────────────────────────────────────────

export function getLabel(business, labelKey, ...args) {
  const custom = business?.customMessages?.[labelKey];
  if (custom && typeof custom === 'string' && custom.trim()) return custom.trim();

  const label = getModeConfig(business).labels[labelKey];
  if (!label) return '';
  return typeof label === 'function' ? label(...args) : label;
}

// ─── getModeRestrictionMessage ────────────────────────────────────────────────

export function getModeRestrictionMessage(business, flow) {
  const name = business?.name || 'this business';
  if (flow === 'ORDER') {
    return `Sorry, *${name}* doesn't accept orders through this bot.\n\nType *Book* to make an appointment, or type *0* to see options.`;
  }
  if (flow === 'BOOKING') {
    return `Sorry, *${name}* doesn't accept bookings through this bot.\n\nType *Order* to place an order, or type *0* to see options.`;
  }
  return `That option isn't available right now. Type *0* to see what I can help you with.`;
}
