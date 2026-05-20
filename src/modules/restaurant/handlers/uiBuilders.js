/**
 * modules/restaurant/handlers/uiBuilders.js
 * Builds WhatsApp-ready UI objects for the order flow.
 */

export function buildMenuUI(business) {
  const items = (business?.menuItems || []).filter(i => i.available !== false);
  if (!items.length) {
    return { type: 'text', body: '⚠️ Menu not available. Please contact us directly.' };
  }
  const rows = items.map((item, i) => ({
    id:          String(i + 1),
    title:       item.name.slice(0, 24),
    description: [item.description, item.price ? `D${item.price}` : ''].filter(Boolean).join(' — ').slice(0, 72),
  }));
  return {
    type:        'list',
    header:      business?.name || 'Menu',
    body:        "Here's our menu — choose an item:",
    buttonLabel: 'View Menu',
    rows,
  };
}

export function buildOrderSummary({ item, qty, total, addOns = [], business }) {
  const name     = typeof item === 'object' ? item.name : item;
  const currency = business?.payment?.currency || 'D';
  const addOnStr = addOns.length ? `\n➕ Add-ons: ${addOns.join(', ')}` : '';
  return {
    type: 'buttons',
    body: `🧾 *Order Summary*\n\n🍽 *${qty}× ${name}*${addOnStr}${total ? `\n💰 Total: *${currency}${total}*` : ''}\n\nConfirm your order?`,
    buttons: [
      { id: 'CONFIRM', title: '✅ Confirm Order' },
      { id: 'CANCEL',  title: '❌ Cancel' },
    ],
  };
}

export function buildOrderSuccess({ item, qty, business }) {
  const name     = typeof item === 'object' ? item.name : (item || 'your item');
  const quantity = qty || 1;
  return {
    type: 'text',
    body: `✅ *Order placed!*\n\n🍳 *${quantity}× ${name}* — we're preparing it now.\n\nThank you! 😊`,
  };
}
