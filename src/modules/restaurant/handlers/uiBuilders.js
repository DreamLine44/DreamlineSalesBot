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
  // [FIX-LIST-CAP-2] This is a flat, uncategorised list — unlike bakery/
  // electronics/cosmetics, the restaurant module has no category browsing
  // step to naturally keep any one list under Meta's real 10-row-total cap.
  // dispatcher.js now truncates to 10 and adds a footer hint rather than
  // rejecting the send, but a menu with more than 10 items will still hide
  // items past #10 from this view — add category browsing here (mirroring
  // _buildCategoryUI in bakery/orderFlow.js) if that becomes a problem.
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

export function buildOrderSummary({ item, qty, total, addOns = [], business, allowAddMore = false }) {
  const name     = typeof item === 'object' ? item.name : item;
  const currency = business?.payment?.currency || 'D';
  const addOnStr = addOns.length ? `\n➕ Add-ons: ${addOns.join(', ')}` : '';
  const buttons  = [{ id: 'CONFIRM', title: '✅ Confirm Order' }];
  // [MULTICART-v39-PHASE2] Additive — only shown when the caller explicitly
  // opts in (orderFlow.js's CONFIRM step, once an item has reached this
  // summary). Existing callers that don't pass allowAddMore keep the exact
  // original two-button shape.
  if (allowAddMore) buttons.push({ id: 'ADD_ANOTHER_ITEM', title: '➕ Add Another Item' });
  buttons.push({ id: 'CANCEL', title: '❌ Cancel' });
  return {
    type: 'buttons',
    body: `🧾 *Order Summary*\n\n🍽 *${qty}× ${name}*${addOnStr}${total ? `\n💰 Total: *${currency}${total}*` : ''}\n\nConfirm your order?`,
    buttons,
  };
}

/**
 * buildCartSummaryUI
 * [MULTICART-v39-PHASE2] Multi-item counterpart to buildOrderSummary() — used
 * by CART_REVIEW (orderFlow.js) once 2+ distinct items have been added to
 * data.cart, whether from a single "2 burgers and a coke" message or from
 * repeated "Add Another Item" taps. `summaryText` is pre-built by
 * core/shared/cartEngine.js's formatCartSummary() so pricing/formatting stays
 * identical to the WA-Catalog multi-item cart summary.
 */
export function buildCartSummaryUI({ summaryText, total, business, note = '' }) {
  const currency = business?.payment?.currency || 'D';
  return {
    type: 'buttons',
    body: `🧾 *Your Order*\n\n${summaryText}${total != null ? `\n\n💰 Total: *${currency}${total}*` : ''}${note}\n\nReady to checkout, or add something else?`,
    buttons: [
      { id: 'CONFIRM',          title: '✅ Checkout'       },
      { id: 'ADD_ANOTHER_ITEM', title: '➕ Add More'        },
      { id: 'CANCEL',           title: '❌ Cancel'          },
    ],
  };
}

/**
 * buildItemAddedUI
 * [MULTICART-v40-EDIT] Shown immediately after ANY item is added to the cart
 * (single item, browsed one at a time). Replaces the old per-item "Confirm
 * Order?" summary (buildOrderSummary) as the default post-add prompt — the
 * customer is only asked whether they want to keep shopping or move to
 * checkout, never asked to "confirm" an individual line.
 */
export function buildItemAddedUI({ item, qty, business, cartCount }) {
  const name = typeof item === 'object' ? item.name : item;
  const countNote = cartCount ? `\n\n🛒 *${cartCount} item${cartCount > 1 ? 's' : ''}* in your cart so far.` : '';
  return {
    type: 'buttons',
    body: `✅ Added *${qty}× ${name}* to your cart.${countNote}\n\nWould you like to add another item?`,
    buttons: [
      { id: 'ADD_ANOTHER_ITEM', title: '➕ Add Another Item' },
      { id: 'REVIEW_CART',      title: '🧾 Review & Checkout' },
    ],
  };
}

/**
 * buildItemsAddedUI
 * [MULTICART-v40-EDIT] Multi-line counterpart to buildItemAddedUI — used when
 * a single typed message resolved to 2+ distinct menu lines at once (e.g.
 * "2 burgers and a coke").
 */
export function buildItemsAddedUI({ addedSummary, business, cartCount, note = '' }) {
  const countNote = cartCount ? `\n\n🛒 *${cartCount} item${cartCount > 1 ? 's' : ''}* in your cart so far.` : '';
  return {
    type: 'buttons',
    body: `✅ Added to your cart:\n${addedSummary}${countNote}${note}\n\nWould you like to add another item?`,
    buttons: [
      { id: 'ADD_ANOTHER_ITEM', title: '➕ Add Another Item' },
      { id: 'REVIEW_CART',      title: '🧾 Review & Checkout' },
    ],
  };
}

/**
 * buildCartReviewUI
 * [MULTICART-v40-EDIT] The single consolidated order summary — shown once,
 * when the customer is done adding items. Exactly the 3 actions requested:
 * Confirm / Edit / Cancel. Replaces buildCartSummaryUI as the checkout-time
 * screen (buildCartSummaryUI is kept for backward compatibility / tests but
 * is no longer used for the final review).
 */
export function buildCartReviewUI({ summaryText, total, itemCount, business, note = '' }) {
  const currency = business?.payment?.currency || 'D';
  const countLine = itemCount != null ? `\nItems: *${itemCount}*` : '';
  return {
    type: 'buttons',
    body: `🧾 *Order Summary*\n\n${summaryText}\n${'━'.repeat(10)}${countLine}${total != null ? `\nTotal: *${currency}${total}*` : ''}${note}\n\nWould you like to confirm this order?`,
    buttons: [
      { id: 'CONFIRM',    title: '✅ Confirm Order' },
      { id: 'EDIT_CART',  title: '✏️ Edit Order'    },
      { id: 'CANCEL',     title: '❌ Cancel Order'  },
    ],
  };
}

/**
 * buildEditCartMenuUI
 * [MULTICART-v40-EDIT] Top-level Edit Order menu — list message so all 6
 * actions fit (interactive buttons are capped at 3).
 */
export function buildEditCartMenuUI() {
  return {
    type:        'list',
    header:      'Edit Order',
    body:        'What would you like to change?',
    buttonLabel: 'Choose an action',
    rows: [
      { id: 'EDIT_ADD',       title: '➕ Add Item',         description: 'Browse the menu and add another item' },
      { id: 'EDIT_REMOVE',    title: '➖ Remove Item',      description: 'Take an item out of your cart' },
      { id: 'EDIT_INCREASE',  title: '🔼 Increase Quantity', description: 'Add more of an item already in your cart' },
      { id: 'EDIT_DECREASE',  title: '🔽 Decrease Quantity', description: 'Reduce the quantity of an item' },
      { id: 'EDIT_CLEAR',     title: '🗑️ Clear Cart',       description: 'Empty your entire cart' },
      { id: 'EDIT_BACK',      title: '⬅️ Back to Summary',  description: 'Return to the order summary' },
    ],
  };
}

/**
 * buildEditCartPickerUI
 * [MULTICART-v40-EDIT] Numbered cart list shown when the customer picks
 * Remove/Increase/Decrease from the Edit Order menu — they reply with the
 * line number to act on.
 */
export function buildEditCartPickerUI({ numberedSummary, actionLabel }) {
  return {
    type: 'text',
    body: `${numberedSummary}\n\nReply with the *number* of the item you'd like to ${actionLabel}, or type *back* to return to the Edit Order menu.`,
  };
}

export function buildOrderSuccess({ item, qty, business }) {
  const name     = typeof item === 'object' ? item.name : (item || 'your item');
  const quantity = qty || 1;

  // [FIX-GOODBYE-1] Previously bundled "Place New Order / Book a Table / Start
  // Over" buttons into the SAME message as the thank-you — the bot said goodbye
  // and immediately asked "what would you like to do next?" in one breath,
  // which read as fake/contradictory to customers. This now ends the message
  // as a genuine close: plain text, no buttons. The conversation only resumes
  // if the customer messages again, via the normal returning-customer greeting
  // path in moduleRouter.js.
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
