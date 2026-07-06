/**
 * modules/restaurant/handlers/uiBuilders.js
 *
 * [FIX-BUG11] buildAdminOrderAlertBody no longer hardcodes "Cash / On delivery".
 *             It now checks payment.enabled to show the correct payment mode.
 * [FIX-BUG14] buildMenuUI returns a Contact Us button on empty menu (not plain text).
 *
 * [AUDIT-FIX-ROWCAP-REVERT] v23 briefly added a slice(0, 10) cap + "Showing X of Y"
 * footer here, copying a pattern seen in bakery/cosmetics/retail/salon/electronics/
 * services. That was a mistake: core/whatsapp/dispatcher.js's own [FIX-LIST-TRUNC]
 * already takes a flat `rows` array from any module and chunks it into up to 10
 * sections × 10 rows (100 rows total) instead of truncating at 10. Capping here
 * pre-emptively threw away rows 11+ before the dispatcher ever got a chance to
 * place them in a second section — actively defeating that fix and hiding real
 * menu items behind a misleading "Showing 10 of 15" message. Restaurant's
 * buildMenuUI needs no cap at all; it should hand the dispatcher the full row
 * list and let it handle sectioning. Reverted to the uncapped form.
 *
 * NOTE (historical — resolved): this comment previously flagged bakery, cosmetics,
 * retail, salon, and electronics as still having their own build-time slice(0, 10)
 * + overflow-footer logic. That has since been fixed in each of those modules
 * (see their own AUDIT-FIX-1/2/3/4/6/8 comments) — they now hand dispatcher.js the
 * full flat `rows` array and let [FIX-LIST-TRUNC] do the chunking, same as here.
 * Left in place only so a future audit doesn't have to re-derive that this class
 * of bug was checked across every module, not just this one.
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
  // No cap here — dispatcher.js's [FIX-LIST-TRUNC] chunks the flat rows array
  // into WhatsApp-valid sections (≤10 rows/section, ≤10 sections) on its own.
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
  const bizName  = business?.name || 'us';

  // [FIX-GOODBYE-1] Previously this bundled "Place New Order / Book a Table /
  // Start Over" buttons into the SAME message as the thank-you — so the bot
  // said goodbye and immediately asked "what next?" in one breath, which read
  // as contradictory. A real goodbye ends the conversation; it only resumes
  // if and when the customer sends another message (handled by the normal
  // returning-customer greeting path in moduleRouter.js).
  return {
    type: 'text',
    body: `✅ *Order placed!*\n\n🍳 *${quantity}× ${name}* — we're preparing it now.\n\nEnjoy your meal! Message us anytime if you need anything. 😊\n— *${bizName}*`,
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
