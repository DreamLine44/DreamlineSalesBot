/**
 * modules/catalog/waCatalogFlow.js
 *
 * AI-triggered "show catalog" branch + handoff back into the vertical
 * module's existing ORDER flow. This is the ONLY file that touches session
 * state for WA Catalog, and it reuses session.currentFlow/step/data exactly
 * as every other module does (see core/conversations/flowEngine.js) — no
 * new session fields were added anywhere for this integration.
 *
 * Two entry points:
 *
 *   offerCatalogOnStartOrder({ session, business, tenant, intent })
 *     Called from the moduleRegistry.js START_ORDER action override (see
 *     [CATALOG-REG-1] there). Sends the WA Catalog message and returns
 *     { offered: true } when it did, or { offered: false } when WA Catalog
 *     doesn't apply — the override then falls through to the exact same
 *     startFlow({ flowName: 'ORDER', ... }) call this codebase already ran
 *     for every tenant before this integration existed. { offered: false }
 *     is also returned on ANY failure (disabled tenant, no catalogId, Graph
 *     API error) — this IS the "silent fallback" the spec's Failure Handling
 *     section requires: WA Catalog can never become a single point of
 *     failure for a sale.
 *
 *   handleCatalogOrderMessage({ session, business, tenant, catalogOrder })
 *     Called from webhookController.js section 7.5 when a customer's WA
 *     Catalog checkout arrives as a Meta 'order' message. Normalizes the
 *     selection (waCatalogHelpers.js) and hands off into the SAME ORDER-flow
 *     step a typed/tapped SELECT_ITEM match would reach next — computed
 *     generically from each module's own `steps.ORDER` array (config/modes.js
 *     → each module's exported CONFIG), so this file needs ZERO per-vertical
 *     special-casing and no vertical module file under src/modules/{restaurant,
 *     retail,...} ever needs to import or know WA Catalog exists.
 */

import { updateSession, getSession } from '../../core/sessions/sessionService.js';
import { advance }                   from '../../core/conversations/flowEngine.js';
import { getModeConfig }             from '../../config/modes.js';
import { shouldOfferCatalog }        from './waCatalogConfig.js';
import { sendCatalogMessage }        from './waCatalogService.js';
import {
  normalizeCatalogSelection,
  resolveNextOrderStep, pickNextQueuedLine,
  buildQueuedFollowUpNote, buildSkippedLinesNote,
} from './waCatalogHelpers.js';
import logger                        from '../../config/logger.js';

// [CATALOG-UX-BUTTON] Shared by offerCatalogOnStartOrder() (automatic offer)
// and browseCatalogExplicit() (explicit "🛍 Browse Catalog" button tap) —
// both end with the exact same "send the catalog, then arm the session to
// receive the eventual 'order' webhook message" sequence; only the caller
// and the reason for reaching it differ.
async function sendAndArmCatalog(session, business, tenant) {
  const sent = await sendCatalogMessage(session.customerPhone, business, tenant);
  if (!sent) return false; // [Failure handling] silent fallback

  // [CATALOG-FLOW-1] Mark the flow active + awaiting a catalog selection so:
  //   (a) a customer who types instead of using the catalog UI is still
  //       inside a normal ORDER flow — MFQ / intent detection / everything
  //       else behaves exactly as it would mid-ORDER for any other tenant, and
  //   (b) the eventual 'order' webhook message has a currentFlow to attach to.
  // step stays at the module's own first ORDER step (BROWSE_CATEGORY /
  // SELECT_ITEM, whichever the module defines first) rather than a
  // catalog-specific step name — if the customer abandons the WA Catalog UI
  // and types instead, they land exactly where a fresh "Shop Now" tap would
  // have put them, with no special-cased step for any module to handle.
  const cfg = getModeConfig(business);
  const firstStep = cfg?.steps?.ORDER?.[0] || null;
  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'ORDER', step: firstStep, data: {}, menuViewed: false,
  });
  return true;
}

/**
 * offerCatalogOnStartOrder({ session, business, tenant, intent })
 * → { offered: boolean }
 */
export async function offerCatalogOnStartOrder({ session, business, tenant, intent }) {
  if (!shouldOfferCatalog({ business, intent })) return { offered: false };

  try {
    const offered = await sendAndArmCatalog(session, business, tenant);
    return { offered };
  } catch (err) {
    logger.warn('[WACatalog] offerCatalogOnStartOrder failed — falling back to normal ORDER flow', {
      err: err.message, tenantId: business?.tenantId,
    });
    return { offered: false };
  }
}

/**
 * browseCatalogExplicit({ session, business, tenant })
 * [CATALOG-UX-BUTTON] Explicit trigger for the "🛍 Browse Catalog" button now
 * shown on the welcome/main menu (see waCatalogConfig.js
 * shouldShowCatalogButton() and moduleRouter.js GREET/SHOW_MENU cases) — a
 * customer who taps it always sees WA Catalog, independent of
 * waCatalog.mode/AI intent classification, since a direct tap is an
 * unambiguous "show me the catalog" signal on its own. This is also the
 * concrete trigger MANUAL_ONLY mode was documented as reserving room for.
 *
 * [CATALOG-ONLY-1] This function is ONLY ever reached for a tenant where
 * isCatalogEnabled(business) && hasSellableProducts(business) are both true
 * — every caller (moduleRouter.js VIEW_MENU and BROWSE_CATALOG cases) gates
 * on that same check before importing/calling this file, and the welcome
 * button that leads here (shouldShowCatalogButton()) uses the identical
 * condition. A tenant who never enabled WA Catalog never reaches this
 * function at all, and keeps their normal text/list ORDER menu untouched.
 *
 * Previously a Graph API send failure here fell back to the module's own
 * text/list ORDER menu (startFlow('ORDER')) — which meant a catalog-enabled
 * tenant's "View Menu"/"Browse Catalog" could silently look identical to a
 * plain text-menu tenant on any hiccup. By explicit product decision,
 * catalog-enabled tenants no longer have a text-menu fallback at all: on
 * failure this now returns a distinct "catalog unavailable, try again"
 * message instead of ever rendering the text/list menu.
 * → UIResponse (never null — always a message the customer sees, either the
 * catalog send confirmation or the retry notice below).
 */
export async function browseCatalogExplicit({ session, business, tenant }) {
  try {
    const offered = await sendAndArmCatalog(session, business, tenant);
    if (offered) return null; // catalog message already dispatched — nothing further to send
  } catch (err) {
    logger.warn('[WACatalog] browseCatalogExplicit failed', { err: err.message, tenantId: business?.tenantId });
  }
  // [CATALOG-ONLY-1] No text-menu fallback for catalog-enabled tenants —
  // surface an honest "temporarily unavailable" notice with a retry, rather
  // than silently rendering the text/list ORDER menu instead.
  return {
    type: 'buttons',
    body: '🛍 Our product catalog is temporarily unavailable. Please try again in a moment.',
    buttons: [
      { id: 'BROWSE_CATALOG', title: '🔄 Try Again' },
      { id: 'SUPPORT',        title: '💬 Get Help'  },
    ],
  };
}

/**
 * handleCatalogOrderMessage({ session, business, tenant, catalogOrder })
 * → UIResponse (same shape flowEngine.advance() returns)
 */
export async function handleCatalogOrderMessage({ session, business, tenant, catalogOrder }) {
  const normalized = normalizeCatalogSelection(business, catalogOrder);

  if (!normalized) {
    logger.info('[WACatalog] order message could not be matched to any live menu item', {
      tenantId: business?.tenantId, catalogId: catalogOrder?.catalog_id,
    });
    return {
      type: 'buttons',
      body: "We couldn't match that selection to a current product — sorry about that! Let's find it another way.",
      buttons: [
        { id: 'ORDER',   title: '🛍 Browse Products' },
        { id: 'SUPPORT', title: '💬 Get Help'         },
      ],
    };
  }

  // [CATALOG-CART-1] [FIX-CATALOG-QUEUE-DEADEND] Consolidate into ONE Order
  // for EVERY multi-line WA Catalog checkout, regardless of
  // business.multiItemCart.enabled.
  //
  // Previously this was gated on multiItemCart.enabled, on the assumption
  // that opted-out tenants would fall through to the "sequential
  // single-item-flow-per-line queue" below and each queued line would be
  // auto-drained one after another via drainCatalogQueue(). That assumption
  // was wrong: drainCatalogQueue() is only ever invoked when
  // session.postFlowAck === 'ORDER_CONFIRMED' (see webhookController.js and
  // postFlowHandler.js call sites), and postFlowAck is only ever set to
  // 'ORDER_CONFIRMED' by an ADMIN action — adminCommandService.js's
  // confirmPayment()/approve flow or dashboardController.js's manual
  // confirmation. Nothing sets it automatically when a customer simply adds
  // an item to their cart mid-flow. So for any opted-out tenant, a WA cart
  // with 2+ items processed ONLY the first line through the per-vertical
  // module's own single-item ORDER flow (SELECT_ITEM/QUANTITY/UPSELL/...,
  // which folds into that module's own in-chat data.cart) — every other
  // line just sat in session.pendingCatalogQueue, forgotten, unless and
  // until an admin happened to confirm some unrelated order for that same
  // customer. Worse, because the primary item is handed off into the exact
  // same in-chat data.cart the module's own typed-order flow uses, the
  // customer could end up looking at a confirmation screen built from
  // whatever was already sitting in data.cart from an earlier, unrelated
  // conversation — never the catalog cart they actually just sent, and
  // never matching its total.
  //
  // Consolidating unconditionally here means a native WhatsApp cart checkout
  // always becomes exactly one Order, built directly from the exact lines
  // and quantities the customer saw in "Your cart" and tapped "Send to
  // business" for — with no queue, no drain dependency, and no risk of
  // colliding with unrelated session state.
  if (normalized.resolvedLines.length > 1) {
    return handleMultiItemCatalogOrder({ session, business, tenant, normalized });
  }

  const { item, variant, quantity, queuedLines, extraLinesSkipped } = normalized;

  // [CATALOG-FLOW-2] Resume at the step immediately AFTER 'SELECT_ITEM' in
  // this module's own steps.ORDER array — retail → SELECT_VARIANT,
  // electronics → ITEM_DETAIL, fashion → SELECT_SIZE, bakery/cosmetics/
  // delivery/salon/restaurant → QUANTITY directly.
  const cfg      = getModeConfig(business);
  const nextStep = resolveNextOrderStep(cfg);

  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'ORDER',
    step:        nextStep,
    data:        { item, variant: variant || null },
    menuViewed:  true,
    // [CATALOG-QUEUE-1] Persist any other resolvable lines from this same WA
    // cart so drainCatalogQueue() can auto-advance the customer into each of
    // them, one at a time, once this first item's own flow reaches
    // ORDER_CONFIRMED — see webhookController.js and postFlowHandler.js call
    // sites of drainCatalogQueue().
    pendingCatalogQueue: queuedLines || [],
  });

  // [FIX-CATALOG-HANDOFF-1] Every module's flow handler treats `message === null`
  // as "this is a brand-new flow start" and — BEFORE the switch(step) that would
  // otherwise honour the step/data we just set above — unconditionally resets
  // session to { step: 'SELECT_ITEM', data: {} } and re-renders the welcome/browse
  // UI (confirmed in restaurant/bakery/cosmetics/delivery/retail/electronics/
  // fashion/salon flow files, all using a strict `message === null` guard).
  // Calling advance() with message: null therefore threw away the item/variant
  // just resolved from the customer's WA Catalog checkout on EVERY vertical —
  // the customer would always see "browse our menu" again instead of continuing
  // their purchase. Passing '' (non-null) instead bypasses that guard everywhere
  // (every module checks `=== null`, not general falsiness), while
  // `raw = String(message || '').trim()` still evaluates to '' exactly as
  // before — so each step handler's existing "nothing typed yet, show the
  // prompt for this step" branch runs, now WITH data.item/variant intact.
  //
  // [FIX-CATALOG-HANDOFF-2] When the very next step is QUANTITY (bakery,
  // cosmetics, delivery, salon, restaurant — no variant/size step in between),
  // the quantity the customer already chose in their WA Catalog cart is known.
  // Passing it as the simulated message feeds it through the exact same
  // parseQuantity()/QTY-shortcut parsing every module's QUANTITY case already
  // uses for typed input, so the customer isn't asked to re-enter a number
  // they already picked. For retail/electronics/fashion, the next step is a
  // variant/size/detail step (not QUANTITY) — those still get '' so their
  // normal "please choose" prompt renders untouched; quantity is asked for
  // later in those flows exactly as it always was.
  const simulatedMessage = (nextStep === 'QUANTITY' && Number.isFinite(quantity) && quantity > 0)
    ? String(quantity)
    : '';

  const freshSession = (await getSession(session.customerPhone, session.tenantId)) || session;
  const reply = await advance({ session: freshSession, message: simulatedMessage, business, tenant, isInteractive: false });

  // [CATALOG-FLOW-3] See waCatalogHelpers.js normalizeCatalogSelection() —
  // the platform's flow model is single-item-at-a-time, so a multi-item WA
  // cart is processed one line at a time. Resolvable extra lines are queued
  // (see pendingCatalogQueue above / drainCatalogQueue below) and will be
  // auto-prompted right after this one; only genuinely UNRESOLVABLE lines
  // (deleted/unavailable product) are reported as lost here.
  if (reply && typeof reply.body === 'string') {
    reply.body += buildQueuedFollowUpNote(queuedLines);
    reply.body += buildSkippedLinesNote(extraLinesSkipped);
  }

  return reply;
}

/**
 * handleMultiItemCatalogOrder({ session, business, tenant, normalized })
 * -> UIResponse
 *
 * [CATALOG-CART-1] The multi-item counterpart to the single-item handoff
 * above.
 *
 * [FIX-CATALOG-CART-CONFIRM] Previously this function called saveOrder()
 * immediately and told the customer the order was already placed — no
 * "Confirm / Add More Items / Cancel" step at all, unlike every per-vertical
 * module's own CONFIRM step (restaurant/handlers/uiBuilders.js
 * buildCartReviewUI() and its equivalents), which always shows the
 * assembled cart and waits for an explicit tap before saving anything. That
 * mismatch meant a customer whose WA cart had a mistake (wrong quantity, an
 * item they changed their mind about) had no chance to fix or cancel it —
 * the order was already in the database and the admin already alerted by
 * the time they saw the confirmation text.
 *
 * It also independently duplicated saveOrder/payment/admin-alert logic that
 * already exists, correctly, in every module's own CONFIRM case — so this
 * function's copy could (and did) drift out of sync with it.
 *
 * Fixed by reusing that existing, already-tested machinery instead of
 * re-implementing it: the resolved catalog lines are merged into
 * session.data.cart (mergeCartLines() from core/shared/cartEngine.js — the
 * SAME merge helper the typed/in-chat multi-item flow uses, so two catalog
 * lines for the same item, e.g. two separate "Superkanja" cart entries, are
 * summed into one line instead of appearing twice), session.step is set to
 * 'CONFIRM' — the exact step name every module's own ORDER flow already
 * defines for its final cart review — and flowEngine.advance() is called
 * with an empty message. Every module's CONFIRM case already treats a
 * non-yes/non-confirm message as "show the review prompt, don't save
 * anything yet", so this naturally renders that same module's own
 * Confirm-Order/Add-More-Items/Cancel-Order screen (buildCartReviewUI() for
 * restaurant) built from the ACTUAL merged catalog cart. When the customer
 * then taps Confirm, they land back in that same CONFIRM case with
 * raw='CONFIRM' — which runs saveOrder(), the payment/cash branch, and the
 * admin alert exactly the way a typed multi-item order already does, with
 * zero duplicated logic here.
 *
 * Never a dead end: if this module has no menu/cart at all somehow, the
 * module's own CONFIRM case still safely falls back to buildMenuUI().
 */
async function handleMultiItemCatalogOrder({ session, business, tenant, normalized }) {
  const { resolvedLines, extraLinesSkipped } = normalized;
  const { mergeCartLines, enforceCartLimit } = await import('../../core/shared/cartEngine.js');

  // [FIX-CATALOG-CART-CONFIRM] Map each resolved catalog line into the exact
  // cart-line shape core/shared/cartEngine.js expects ({item, quantity,
  // variant, addOns}), then merge through mergeCartLines() so two lines for
  // the SAME item+variant (e.g. the customer tapped "+1" on an item they'd
  // already added earlier in the same WA cart session) are summed into one
  // line — never shown to the customer as two separate duplicate rows.
  const newLines = resolvedLines.map(line => ({
    item:     line.item,
    quantity: line.quantity,
    variant:  line.variant || null,
    addOns:   [],
  }));
  const merged = mergeCartLines([], newLines);
  const { cart: cappedCart, overflowCount } = enforceCartLimit(merged, business);

  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'ORDER',
    step:        'CONFIRM',
    data:        { cart: cappedCart },
    menuViewed:  true,
    pendingCatalogQueue: [], // consolidated cart -- no per-line queue to drain
  });

  const freshSession = (await getSession(session.customerPhone, session.tenantId)) || session;
  const reply = await advance({ session: freshSession, message: '', business, tenant, isInteractive: false });

  if (reply && typeof reply.body === 'string') {
    if (overflowCount > 0) {
      const maxItems = business?.multiItemCart?.maxItems || 10;
      reply.body += `\n\n_(Heads up — your cart had more items than we can process at once ` +
        `(max ${maxItems}), so ${overflowCount} ${overflowCount > 1 ? 'were' : 'was'} left out. ` +
        `Please contact us to add ${overflowCount > 1 ? 'them' : 'it'}.)_`;
    }
    reply.body += buildSkippedLinesNote(extraLinesSkipped);
  }

  return reply;
}

/**
 * drainCatalogQueue({ session, business, tenant })
 * [CATALOG-QUEUE-1] Pops the next queued line off session.pendingCatalogQueue
 * (set by handleCatalogOrderMessage() above) and starts its own single-item
 * ORDER flow, exactly the same handoff handleCatalogOrderMessage() itself
 * uses — so the customer experiences it as "add the next item," not as a
 * fresh, disorienting flow restart.
 *
 * Called right after the PREVIOUS queued (or primary) item's flow reaches
 * ORDER_CONFIRMED — see webhookController.js (immediately after the main
 * route() dispatch) and postFlowHandler.js (ORDER_CONFIRMED case, for
 * confirmations that land asynchronously, e.g. an admin confirming from the
 * dashboard) for the two call sites.
 *
 * Re-resolves each queued line against the LIVE menu at drain time (not a
 * frozen snapshot) — if the admin removed/disabled the item in the meantime,
 * that line is skipped with a short note instead of being force-fed into a
 * flow with a stale/invalid item.
 *
 * → { drained: boolean } — drained:false means the queue was empty or
 * nothing in it could be resolved; caller does nothing further either way,
 * since this function sends its own message(s) directly.
 */
export async function drainCatalogQueue({ session, business, tenant }) {
  const queue = Array.isArray(session?.pendingCatalogQueue) ? [...session.pendingCatalogQueue] : [];
  if (!queue.length) return { drained: false };

  const { dispatchMessage } = await import('../../core/whatsapp/dispatcher.js');

  const { next, remainingQueue } = pickNextQueuedLine(business, queue);

  if (!next) {
    // Nothing left in the queue resolved to a live item — just clear it silently;
    // the customer already got their confirmed order, this is a best-effort extra.
    await updateSession(session.customerPhone, session.tenantId, { pendingCatalogQueue: [] }).catch(() => {});
    return { drained: false };
  }

  const cfg      = getModeConfig(business);
  const nextStep = resolveNextOrderStep(cfg);

  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'ORDER',
    step:        nextStep,
    data:        { item: next.item, variant: next.variant || null },
    menuViewed:  true,
    postFlowAck: null, // a new flow is starting — clear the ack we just drained off of
    pendingCatalogQueue: remainingQueue,
  });

  const simulatedMessage = (nextStep === 'QUANTITY' && Number.isFinite(next.quantity) && next.quantity > 0)
    ? String(next.quantity)
    : '';

  const freshSession = (await getSession(session.customerPhone, session.tenantId)) || session;
  const reply = await advance({ session: freshSession, message: simulatedMessage, business, tenant, isInteractive: false });

  if (reply) {
    const intro = { type: 'text', body: `🛍 Next up from your catalog order — *${next.item.name}*:` };
    await dispatchMessage(session.customerPhone, intro, tenant).catch(() => {});
    await dispatchMessage(session.customerPhone, reply, tenant).catch(() => {});
  }

  return { drained: true };
}
