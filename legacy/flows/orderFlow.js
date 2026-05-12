'use strict';

/**
 * Order Flow — Intelligent ordering with:
 * - Fuzzy menu item matching
 * - Word/phrase quantity parsing
 * - Smart upsell suggestions
 * - Context memory (add more, change, remove)
 * - Large-order warnings
 * - Duplicate detection
 */

const { sendText, sendButtons, sendList } = require('../services/waSender');
const { sessionStore } = require('../services/sessionStore');
const { fuzzyMatchMenuItem, parseQuantity, validateQuantity, detectIntent } = require('../utils/nlp');
const config = require('../config/businessConfig');
const { logger } = require('../utils/logger');
const { formatCurrency, generateOrderId } = require('../utils/helpers');

// ─── Start Browsing / Show Menu ───────────────────────────────────────────────
async function startBrowsing({ session, userId, phoneNumberId }) {
  session.state = 'BROWSING_MENU';
  sessionStore.save(session);

  const sections = config.categories.map(cat => {
    const items = config.menu.filter(i => i.category === cat.id && i.available);
    return {
      title: `${cat.emoji} ${cat.name}`,
      rows: items.map(item => ({
        id: `item_${item.id}`,
        title: item.name,
        description: `${formatCurrency(item.price)} — ${item.description?.substring(0, 60)}`,
      })),
    };
  }).filter(s => s.rows.length > 0);

  const cartCount = session.currentOrder.reduce((s, i) => s + i.qty, 0);
  const footerText = cartCount > 0 ? `🛒 ${cartCount} item(s) in your cart` : 'Tap an item to add it';

  return sendList(
    phoneNumberId, userId,
    `Here's our menu! 🍽️\n\nBrowse categories below or just *type* what you're looking for — I'll find it for you.`,
    '📋 View Menu',
    sections,
    '*DreamLine Menu*',
    footerText
  );
}

// ─── Show Category ─────────────────────────────────────────────────────────────
async function showCategory({ session, categoryId, userId, phoneNumberId }) {
  const cat = config.categories.find(c => c.id === categoryId);
  const items = config.menu.filter(i => i.category === categoryId && i.available);

  if (!cat || !items.length) {
    return sendText(phoneNumberId, userId, `No items available in that category right now. Try another? 😊`);
  }

  session.state = 'BROWSING_MENU';
  session.lastMenu = categoryId;
  sessionStore.save(session);

  const rows = items.map(item => ({
    id: `item_${item.id}`,
    title: item.name,
    description: `${formatCurrency(item.price)}${item.popular ? ' ⭐ Popular' : ''}`,
  }));

  return sendList(
    phoneNumberId, userId,
    `${cat.emoji} *${cat.name}*\n\nChoose an item to add to your order:`,
    'Choose Item',
    [{ title: cat.name, rows }],
    null,
    'Type item name or tap to select'
  );
}

// ─── Main Order Handler (text input routing) ────────────────────────────────────
async function handle({ session, parsed, userId, phoneNumberId, intent }) {
  const text = parsed.text || '';

  // ── State-specific handling ───────────────────────────────────────────────
  if (session.state === 'AWAITING_QUANTITY') {
    return handleQuantityInput({ session, text, userId, phoneNumberId });
  }

  if (session.state === 'AWAITING_ADDON') {
    return handleAddonResponse({ session, text, userId, phoneNumberId, intent });
  }

  if (session.state === 'AWAITING_ORDER_TYPE') {
    return handleOrderTypeResponse({ session, text, userId, phoneNumberId, intent });
  }

  if (session.state === 'CART_REVIEW') {
    return handleCartReviewInput({ session, text, userId, phoneNumberId, intent });
  }

  // ── Intent overrides ──────────────────────────────────────────────────────
  if (intent?.primary === 'VIEW_CART') return showCart({ session, userId, phoneNumberId });
  if (intent?.primary === 'CHECKOUT')  return require('./paymentFlow').startCheckout({ session, userId, phoneNumberId });
  if (intent?.primary === 'REMOVE_ITEM') return handleRemoveItem({ session, text, userId, phoneNumberId });
  if (intent?.primary === 'CLEAR_CART') {
    session.awaitingConfirmation = { type: 'clear_cart', data: {} };
    sessionStore.save(session);
    return sendButtons(phoneNumberId, userId,
      '🗑️ Clear your entire cart?\nAll items will be removed.',
      [{ id: 'confirm_yes', title: '✅ Yes, Clear' }, { id: 'confirm_no', title: '❌ Keep Items' }]
    );
  }
  if (intent?.primary === 'ADD_MORE') {
    return startBrowsing({ session, userId, phoneNumberId });
  }
  if (intent?.primary === 'MENU') {
    return startBrowsing({ session, userId, phoneNumberId });
  }

  // ── Context-aware modifications ───────────────────────────────────────────
  const lower = text.toLowerCase();

  // "change it to chicken" / "make it chicken"
  const changeMatch = lower.match(/\b(change|swap|switch|make it|change (it )?to)\s+(.+)/);
  if (changeMatch && session.currentOrder.length > 0) {
    return handleChangeItem({ session, query: changeMatch[3], userId, phoneNumberId });
  }

  // "add 2 more" — re-add last item
  const addMoreMatch = lower.match(/add\s+(\w+)\s+more/);
  if (addMoreMatch && session.currentOrder.length > 0) {
    const qty = parseQuantity(addMoreMatch[1]);
    if (qty && session.currentOrder.length > 0) {
      const lastItem = session.currentOrder[session.currentOrder.length - 1];
      lastItem.qty += qty;
      sessionStore.save(session);
      return sendButtons(phoneNumberId, userId,
        `✅ Added ${qty} more *${lastItem.name}*!\nYou now have ${lastItem.qty}x ${lastItem.name} in your cart.`,
        [
          { id: 'action_continue', title: '➕ Add More' },
          { id: 'action_cart',     title: '🛒 View Cart' },
          { id: 'action_checkout', title: '✅ Checkout' },
        ]
      );
    }
  }

  // ── Fuzzy item search ──────────────────────────────────────────────────────
  if (text.length > 0) {
    return handleItemSearch({ session, text, userId, phoneNumberId });
  }

  return startBrowsing({ session, userId, phoneNumberId });
}

// ─── Item Search & Match ───────────────────────────────────────────────────────
async function handleItemSearch({ session, text, userId, phoneNumberId }) {
  const availableItems = config.menu.filter(i => i.available);
  const matches = fuzzyMatchMenuItem(text, availableItems);

  if (!matches.length) {
    return sendButtons(phoneNumberId, userId,
      `I couldn't find "${text}" on our menu 🤔\n\nWould you like to browse all options?`,
      [
        { id: 'action_menu',   title: '📋 View Menu' },
        { id: 'action_cart',   title: '🛒 My Cart' },
        { id: 'action_human',  title: '👤 Get Help' },
      ]
    );
  }

  const top = matches[0];

  // High confidence — proceed directly
  if (top.confidence === 'high') {
    return selectItem({ session, itemId: top.item.id, userId, phoneNumberId });
  }

  // Medium confidence — confirm
  if (top.confidence === 'medium') {
    if (matches.length === 1 || matches[1].score < top.score - 0.2) {
      // Single good match — confirm it
      session.awaitingConfirmation = { type: 'fuzzy_item', data: { itemId: top.item.id } };
      sessionStore.save(session);
      return sendButtons(phoneNumberId, userId,
        `Did you mean *${top.item.name}*? (${formatCurrency(top.item.price)}) 😊`,
        [
          { id: 'confirm_yes',   title: '✅ Yes' },
          { id: 'confirm_no',    title: '❌ No, Browse' },
        ]
      );
    } else {
      // Multiple similar matches — offer choices
      const topMatches = matches.slice(0, Math.min(3, matches.length));
      return sendButtons(phoneNumberId, userId,
        `I found a few similar items:\n\n${topMatches.map((m, i) => `${i+1}. *${m.item.name}* — ${formatCurrency(m.item.price)}`).join('\n')}\n\nWhich one would you like?`,
        topMatches.slice(0, 3).map(m => ({
          id: `item_${m.item.id}`,
          title: m.item.name.substring(0, 20),
        }))
      );
    }
  }

  // Low confidence — show menu
  return sendButtons(phoneNumberId, userId,
    `I'm not sure what you're looking for 🤔\nLet me show you the full menu so you can choose!`,
    [{ id: 'action_menu', title: '📋 View Menu' }]
  );
}

// ─── Select Item ───────────────────────────────────────────────────────────────
async function selectItem({ session, itemId, userId, phoneNumberId }) {
  const item = config.menu.find(i => i.id === itemId && i.available);

  if (!item) {
    return sendText(phoneNumberId, userId, `Sorry, that item isn't available right now. 😔`);
  }

  session.pendingItem = { itemId, name: item.name, price: item.price, addons: [] };
  session.state = 'AWAITING_QUANTITY';
  sessionStore.save(session);

  // Check if already in cart
  const existing = session.currentOrder.find(i => i.itemId === itemId);
  const hint = existing ? `\n_(You already have ${existing.qty}x in your cart)_` : '';

  return sendButtons(phoneNumberId, userId,
    `Great choice! 😊\n\n*${item.name}* — ${formatCurrency(item.price)}\n${item.description}${hint}\n\nHow many would you like?`,
    [
      { id: 'qty_1', title: '1️⃣ One' },
      { id: 'qty_2', title: '2️⃣ Two' },
      { id: 'qty_3', title: '3️⃣ Three' },
    ],
    null,
    'Or type any number — "five", "10", "a dozen"…'
  );
}

// ─── Set Quantity from Button ─────────────────────────────────────────────────
async function setQuantityFromButton({ session, qty, userId, phoneNumberId }) {
  return handleQuantityInput({ session, text: String(qty), userId, phoneNumberId });
}

// ─── Handle Quantity Input ────────────────────────────────────────────────────
async function handleQuantityInput({ session, text, userId, phoneNumberId }) {
  if (!session.pendingItem) {
    session.state = 'BROWSING_MENU';
    sessionStore.save(session);
    return startBrowsing({ session, userId, phoneNumberId });
  }

  const qty = parseQuantity(text);

  if (!qty) {
    return sendButtons(phoneNumberId, userId,
      `I understood you want *${session.pendingItem.name}* 😊\n\nCould you confirm the quantity?\nYou can type a number like *1*, *2*, *5* — or words like *"two"* or *"five"*.`,
      [
        { id: 'qty_1', title: '1️⃣ One' },
        { id: 'qty_2', title: '2️⃣ Two' },
        { id: 'qty_3', title: '3️⃣ Three' },
      ]
    );
  }

  const validation = validateQuantity(qty, session.pendingItem.name);

  if (validation.valid === false) {
    return sendButtons(phoneNumberId, userId,
      `That quantity doesn't look right 🤔\nHow many *${session.pendingItem.name}* would you like?`,
      [{ id: 'qty_1', title: '1' }, { id: 'qty_2', title: '2' }, { id: 'qty_3', title: '3' }]
    );
  }

  // Large order warning
  if (validation.valid === 'warn') {
    session.awaitingConfirmation = { type: 'large_qty', data: { qty } };
    sessionStore.save(session);
    return sendButtons(phoneNumberId, userId,
      `Just to confirm — did you want *${qty} × ${session.pendingItem.name}*? 🤔\n\nThat's a large order (${formatCurrency(qty * session.pendingItem.price)} total). Want to proceed?`,
      [
        { id: 'confirm_yes', title: '✅ Yes, Confirm' },
        { id: 'confirm_no',  title: '✏️ Change Qty' },
      ]
    );
  }

  return confirmItemAdd({ session, qty, userId, phoneNumberId });
}

// ─── Confirm Item Add to Cart ─────────────────────────────────────────────────
async function confirmItemAdd({ session, qty, userId, phoneNumberId }) {
  const pending = session.pendingItem;
  if (!pending) return startBrowsing({ session, userId, phoneNumberId });

  const item = config.menu.find(i => i.id === pending.itemId);

  // Add/merge in cart
  const existing = session.currentOrder.find(i => i.itemId === pending.itemId);
  if (existing) {
    existing.qty += qty;
  } else {
    session.currentOrder.push({ ...pending, qty });
  }

  session.pendingItem = null;

  // Check for addons
  if (item?.addons?.length > 0) {
    session.state = 'AWAITING_ADDON';
    sessionStore.save(session);
    const addonButtons = item.addons.slice(0, 2).map(a => ({
      id: `addon_${a.id}`,
      title: `${a.name} +${formatCurrency(a.price)}`,
    }));
    addonButtons.push({ id: 'addon_skip', title: '⏭️ No Thanks' });
    return sendButtons(phoneNumberId, userId,
      `✅ Added *${qty}x ${pending.name}* to your order!\n\nWould you like to add anything extra?`,
      addonButtons
    );
  }

  session.state = 'ORDERING';
  sessionStore.save(session);

  // Upsell suggestion
  const upsellIds = config.upsells[pending.itemId] || [];
  if (upsellIds.length > 0 && session.currentOrder.length <= 2) {
    const upsellItems = upsellIds
      .map(id => config.menu.find(m => m.id === id && m.available))
      .filter(Boolean)
      .slice(0, 2);

    if (upsellItems.length > 0) {
      return sendButtons(phoneNumberId, userId,
        `✅ *${qty}x ${pending.name}* added!\n\nCustomers also love:\n${upsellItems.map(u => `• *${u.name}* — ${formatCurrency(u.price)}`).join('\n')}\n\nWould you like to add any?`,
        [
          ...upsellItems.map(u => ({ id: `upsell_${u.id}`, title: u.name.substring(0, 20) })),
          { id: 'upsell_skip', title: '✅ No Thanks' },
        ]
      );
    }
  }

  return sendContinueOrCheckout({ session, userId, phoneNumberId, addedItem: pending.name, qty });
}

// ─── Continue or Checkout Prompt ─────────────────────────────────────────────
async function sendContinueOrCheckout({ session, userId, phoneNumberId, addedItem, qty }) {
  const total = cartTotal(session.currentOrder);
  return sendButtons(phoneNumberId, userId,
    `✅ *${qty}x ${addedItem}* added to your cart!\n\n🛒 *Cart total: ${formatCurrency(total)}*\n\nWhat's next?`,
    [
      { id: 'action_continue', title: '➕ Add More' },
      { id: 'action_cart',     title: '🛒 View Cart' },
      { id: 'action_checkout', title: '✅ Checkout' },
    ]
  );
}

// ─── Addon Handling ───────────────────────────────────────────────────────────
async function addAddon({ session, addonId, userId, phoneNumberId }) {
  const lastItem = session.currentOrder[session.currentOrder.length - 1];
  if (lastItem) {
    const item = config.menu.find(i => i.id === lastItem.itemId);
    const addon = item?.addons?.find(a => a.id === addonId);
    if (addon) {
      lastItem.addons = lastItem.addons || [];
      lastItem.addons.push(addon);
    }
  }
  session.state = 'ORDERING';
  sessionStore.save(session);
  return sendContinueOrCheckout({ session, userId, phoneNumberId, addedItem: lastItem?.name || 'item', qty: lastItem?.qty || 1 });
}

async function skipAddon({ session, userId, phoneNumberId }) {
  session.state = 'ORDERING';
  sessionStore.save(session);
  const last = session.currentOrder[session.currentOrder.length - 1];
  return sendContinueOrCheckout({ session, userId, phoneNumberId, addedItem: last?.name || 'item', qty: last?.qty || 1 });
}

async function handleAddonResponse({ session, text, userId, phoneNumberId, intent }) {
  if (intent?.primary === 'NO' || text.toLowerCase().includes('no')) {
    return skipAddon({ session, userId, phoneNumberId });
  }
  return skipAddon({ session, userId, phoneNumberId });
}

// ─── Show Cart ─────────────────────────────────────────────────────────────────
async function showCart({ session, userId, phoneNumberId }) {
  if (!session.currentOrder.length) {
    return sendButtons(phoneNumberId, userId,
      `Your cart is empty! 🛒\n\nReady to order some delicious Gambian food? 😊`,
      [{ id: 'action_order', title: '📋 Browse Menu' }]
    );
  }

  session.state = 'CART_REVIEW';
  sessionStore.save(session);

  let summary = `🛒 *Your Order Summary*\n${'─'.repeat(25)}\n`;
  for (const item of session.currentOrder) {
    const subtotal = item.qty * item.price;
    summary += `• ${item.qty}x *${item.name}* — ${formatCurrency(subtotal)}`;
    if (item.addons?.length) {
      summary += `\n  ↳ + ${item.addons.map(a => a.name).join(', ')}`;
    }
    summary += '\n';
  }
  summary += `${'─'.repeat(25)}\n*Total: ${formatCurrency(cartTotal(session.currentOrder))}*`;

  // Delivery fee notice
  const total = cartTotal(session.currentOrder);
  if (total < config.delivery.freeAbove) {
    summary += `\n_+ Delivery fee: ${formatCurrency(config.delivery.fee)}_`;
  } else {
    summary += `\n_✅ Free delivery on this order!_`;
  }

  return sendButtons(phoneNumberId, userId,
    summary,
    [
      { id: 'action_checkout',   title: '✅ Place Order' },
      { id: 'action_continue',   title: '➕ Add More Items' },
      { id: 'action_clear_cart', title: '🗑️ Clear Cart' },
    ]
  );
}

// ─── Clear Cart ───────────────────────────────────────────────────────────────
async function clearCart({ session, userId, phoneNumberId, confirmed = false }) {
  if (!confirmed) {
    session.awaitingConfirmation = { type: 'clear_cart', data: {} };
    sessionStore.save(session);
    return sendButtons(phoneNumberId, userId,
      '🗑️ Clear your entire cart?',
      [{ id: 'confirm_yes', title: '✅ Yes, Clear' }, { id: 'confirm_no', title: '❌ Keep Items' }]
    );
  }
  session.currentOrder = [];
  session.state = 'BROWSING_MENU';
  sessionStore.save(session);
  return sendButtons(phoneNumberId, userId,
    `Cart cleared! Ready to start fresh? 😊`,
    [{ id: 'action_order', title: '📋 Browse Menu' }]
  );
}

// ─── Order Type ───────────────────────────────────────────────────────────────
async function askOrderType({ session, userId, phoneNumberId }) {
  session.state = 'AWAITING_ORDER_TYPE';
  sessionStore.save(session);
  return sendButtons(phoneNumberId, userId,
    `How would you like to receive your order? 🚗`,
    [
      { id: 'order_delivery', title: '🚗 Delivery' },
      { id: 'order_pickup',   title: '🏃 Pickup' },
      { id: 'order_dinein',   title: '🪑 Dine-In' },
    ]
  );
}

async function setOrderType({ session, type, userId, phoneNumberId }) {
  session.orderType = type;
  sessionStore.save(session);
  return require('./paymentFlow').continueCheckout({ session, userId, phoneNumberId });
}

async function handleOrderTypeResponse({ session, text, userId, phoneNumberId, intent }) {
  const lower = text.toLowerCase();
  if (lower.includes('deliver') || intent?.primary === 'DELIVERY') return setOrderType({ session, type: 'delivery', userId, phoneNumberId });
  if (lower.includes('pickup') || lower.includes('pick up') || lower.includes('collect') || intent?.primary === 'PICKUP') return setOrderType({ session, type: 'pickup', userId, phoneNumberId });
  if (lower.includes('dine') || lower.includes('sit') || lower.includes('table')) return setOrderType({ session, type: 'dinein', userId, phoneNumberId });
  return askOrderType({ session, userId, phoneNumberId });
}

// ─── Remove Item ──────────────────────────────────────────────────────────────
async function handleRemoveItem({ session, text, userId, phoneNumberId }) {
  if (!session.currentOrder.length) {
    return sendText(phoneNumberId, userId, `Your cart is already empty! 😊`);
  }

  const availableItems = session.currentOrder.map(i => ({ id: i.itemId, name: i.name, keywords: [] }));
  const matches = fuzzyMatchMenuItem(text, availableItems);

  if (matches.length && matches[0].confidence !== 'low') {
    const toRemove = matches[0].item;
    session.currentOrder = session.currentOrder.filter(i => i.itemId !== toRemove.id);
    sessionStore.save(session);
    return sendButtons(phoneNumberId, userId,
      `🗑️ *${toRemove.name}* removed from your cart!`,
      [
        { id: 'action_cart',     title: '🛒 View Cart' },
        { id: 'action_continue', title: '➕ Add More' },
      ]
    );
  }

  // Can't identify — show cart so they can see what's there
  return showCart({ session, userId, phoneNumberId });
}

// ─── Change Item ──────────────────────────────────────────────────────────────
async function handleChangeItem({ session, query, userId, phoneNumberId }) {
  return handleItemSearch({ session, text: query, userId, phoneNumberId });
}

// ─── Cart Review Input ────────────────────────────────────────────────────────
async function handleCartReviewInput({ session, text, userId, phoneNumberId, intent }) {
  if (intent?.primary === 'CHECKOUT') return require('./paymentFlow').startCheckout({ session, userId, phoneNumberId });
  if (intent?.primary === 'ADD_MORE' || intent?.primary === 'MENU') return startBrowsing({ session, userId, phoneNumberId });
  return showCart({ session, userId, phoneNumberId });
}

// ─── Ask Quantity ─────────────────────────────────────────────────────────────
async function askQuantity({ session, userId, phoneNumberId }) {
  session.state = 'AWAITING_QUANTITY';
  sessionStore.save(session);
  return sendButtons(phoneNumberId, userId,
    `How many *${session.pendingItem?.name}* would you like?`,
    [{ id: 'qty_1', title: '1' }, { id: 'qty_2', title: '2' }, { id: 'qty_3', title: '3' }],
    null,
    'Or type any number'
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cartTotal(order) {
  return order.reduce((sum, item) => {
    const addonsTotal = (item.addons || []).reduce((a, ad) => a + ad.price, 0);
    return sum + item.qty * item.price + addonsTotal;
  }, 0);
}

module.exports = {
  handle, startBrowsing, showCategory, selectItem, setQuantityFromButton,
  confirmItemAdd, addAddon, skipAddon, showCart, clearCart,
  askOrderType, setOrderType, askQuantity, cartTotal,
};
