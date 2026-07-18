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
  const rows = items.map((item, i) => ({
    id:          String(i + 1),
    title:       item.name.slice(0, 24),
    description: [item.description, item.price ? `${business?.payment?.currency || 'D'}${item.price}` : ''].filter(Boolean).join(' — ').slice(0, 72),
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
      { id: 'CANCEL',  title: '❌ Cancel'        },
    ],
  };
}

export function buildOrderSuccess({ item, qty, business }) {
  const name     = typeof item === 'object' ? item.name : (item || 'your item');
  const quantity = qty || 1;

  // [FIX-GOODBYE-1] Previously this bundled "Place New Order / Book a Table /
  // Start Over" buttons into the SAME message as the order-placed thank-you —
  // the bot said goodbye and immediately asked "what would you like to do
  // next?" in one breath, which read as fake/contradictory to customers.
  // Fix: end as a genuine close (plain text, no buttons). The conversation
  // only resumes if the customer messages again, via the normal
  // returning-customer greeting path in moduleRouter.js.
  return {
    type: 'text',
    body: `✅ *Order placed!*\n\n🍳 *${quantity}× ${name}* — we're preparing it now.\n\nThank you! 😊`,
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
