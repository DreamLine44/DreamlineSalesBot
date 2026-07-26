/**
 * utils/itemLabel.js
 *
 * [AUDIT-FIX-CATALOG-VARIANT-LOSS] Shared helper for folding a selected
 * variant into an item's display/save name.
 *
 * Background: waCatalogHelpers.resolveCatalogItem() resolves a WA Catalog
 * "product_retailer_id" into { item, variant } for EVERY vertical alike —
 * the retailer-id scheme (<menuItemId> or <menuItemId>::<slug>) and
 * buildCategorizedSections() both operate generically on item.variants for
 * every module, with no per-vertical special-casing (see waCatalogFlow.js /
 * waCatalogHelpers.js module headers). waCatalogFlow.js then hands off
 * `data.variant` into session.data for whichever module owns the flow.
 *
 * Only retail (SELECT_VARIANT) and fashion (SELECT_SIZE) actually have a
 * flow step of their own that captures a variant-like choice, so only those
 * two modules were folding it into the saved/displayed item name. Every
 * other product-selling module (restaurant, bakery, delivery, salon,
 * electronics) has no variant-specific field or step at all — a WA Catalog
 * order for a variant item landed in session.data.variant, was never read
 * anywhere in that module's CONFIRM/saveOrder/admin-alert code, and was
 * silently lost: the saved Order, the customer-facing summary, and the
 * admin alert all showed the bare item name with no indication of which
 * variant (e.g. size) the customer actually picked.
 *
 * This is purely additive — for any flow reached by the normal in-chat
 * SELECT_ITEM path, data.variant is simply undefined and this returns the
 * item name unchanged.
 */
export function itemLabel(item, variant) {
  const name = typeof item === 'object' && item ? item.name : item;
  return variant ? `${name} (${variant})` : (name || '');
}
