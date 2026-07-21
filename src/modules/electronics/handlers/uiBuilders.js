/**
 * modules/electronics/handlers/uiBuilders.js
 *
 * UI helper functions for the Electronics module.
 *
 * Electronics UX is distinct from restaurant/retail in several ways:
 *   1. Products are always shown with specs + price together (not just name)
 *   2. Category browsing is the PRIMARY entry point (not raw item lists)
 *   3. Item detail cards include warranty, compatibility notes, and condition
 *   4. The comparison view is a first-class feature
 *   5. Admin alerts carry fulfilment mode (pickup vs delivery)
 */

import { buildWhatsAppImageUrl } from '../../../config/cloudinary.js';

// ─────────────────────────────────────────────────────────────────────────────
// Category UI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildCategoryUI — shows available product categories as a list.
 * Falls through to full product list if no categories are set.
 */
export function buildCategoryUI(categories, business) {
  const rows = categories.map((cat, i) => ({
    id:    `CAT_${cat.toUpperCase().replace(/\s+/g, '_')}`,
    title: cat.slice(0, 24),
  }));

  return {
    type:        'list',
    header:      business?.name || 'Electronics Store',
    body:        '📱 *Browse by category* — or type a product name to search directly:',
    buttonLabel: 'View Categories',
    rows,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Product catalogue (flat list)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildProductList — paginated flat list of all available products.
 * Includes price and a short spec snippet per row.
 */
export function buildProductList(items, business, categoryLabel = null) {
  if (!items.length) {
    return {
      type:    'buttons',
      body:    '⚠️ Our catalogue is being updated. Please check back soon or contact us.',
      buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }],
    };
  }

  const header   = categoryLabel
    ? `${categoryLabel} — ${business?.name || 'Products'}`
    : business?.name || 'Products';
  const currency = business?.payment?.currency || 'D';

  // [AUDIT-FIX-LISTCAP] No build-time slice — dispatcher.js chunks a flat
  // `rows` array across multiple WhatsApp sections (10/section, up to the
  // real 100-row ceiling) instead of truncating, see [FIX-LIST-TRUNC] in
  // core/whatsapp/dispatcher.js. Previously items past #10 were silently
  // invisible with only a "Showing 10 of N" note as a hint.
  const rows = items.map((item, i) => {
    const priceStr = item.price ? `${currency}${item.price}` : '';
    const specStr  = item.specs?.short || item.description || '';
    const detail   = [priceStr, specStr].filter(Boolean).join(' · ').slice(0, 72);
    return {
      id:          String(i + 1),
      title:       item.name.slice(0, 24),
      description: detail,
    };
  });

  return {
    type:        'list',
    header,
    body:        categoryLabel
      ? `Here are our *${categoryLabel}* products:`
      : "Here's our full product range — tap to view details:",
    buttonLabel: 'Browse Products',
    rows,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Item detail card
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildItemDetail — rich product card with spec block, price, warranty, and stock note.
 * This is the "product page" equivalent on WhatsApp.
 */
export function buildItemDetail(item, currency = 'D') {
  const lines = [];

  lines.push(`📱 *${item.name}*`);

  if (item.price)       lines.push(`💰 Price: *${currency}${item.price}*`);
  if (item.condition)   lines.push(`📦 Condition: *${item.condition}*`); // New / Refurbished / Open Box

  // Specs block — supports both a structured object and plain description
  if (item.specs && typeof item.specs === 'object') {
    const specLines = Object.entries(item.specs)
      .filter(([k]) => k !== 'short')               // 'short' is our internal summary key
      .map(([k, v]) => `  • *${_titleCase(k)}:* ${v}`)
      .slice(0, 8);                                  // cap at 8 spec lines for readability
    if (specLines.length) {
      lines.push('\n📋 *Specifications:*');
      lines.push(specLines.join('\n'));
    }
  } else if (item.description) {
    lines.push(`\n📋 *Details:* ${item.description}`);
  }

  if (item.warranty)    lines.push(`\n🛡 *Warranty:* ${item.warranty}`);
  if (item.compatible)  lines.push(`🔌 *Compatible with:* ${item.compatible}`);
  if (item.inStock === false) lines.push('\n⚠️ *Currently out of stock — order for back-order*');

  lines.push('\nWould you like to order this item?');

  const detailCard = {
    type: 'buttons',
    body: lines.join('\n'),
    buttons: [
      { id: 'CONFIRM_ITEM', title: '🛒 Order This'       },
      { id: 'SPEC_REQUEST', title: '❓ Ask a Question'    },
      { id: 'SHOW_MENU',    title: '🔄 Browse More'       },
    ],
  };

  // [FEAT-CATALOG-IMAGES] Same pattern as restaurant/retail/fashion — the
  // tenant's uploaded photo is stored correctly regardless of vertical, but
  // electronics never actually sent it to the customer before.
  const imageUrl = item?.image?.url;
  if (imageUrl && item?.showImageOnSelect !== false) {
    return [
      {
        type:    'image',
        url:     buildWhatsAppImageUrl(imageUrl),
        caption: `*${item.name}*${item.price ? ` — ${currency}${item.price}` : ''}`,
      },
      detailCard,
    ];
  }
  return detailCard;
}

// ─────────────────────────────────────────────────────────────────────────────
// Order summary
// ─────────────────────────────────────────────────────────────────────────────

export function buildOrderSummary({ item, qty, total, fulfilment, business }) {
  const currency    = business?.payment?.currency || 'D';
  const itemName    = typeof item === 'object' ? item.name : item;
  const fulfilLine  = fulfilment === 'DELIVERY'
    ? '\n🚚 *Fulfilment:* Delivery'
    : '\n🏪 *Fulfilment:* In-store pick-up';

  return {
    type: 'buttons',
    body:
      `🧾 *Order Summary*\n\n` +
      `📱 *${qty}× ${itemName}*` +
      (total ? `\n💰 Total: *${currency}${total}*` : '') +
      fulfilLine +
      `\n\nReady to confirm?`,
    buttons: [
      { id: 'CONFIRM', title: '✅ Confirm Order' },
      { id: 'CANCEL',  title: '❌ Cancel'         },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Order success
// ─────────────────────────────────────────────────────────────────────────────

export function buildOrderSuccess({ item, qty, fulfilment, business }) {
  const itemName = typeof item === 'object' ? item.name : (item || 'your item');
  const quantity = qty || 1;
  const pickup   = fulfilment === 'PICKUP';

  const afterLine = pickup
    ? '🏪 We\'ll prepare it for *pick-up*. Our team will confirm when it\'s ready.'
    : '🚚 We\'ll confirm delivery details with you shortly.';

  return {
    type: 'buttons',
    body:
      `✅ *Order received!*\n\n` +
      `📱 *${quantity}× ${itemName}*\n\n` +
      `${afterLine}\n\n` +
      `Thank you for choosing us! 📱`,
    buttons: [
      { id: 'ORDER',        title: '🛒 Shop More'       },
      { id: 'SPEC_REQUEST', title: '📋 Tech Questions'  },
      { id: 'SHOW_MENU',    title: '🔄 Start Over'      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison card
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildComparisonCard — side-by-side spec comparison for two products.
 * WhatsApp has no columns, so we format as a clean two-column text block.
 */
export function buildComparisonCard(itemA, itemB, currency = 'D') {
  const nameA = itemA.name.slice(0, 20);
  const nameB = itemB.name.slice(0, 20);

  const lines = [
    `⚖️ *Product Comparison*\n`,
    `┌─────────────────────────────┐`,
    `│ 📱 *${nameA.padEnd(20)}*  vs  *${nameB}*`,
    `└─────────────────────────────┘\n`,
  ];

  // Price row
  const priceA = itemA.price ? `${currency}${itemA.price}` : 'N/A';
  const priceB = itemB.price ? `${currency}${itemB.price}` : 'N/A';
  lines.push(`💰 *Price:*\n  ${nameA}: *${priceA}*\n  ${nameB}: *${priceB}*\n`);

  // Shared spec keys
  const specsA = (typeof itemA.specs === 'object' && itemA.specs) ? itemA.specs : {};
  const specsB = (typeof itemB.specs === 'object' && itemB.specs) ? itemB.specs : {};
  const allKeys = [...new Set([...Object.keys(specsA), ...Object.keys(specsB)])].filter(k => k !== 'short').slice(0, 6);

  for (const key of allKeys) {
    const valA = specsA[key] || '—';
    const valB = specsB[key] || '—';
    lines.push(`📋 *${_titleCase(key)}:*\n  ${nameA}: ${valA}\n  ${nameB}: ${valB}\n`);
  }

  // Warranty
  if (itemA.warranty || itemB.warranty) {
    lines.push(`🛡 *Warranty:*\n  ${nameA}: ${itemA.warranty || '—'}\n  ${nameB}: ${itemB.warranty || '—'}\n`);
  }

  // Description fallback if no structured specs
  if (!allKeys.length) {
    if (itemA.description) lines.push(`📝 *${nameA}:* ${itemA.description}`);
    if (itemB.description) lines.push(`📝 *${nameB}:* ${itemB.description}`);
  }

  lines.push('\nWhich would you like to order?');

  return {
    type: 'buttons',
    body: lines.join('\n'),
    buttons: [
      { id: `PICK_A_${itemA._id || '0'}`, title: `🛒 ${nameA.slice(0, 15)}`  },
      { id: `PICK_B_${itemB._id || '1'}`, title: `🛒 ${nameB.slice(0, 15)}`  },
      { id: 'SHOW_MENU',                   title: '🔄 Browse More'            },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin alert
// ─────────────────────────────────────────────────────────────────────────────

export function buildAdminOrderAlertBody({ customerPhone, item, quantity, totalPrice, fulfilment, shortId, business }) {
  const bizName    = business?.name || 'Electronics Store';
  const currency   = business?.payment?.currency || 'D';
  const payEnabled = business?.payment?.enabled;
  const priceStr   = totalPrice ? `\n💰 Total: *${currency}${totalPrice}*` : '';
  const idStr      = shortId    ? `\n🔖 Ref: \`${shortId}\`` : '';
  const fulfilStr  = fulfilment === 'DELIVERY' ? '🚚 Delivery' : '🏪 In-store pick-up';
  const payMode    = payEnabled && totalPrice
    ? '*Screenshot verification pending*'
    : '*Cash / COD*';

  return (
    `🔔 *New Order — ${bizName}*\n\n` +
    `👤 Customer: ${customerPhone}\n` +
    `📱 *${quantity}× ${item}*${priceStr}${idStr}\n` +
    `📦 *Fulfilment:* ${fulfilStr}\n` +
    `💵 *Payment:* ${payMode}\n\n` +
    `Status: *Pending* — please verify stock.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function _titleCase(str) {
  return String(str).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
