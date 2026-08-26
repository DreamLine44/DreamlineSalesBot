/**
 * modules/catalog/waCatalogHelpers.js
 *
 * [CATALOG-NORM] Normalization layer — the ONLY place that translates a Meta
 * WA Catalog product selection into the exact internal shape the existing
 * SELECT_ITEM/SELECT_VARIANT flow steps already produce: session.data =
 * { item: <menuItems subdocument>, variant: <string|null> } (confirmed
 * against src/modules/retail/flows/index.js and mirrored by every other
 * product-selling module — see webhookController.js section 7.5 and
 * waCatalogFlow.js for the call sites).
 *
 * After this module runs, checkout / CRM / analytics / automation / order
 * management all see a completely ordinary in-flow item selection — no
 * `isCatalog` / `fromCatalog` branch exists, or is needed, anywhere
 * downstream of here.
 *
 * Pure functions only — no mongoose, no logger, no network calls — so this
 * file can be unit tested in isolation (see src/tests/waCatalogNormalization.test.mjs).
 *
 * Retailer-ID scheme (this integration's own design choice — Meta does not
 * dictate a format):
 *   Simple item, no variant :  "<menuItem._id>"
 *   Variant-specific entry  :  "<menuItem._id>::<slugified variant name>"
 * This keeps BusinessConfig.menuItems the single source of truth for product
 * data — no parallel retailer_id↔menuItem mapping collection is needed; the
 * mapping is entirely DERIVABLE from data that already exists, which is a
 * simpler and more "single source of truth" design than the spec's suggested
 * mapping subdocument (see ARCHITECTURE discrepancy note in the delivery
 * write-up for the full rationale).
 */

const slugify = (s = '') =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');

/**
 * buildRetailerId(menuItem, variantName?)
 * Used by waCatalogService.js when syncing menuItems into the Meta Commerce
 * Catalog, so the IDs it uploads are exactly what resolveCatalogItem() below
 * can parse back.
 */
export function buildRetailerId(menuItem, variantName = null) {
  const id = String(menuItem?._id || '').trim();
  if (!id) return null;
  return variantName ? `${id}::${slugify(variantName)}` : id;
}

export function parseRetailerId(retailerId = '') {
  const str = String(retailerId || '');
  const sep = str.indexOf('::');
  if (sep === -1) return { menuItemId: str || null, variantSlug: null };
  return { menuItemId: str.slice(0, sep) || null, variantSlug: str.slice(sep + 2) || null };
}

/**
 * resolveCatalogItem(business, retailerId)
 * → { item, variant } | null
 */
export function resolveCatalogItem(business, retailerId) {
  const { menuItemId, variantSlug } = parseRetailerId(retailerId);
  if (!menuItemId) return null;

  const menu = business?.menuItems || [];
  const item = menu.find(i => String(i._id) === menuItemId && i.available !== false);
  if (!item) return null;

  let variant = null;
  if (variantSlug && Array.isArray(item.variants)) {
    const match = item.variants.find(v => slugify(v.name || v) === variantSlug);
    variant = match ? (match.name || match) : null;
  }
  return { item, variant };
}

/**
 * normalizeCatalogSelection(business, metaOrder)
 * → { item, variant, quantity, queuedLines, extraLinesSkipped } | null
 *
 * [CATALOG-NORM-2] The existing flow model (every module under src/modules)
 * is single-item-at-a-time — SELECT_ITEM/SELECT_VARIANT/QUANTITY all hold
 * exactly one `data.item`. Meta's catalog checkout ("order" message) can
 * carry MULTIPLE product_items in one payload if the customer added several
 * products to their WA cart before tapping "Review order". Rather than
 * inventing a parallel multi-item cart representation the rest of the
 * platform doesn't have (a real redesign — explicitly out of scope per the
 * spec's "Core Engineering Philosophy"), the FIRST resolvable line is
 * normalized into the standard single-item flow now, and every OTHER
 * resolvable line is returned as `queuedLines` so the caller
 * (waCatalogFlow.js) can persist them on the session and auto-advance the
 * customer into each one's own single-item flow, in turn, right after the
 * one before it completes — see waCatalogFlow.js drainCatalogQueue().
 *
 * `extraLinesSkipped` now only counts lines that couldn't be matched to any
 * live, available menu item at all (deleted/renamed/unavailable product) —
 * those genuinely can't be recovered automatically, so the caller still
 * tells the customer about them rather than pretending they'll show up.
 */
export function normalizeCatalogSelection(business, metaOrder) {
  const items = Array.isArray(metaOrder?.product_items) ? metaOrder.product_items : [];
  if (!items.length) return null;

  const resolvedLines = [];
  for (const line of items) {
    const resolved = resolveCatalogItem(business, line.product_retailer_id);
    if (!resolved) continue;
    const qty = parseInt(line.quantity, 10);
    resolvedLines.push({
      item:       resolved.item,
      variant:    resolved.variant,
      quantity:   Number.isFinite(qty) && qty > 0 ? qty : 1,
      retailerId: line.product_retailer_id,
    });
  }
  if (!resolvedLines.length) return null; // nothing in the order could be matched to a live menu item

  const [primary, ...rest] = resolvedLines;
  return {
    item:              primary.item,
    variant:           primary.variant,
    quantity:          primary.quantity,
    queuedLines:       rest.map(r => ({ retailerId: r.retailerId, quantity: r.quantity })),
    extraLinesSkipped: items.length - resolvedLines.length,
    // [CATALOG-CART-1] Additive — the full set of resolved lines, in original
    // cart order, untouched by the primary/rest split above. Existing callers
    // that only read item/variant/quantity/queuedLines/extraLinesSkipped are
    // completely unaffected; this exists so a caller that supports true
    // multi-item orders (tenant has multiItemCart.enabled) can build a single
    // Order.items[] array instead of being forced through the primary+queue
    // split, which was designed for the pre-MULTICART-v39 single-item-only
    // flow model and always produces N separate Order documents for an N-item
    // WA cart (see waCatalogFlow.js CATALOG-CART-1 fix for the consumer side).
    resolvedLines: resolvedLines.map(r => ({
      item: r.item, variant: r.variant, quantity: r.quantity, retailerId: r.retailerId,
    })),
  };
}

/**
 * buildCatalogCartItems(resolvedLines)
 * → [{ item, quantity, addOns, unitPrice, menuItemId }, ...]
 *
 * [CATALOG-CART-1] Maps normalizeCatalogSelection()'s resolvedLines (full
 * menuItem docs + resolved variant) into the exact shape orderService.
 * saveOrder()'s `items` parameter expects. Variant-specific lines fold the
 * variant name into the item label (matching how every per-vertical flow
 * already labels a variant-selected item at CONFIRM time, e.g. fashion's
 * `${name} (${size})` pattern in fashion/flows/index.js), since Order.items[]
 * has no separate variant field of its own.
 */
export function buildCatalogCartItems(resolvedLines) {
  return (resolvedLines || []).map(line => ({
    item:       line.variant ? `${line.item.name} (${line.variant})` : line.item.name,
    quantity:   line.quantity,
    addOns:     [],
    unitPrice:  typeof line.item.price === 'number' ? line.item.price : null,
    menuItemId: line.item._id,
  }));
}


/**
 * buildCategorizedSections(business, { maxSections = 10, maxItemsPerSection = 30 } = {})
 * → [{ title, productRetailerIds }] (dispatcher.js's product_list section shape)
 *
 * [CATALOG-UX-CATEGORY] Groups every currently-available menu item into a
 * Meta product_list section per BusinessConfig.menuItems[].category (falling
 * back to a single "Products" section for items with no category set), so a
 * tenant with mains/drinks/desserts or shirts/shoes/accessories gets the
 * categorized WhatsApp browsing UI Meta's catalog picker is actually built
 * for, instead of one flat undifferentiated list.
 *
 * Items with variants are expanded to one row per variant (matching exactly
 * what syncMenuToCatalog() actually uploads to Meta under a variant-specific
 * retailer_id — see [AUDIT-FIX-CATALOG-VARIANT-SYNC] there), since a plain
 * "<menuItemId>" retailer_id was never uploaded for a variant item and would
 * render as a broken/empty row in the customer's WhatsApp UI.
 *
 * Pure function — no network, no mongoose — for the same isolation/testing
 * reasons as the rest of this file. Returns [] (never throws) if there's
 * nothing sellable, so callers can safely fall back to a plain
 * catalog_message browse-all.
 */
/**
 * resolveNextOrderStep(cfg)
 * → stepName (string)
 *
 * [CATALOG-QUEUE-2] Pure extraction of the "what step comes right after
 * SELECT_ITEM in this module's own steps.ORDER array" lookup that both
 * handleCatalogOrderMessage() and drainCatalogQueue() (waCatalogFlow.js) need
 * — retail → SELECT_VARIANT, electronics → ITEM_DETAIL, fashion →
 * SELECT_SIZE, bakery/cosmetics/salon → CART_REVIEW, restaurant → QUANTITY
 * (v40 uses ITEM_ADDED, not CART_REVIEW). Falls back to 'QUANTITY' when the
 * module's ORDER steps don't declare SELECT_ITEM at all, or declare it as the
 * last step — same fallback both call sites already relied on before this was
 * extracted.
 *
 * `cfg` is whatever config/modes.js getModeConfig(business) returns — a
 * plain object, no mongoose/network involved, so this stays a pure,
 * dependency-free function safe to unit test directly.
 */
export function resolveNextOrderStep(cfg) {
  const steps = cfg?.steps?.ORDER || [];
  const idx = steps.indexOf('SELECT_ITEM');
  return (idx !== -1 && idx < steps.length - 1) ? steps[idx + 1] : 'QUANTITY';
}

/**
 * pickNextQueuedLine(business, queue)
 * → { next: { item, variant, quantity } | null, remainingQueue: [...] }
 *
 * [CATALOG-QUEUE-2] Pure extraction of drainCatalogQueue()'s
 * (waCatalogFlow.js) "pop lines off the front of the queue until one
 * re-resolves against the LIVE menu" loop. Re-resolving at drain time
 * (rather than trusting a frozen snapshot from when the WA cart order first
 * arrived) means an item the admin removed/disabled in the meantime is
 * skipped here instead of being force-fed into a flow with a stale/invalid
 * item — the caller decides what (if anything) to tell the customer about
 * lines that never resolve.
 *
 * `queue` is the exact shape persisted on session.pendingCatalogQueue:
 * [{ retailerId, quantity }, ...]. Never mutates the array passed in.
 */
export function pickNextQueuedLine(business, queue) {
  const remaining = Array.isArray(queue) ? [...queue] : [];
  let next = null;
  while (remaining.length && !next) {
    const candidate = remaining.shift();
    const resolved = resolveCatalogItem(business, candidate?.retailerId);
    if (resolved) next = { item: resolved.item, variant: resolved.variant, quantity: candidate.quantity };
  }
  return { next, remainingQueue: remaining };
}

/**
 * buildQueuedFollowUpNote(queuedLines)
 * buildSkippedLinesNote(extraLinesSkipped)
 *
 * [CATALOG-QUEUE-2] Pure extraction of the pluralized note text
 * handleCatalogOrderMessage() (waCatalogFlow.js) appends to the reply body
 * after a multi-item WA cart order. Split into two so each can be unit
 * tested for its own singular/plural grammar independent of the other.
 * Both return '' (no-op string) when there's nothing to report, so callers
 * can always safely append the result.
 */
export function buildQueuedFollowUpNote(queuedLines) {
  const n = Array.isArray(queuedLines) ? queuedLines.length : 0;
  if (!n) return '';
  return `\n\n_(You added ${n} more item${n > 1 ? 's' : ''} — let's finish this one first, then I'll bring up the next automatically!)_`;
}

export function buildSkippedLinesNote(extraLinesSkipped) {
  const n = extraLinesSkipped || 0;
  if (n <= 0) return '';
  return `\n\n_(Heads up — ${n} item${n > 1 ? 's' : ''} from your catalog selection ${n > 1 ? "aren't" : "isn't"} available anymore, so ${n > 1 ? 'they were' : 'it was'} skipped.)_`;
}

/**
 * isSyncableForCatalog(item)
 * → { ok: boolean, reasons: string[] }
 *
 * [CATALOG-SYNC-VALIDATE-1] Sync-time guard so a menu item with no image or
 * an invalid/zero price never reaches Meta's Commerce Catalog in the first
 * place — a listing like that renders broken (no photo, "$0.00" or missing
 * price) directly in front of customers, and Meta's Batch API happily
 * accepts it since price is only type-checked, not range-checked, and
 * image_url is entirely optional as far as the API is concerned. Checked at
 * sync time (syncMenuToCatalog(), waCatalogService.js) rather than at
 * addMenuItem/updateMenuItem time, since a perfectly valid item can still
 * regress later (e.g. an image host takes the URL down) — this way every
 * sync re-validates the current state instead of only catching the problem
 * once at creation.
 *
 * Pure function — no mongoose, no logger, no network — same isolation
 * rationale as the rest of this file (see module header).
 */
export function isSyncableForCatalog(item) {
  const reasons = [];
  const price = Number(item?.price);
  if (!Number.isFinite(price) || price <= 0) reasons.push('invalid_or_zero_price');
  if (!item?.image?.url) reasons.push('missing_image');
  return { ok: reasons.length === 0, reasons };
}

/**
 * [FIX-CATALOG-VISIBLE-SECTIONS-1] buildCategorizedSections() previously
 * filtered only on `available !== false`, NOT on isSyncableForCatalog() — the
 * exact same gate syncMenuToCatalog() (waCatalogService.js) uses to decide
 * what actually gets uploaded to Meta. That mismatch meant a customer-facing
 * "Browse Catalog" message could reference retailer_ids for items that were
 * NEVER pushed to Meta's catalog (missing image / invalid price), since sync
 * silently skips those. Meta has no product to show for an unrecognized
 * retailer_id, so the referenced row (or, depending on Meta's validation,
 * the whole product_list message) renders broken or empty — "catalog not
 * showing items" from the customer's side, even though sync itself reports
 * Healthy. Filtering here with the same isSyncableForCatalog() check keeps
 * the customer-facing message in lockstep with what's actually live in
 * Meta's catalog at all times, with zero extra network calls (pure, same
 * BusinessConfig.menuItems data already in memory).
 */

/**
 * [FIX-CATALOG-CONFIRMED-ONLY] isSyncableForCatalog() above (and the
 * [FIX-CATALOG-VISIBLE-SECTIONS-1] filter using it) only proves an item is
 * LOCALLY eligible to sync (has an image, a valid price) — it says nothing
 * about whether Meta has actually confirmed that specific retailer_id live
 * in its catalog yet. That's a separate, async state: as of
 * [FIX-CATALOG-OPTIMISTIC-CONFIRM] in waCatalogService.js,
 * business.waCatalog.syncedRetailerIds only gains an entry once
 * syncMenuToCatalog()'s batch-handle check resolves clean — a batch that's
 * still pending, or that Meta rejected per-item, leaves the retailer_id out
 * of that set even though isSyncableForCatalog() happily says "ok".
 *
 * Without this filter, a product_list message could reference retailer_ids
 * Meta has never confirmed — which Meta responds to with GRAPH_ERROR 400
 * "(#131009) ... None of the products provided could be sent," rejecting
 * the ENTIRE message, not just the bad rows. This was reproduced live: a
 * tenant with 25 locally-valid menu items but only 10 actually confirmed in
 * Meta's catalog (the other 15 stuck pending batch verification) had every
 * "Browse Catalog" tap fail and fall back to the generic unavailable
 * message, while /wacatalog/health still reported itemsReady: 25.
 *
 * Intersecting against the confirmed set here means: if nothing is
 * confirmed yet (fresh tenant, first sync still in flight), this returns
 * [] and sendCatalogMessage()'s caller falls back to a full catalog_message
 * browse-all — which references no retailer_ids at all and just opens
 * whatever Meta already has live, so it can never hit this same failure.
 */
export function buildCategorizedSections(business, { maxSections = 10, maxItemsPerSection = 30 } = {}) {
  const confirmedIds = new Set(business?.waCatalog?.syncedRetailerIds || []);
  const menu = (business?.menuItems || []).filter(i => i.available !== false && isSyncableForCatalog(i).ok);
  if (!menu.length) return [];

  const byCategory = new Map(); // categoryTitle -> productRetailerIds[]
  for (const item of menu) {
    const variants = Array.isArray(item.variants) ? item.variants : [];
    const rows = variants.length
      ? variants
          .map(v => (v && typeof v === 'object') ? v.name : v)
          .filter(Boolean)
          .map(variantName => buildRetailerId(item, variantName))
          .filter(Boolean)
      : [buildRetailerId(item)].filter(Boolean);
    const confirmedRows = rows.filter(id => confirmedIds.has(id));
    if (!confirmedRows.length) continue;

    const title = String(item.category || 'Products').trim().slice(0, 24) || 'Products';
    if (!byCategory.has(title)) byCategory.set(title, []);
    byCategory.get(title).push(...confirmedRows);
  }

  return [...byCategory.entries()]
    .slice(0, maxSections)
    .map(([title, productRetailerIds]) => ({
      title,
      productRetailerIds: productRetailerIds.slice(0, maxItemsPerSection),
    }));
}
