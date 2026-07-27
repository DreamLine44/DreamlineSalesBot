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
  buildCatalogCartItems,
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

  // [CATALOG-CART-1] Consolidate into ONE Order for tenants who have opted
  // into multi-item orders. See waCatalogHelpers.js buildCatalogCartItems and
  // handleMultiItemCatalogOrder below for full rationale — gated on
  // multiItemCart.enabled so opted-out tenants keep the existing sequential
  // single-item-flow-per-line queue behavior below, unchanged.
  if (business?.multiItemCart?.enabled && normalized.resolvedLines.length > 1) {
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
 * above. Builds ONE Order.items[] from every resolvable line in this WA
 * cart (capped at business.multiItemCart.maxItems -- the same hard bound the
 * in-chat cart loop was always meant to enforce, per orderService.js's own
 * comment on HARD_MAX_CART_ITEMS) and saves it in a single saveOrder() call,
 * then sends the same payment-instructions-or-cash-message + admin-alert
 * pair every per-vertical module's own ORDER CONFIRM step sends -- just
 * built generically here instead of duplicated per module, since a WA
 * Catalog cart is never module-specific (menuItems + payment config are the
 * only per-tenant inputs either path needs).
 *
 * Never a dead end: a saveOrder() failure falls back to a retry prompt, same
 * as every other failure path in this file.
 */
async function handleMultiItemCatalogOrder({ session, business, tenant, normalized }) {
  const { resolvedLines, extraLinesSkipped } = normalized;
  const maxItems      = business?.multiItemCart?.maxItems || 10;
  const cappedLines    = resolvedLines.slice(0, maxItems);
  const overflowCount  = resolvedLines.length - cappedLines.length;
  const cartItems      = buildCatalogCartItems(cappedLines);

  const { saveOrder } = await import('../../services/orderService.js');
  let savedOrder = null;
  try {
    savedOrder = await saveOrder({
      items:         cartItems,
      customerName:  session.customerName || null,
      customerPhone: session.customerPhone,
      tenantId:      session.tenantId,
      businessId:    business._id,
    });
  } catch (err) {
    logger.error('[WACatalog] handleMultiItemCatalogOrder: saveOrder failed', {
      err: err.message, tenantId: business?.tenantId,
    });
    return {
      type:    'buttons',
      body:    "Something went wrong saving your order -- sorry about that! Let's try again.",
      buttons: [{ id: 'ORDER', title: '🛍 Shop' }, { id: 'SUPPORT', title: '💬 Help' }],
    };
  }

  const totalPrice  = savedOrder.totalPrice;
  const payment     = business?.payment;
  const currency    = payment?.currency || 'D';
  const cartSummary = cartItems.map(it => `${it.quantity}× ${it.item}`).join('\n');
  const usePayment  = payment?.enabled && totalPrice != null;

  // [FIX-CATALOG-CART-3] Mirrors the per-module CONFIRM step exactly: PAYMENT_PROOF
  // when payment is configured (customer still needs to send a screenshot — see
  // paymentService.receiveProof(), which is DB-driven off (customerPhone, tenantId)
  // and therefore doesn't need anything special in session.data to work here).
  //
  // The cash/no-payment branch previously cleared currentFlow/step to null
  // immediately — unlike EVERY per-vertical orderFlow.js's own "payment not
  // enabled" branch (see restaurant/flows/orderFlow.js [FIX-3]/[FIX-AWAIT],
  // bakery/flows/orderFlow.js, etc.), which always parks at AWAIT_ADMIN_CONFIRM
  // instead. That gap meant a cash WA Catalog cart order: (a) never went through
  // webhookController's AWAIT_ADMIN_CONFIRM guard or its PENDING ORDER LOCK, so
  // the customer could immediately start a second order while the first was still
  // unconfirmed, and (b) the admin alert below had no APPROVE_/REJECT_ buttons, so
  // there was no tap-to-confirm path at all for this order — it could only ever be
  // actioned by an admin manually typing an APPROVE/REJECT command. Fixed to match
  // every other module: park at AWAIT_ADMIN_CONFIRM for the cash branch too.
  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'ORDER',
    step:        usePayment ? 'PAYMENT_PROOF' : 'AWAIT_ADMIN_CONFIRM',
    data:        {},
    menuViewed:  true,
    pendingCatalogQueue: [], // consolidated order -- no per-line queue to drain
  });

  // Notify admin -- fire-and-forget, same pattern as every other admin alert
  // in this file and every per-vertical CONFIRM step.
  //
  // [FIX-CATALOG-CART-3] The cash branch now sends the same APPROVE_/REJECT_
  // interactive card every other module sends for a cash/no-payment order, so
  // the admin has a one-tap way to confirm or cancel it (see adminCommandService
  // .confirmPayment()/rejectPayment(), which resolve purely off the order's
  // shortId and are already cart-shape-agnostic). The payment-required branch
  // is left as a plain-text notice, unchanged — its own real approval card is
  // sent later by paymentService.receiveProof() once the screenshot arrives,
  // exactly like every other module's payment-enabled path.
  try {
    const adminPhone = business?.adminPhone || tenant?.adminPhone;
    if (adminPhone && tenant) {
      const { dispatchMessage } = await import('../../core/whatsapp/dispatcher.js');
      const alertBody =
        `🔔 *New Order — ${business.name || 'Business'}*\n\n` +
        `👤 Customer: *${session.customerPhone}*\n` +
        `🛒 Items:\n${cartSummary}\n` +
        (totalPrice != null ? `💰 Total: *${currency}${totalPrice}*\n` : '') +
        `🔖 Ref: \`#${savedOrder.shortId}\`\n\n` +
        `⏳ Status: *Pending*${usePayment ? ' — awaiting payment screenshot.' : ' — please confirm.'}`;

      await dispatchMessage(adminPhone, usePayment
        ? { type: 'text', body: alertBody }
        : {
            type:    'buttons',
            body:    alertBody,
            buttons: [
              { id: `APPROVE_${savedOrder.shortId}`, title: '✅ Confirm Received' },
              { id: `REJECT_${savedOrder.shortId}`,  title: '❌ Cancel Order'     },
            ],
          },
      tenant).catch(() => {});
    }
  } catch { /* non-fatal -- mirrors every other admin-alert try/catch in this codebase */ }

  let reply;
  if (usePayment) {
    const { buildPaymentInstructionsUI } = await import('../../services/paymentService.js');
    reply = buildPaymentInstructionsUI(business, totalPrice, savedOrder.shortId);
    // Store the reference on the order -- mirrors every per-module CONFIRM step.
    if (savedOrder?._id) {
      const now = new Date();
      const mm  = String(now.getMonth() + 1).padStart(2, '0');
      const dd  = String(now.getDate()).padStart(2, '0');
      const ref = `DSB-${mm}${dd}-${savedOrder.shortId}`;
      const { default: OrderModel } = await import('../../models/Order.js');
      OrderModel.updateOne({ _id: savedOrder._id }, { $set: { paymentReference: ref } }).catch(() => {});
    }
  } else {
    // [FIX-CATALOG-CART-3] Same "please wait for confirmation" framing every
    // other module uses in its cash/AWAIT_ADMIN_CONFIRM branch, since the
    // customer is now genuinely parked waiting on an admin tap, not done.
    reply = {
      type: 'text',
      body:
        `✅ *Order received!*\n\n${cartSummary}\n\n` +
        (totalPrice != null ? `💰 Total: *${currency}${totalPrice}*\n\n` : '') +
        `⏳ Your order has been received. Please wait for our team to confirm it before placing a new one.`,
    };
  }

  if (overflowCount > 0) {
    reply.body += `\n\n_(Heads up — your cart had more items than we can process at once ` +
      `(max ${maxItems}), so ${overflowCount} ${overflowCount > 1 ? 'were' : 'was'} left out. ` +
      `Please contact us to add ${overflowCount > 1 ? 'them' : 'it'}.)_`;
  }
  reply.body += buildSkippedLinesNote(extraLinesSkipped);

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
