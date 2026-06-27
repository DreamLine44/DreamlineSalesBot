/**
 * modules/restaurant/handlers/uiBuilders.js
 *
 * [FIX-BUG11] buildAdminOrderAlertBody no longer hardcodes "Cash / On delivery".
 *             It now checks payment.enabled to show the correct payment mode.
 * [FIX-BUG14] buildMenuUI returns a Contact Us button on empty menu (not plain text).
 */

export function buildMenuUI(business) {
  const items = (business?.menuItems || []).filter(i => i.available !== false);
  if (!items.length) {
    // [FIX-BUG14] Return a button so there's somewhere to go
    return {
      type:    'buttons',
      body:    '⚠️ Our menu is being updated. Please contact us directly or check back soon.',
      buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }],
    };
  }
  // [FIX-MENU-CCY] Use configured currency symbol, not hardcoded 'D'.
  // [FIX-MENU-PRICE] Compute price string before building the row so the slice
  // never truncates the price off the end of a long description.
  const _menuCcy = business?.payment?.currency || 'D';
  const rows = items.map((item, i) => {
    const _priceStr   = item.price ? `${_menuCcy}${item.price}` : '';
    const _descStr    = item.description ? item.description.slice(0, 50) : '';
    const description = [_descStr, _priceStr].filter(Boolean).join(' — ').slice(0, 72);
    return {
      id:          String(i + 1),
      title:       item.name.slice(0, 24),
      description,
    };
  });
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
      { id: 'CANCEL',  title: '❌ Cancel'        },
    ],
  };
}

export function buildOrderSuccess({ item, qty, business }) {
  const name     = typeof item === 'object' ? item.name : (item || 'your item');
  const quantity = qty || 1;
  const canBook  = (business?.services || []).length > 0;
  const buttons  = [
    { id: 'ORDER',    title: '🛒 Place New Order' },
    canBook ? { id: 'BOOK', title: '📅 Book a Table' } : null,
    { id: 'SHOW_MENU', title: '🔄 Start Over' },
  ].filter(Boolean).slice(0, 3);

  return {
    type:    'buttons',
    body:    `✅ *Order placed!*\n\n🍳 *${quantity}× ${name}* — we're preparing it now.\n\nThank you! 😊`,
    buttons,
  };
}

/**
 * buildAdminOrderAlertBody
 * [FIX-BUG11] Shows correct payment mode — no longer hardcodes "Cash / On delivery"
 *             when the business has Wave payment enabled.
 */
export function buildAdminOrderAlertBody({ customerPhone, item, quantity, totalPrice, addOns = [], shortId, business }) {
  const bizName    = business?.name || 'Business';
  const currency   = business?.payment?.currency || 'D';
  const payEnabled = business?.payment?.enabled;
  const addOnStr   = addOns?.length ? `\n➕ Add-ons: ${addOns.join(', ')}` : '';
  const priceStr   = totalPrice ? `\n💰 Total: *${currency}${totalPrice}*` : '';
  const idStr      = shortId ? `\n🔖 Ref: \`${shortId}\`` : '';
  // [FIX-BUG11] Check actual payment configuration; channel-agnostic label
  const paymentMode = payEnabled && totalPrice
    ? `*Screenshot verification pending*`
    : `*Cash / On delivery*`;

  return (
    `🔔 *New Order — ${bizName}*\n\n` +
    `👤 Customer: ${customerPhone}\n` +
    `🍽 *${quantity}× ${item}*${addOnStr}${priceStr}${idStr}\n\n` +
    `💵 *Payment:* ${paymentMode}\n\n` +
    `Status: *Pending* — please prepare.`
  );
}

/** @deprecated — use buildAdminOrderAlertBody */
export function buildAdminOrderAlert(args) {
  return buildAdminOrderAlertBody(args);
}
