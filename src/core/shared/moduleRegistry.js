/**
 * core/shared/moduleRegistry.js
 *
 * Called once at app startup. Registers every business module's
 * flows and action handlers with flowEngine and moduleRouter.
 *
 * Adding a new module = import + call registerModule() here. Nothing else.
 */

import { registerFlow, registerGenericFlow } from '../conversations/flowEngine.js';
import { registerAction }                    from '../conversations/moduleRouter.js';
import logger                                from '../../config/logger.js';

export async function registerAllModules() {
  // ── Shared booking flow (all modules that book) ───────────────────────────
  const { handleBookingFlow } = await import('../conversations/bookingFlow.js');
  ['RESTAURANT','SALON','BARBERSHOP','BAKERY','COSMETICS','DELIVERY','SERVICES','GENERAL'].forEach(mode => {
    registerFlow(mode, 'BOOKING', handleBookingFlow);
  });
  registerGenericFlow('BOOKING', handleBookingFlow);

  // ── Restaurant ─────────────────────────────────────────────────────────────
  const { handleOrderFlow, handleRestaurantQuestion } = await import('../../modules/restaurant/flows/orderFlow.js');
  registerFlow('RESTAURANT', 'ORDER',     handleOrderFlow);
  registerFlow('RESTAURANT', 'QUESTION',  handleRestaurantQuestion);
  registerGenericFlow('ORDER', handleOrderFlow);

  // ── Retail (dedicated) ─────────────────────────────────────────────────────
  const { handleRetailOrder, handleProductQuery } = await import('../../modules/retail/flows/index.js');
  registerFlow('RETAIL', 'ORDER',         handleRetailOrder);
  registerFlow('RETAIL', 'PRODUCT_QUERY', handleProductQuery);

  // ── Delivery (dedicated) ───────────────────────────────────────────────────
  const { handleDeliveryOrder } = await import('../../modules/delivery/flows/index.js');
  registerFlow('DELIVERY', 'ORDER', handleDeliveryOrder);

  // ── Bakery ─────────────────────────────────────────────────────────────────
  const { handleBakeryOrder, handleBakeryBooking, handleCakeCustomization } = await import('../../modules/bakery/flows/index.js');
  registerFlow('BAKERY', 'ORDER',               handleBakeryOrder);
  registerFlow('BAKERY', 'BOOKING',             handleBakeryBooking);
  registerFlow('BAKERY', 'CAKE_CUSTOMIZATION',  handleCakeCustomization);

  // ── Salon / Barbershop (dedicated flows — not generic wrappers) ───────────
  const {
    handleSalonBooking,
    handleSalonWalkIn,
    handleSalonProductOrder,
    handleSalonQuestion,
  } = await import('../../modules/salon/flows/index.js');

  // Appointment booking (with stylist selection pre-step)
  registerFlow('SALON',      'BOOKING', handleSalonBooking);
  registerFlow('BARBERSHOP', 'BOOKING', handleSalonBooking);

  // Walk-in queue (salon/barbershop only — no date/time needed)
  registerFlow('SALON',      'WALKIN', handleSalonWalkIn);
  registerFlow('BARBERSHOP', 'WALKIN', handleSalonWalkIn);

  // Retail product sales
  registerFlow('SALON',      'ORDER', handleSalonProductOrder);
  registerFlow('BARBERSHOP', 'ORDER', handleSalonProductOrder);

  // AI question handler (aftercare, pricing, product advice)
  registerFlow('SALON',      'QUESTION', handleSalonQuestion);
  registerFlow('BARBERSHOP', 'QUESTION', handleSalonQuestion);

  // ── Fashion ────────────────────────────────────────────────────────────────
  const { handleFashionOrder } = await import('../../modules/fashion/flows/index.js');
  registerFlow('FASHION', 'ORDER', handleFashionOrder);

  // ── Cosmetics ──────────────────────────────────────────────────────────────
  const { handleCosmeticsOrder, handleCosmeticsBooking, handleSkincareAdvice } = await import('../../modules/cosmetics/flows/index.js');
  registerFlow('COSMETICS', 'ORDER',           handleCosmeticsOrder);
  registerFlow('COSMETICS', 'BOOKING',         handleCosmeticsBooking);
  registerFlow('COSMETICS', 'SKINCARE_ADVICE', handleSkincareAdvice);

  // ── Electronics ────────────────────────────────────────────────────────────
  const {
    handleElectronicsOrder,
    handleSpecRequest,
    handleCompare,
    handleWarranty,
  } = await import('../../modules/electronics/flows/index.js');

  registerFlow('ELECTRONICS', 'ORDER',        handleElectronicsOrder);
  registerFlow('ELECTRONICS', 'SPEC_REQUEST', handleSpecRequest);
  registerFlow('ELECTRONICS', 'COMPARE',      handleCompare);
  registerFlow('ELECTRONICS', 'WARRANTY',     handleWarranty);
  // [FIX-3] QUESTION taps in ELECTRONICS mode must reach handleSpecRequest.
  // Without this, the generic QUESTION action handler calls startFlow('QUESTION'),
  // finds no ELECTRONICS:QUESTION registration, and returns an error UI.
  // Electronics customers asking "❓ Ask a Question" should land in tech Q&A.
  registerFlow('ELECTRONICS', 'QUESTION',     handleSpecRequest);

  // ── Services (dedicated) ───────────────────────────────────────────────────
  const { handleEnquiryFlow, handleServicesBooking, handleQuoteFollowUp, handleServicesQuestion } = await import('../../modules/services/flows/index.js');
  registerFlow('SERVICES', 'ENQUIRY',      handleEnquiryFlow);
  registerFlow('SERVICES', 'BOOKING',      handleServicesBooking);
  registerFlow('SERVICES', 'QUOTE_FOLLOW', handleQuoteFollowUp);
  registerFlow('SERVICES', 'QUESTION',     handleServicesQuestion);

  // ── General (dedicated) ────────────────────────────────────────────────────
  const { handleGeneralQuestion, handleGeneralEnquiry, handleGeneralBooking, handleAbout } = await import('../../modules/general/flows/index.js');
  registerFlow('GENERAL', 'QUESTION', handleGeneralQuestion);
  registerFlow('GENERAL', 'ENQUIRY',  handleGeneralEnquiry);
  registerFlow('GENERAL', 'BOOKING',  handleGeneralBooking);
  registerFlow('GENERAL', 'ABOUT',    handleAbout);

  // ── Action handlers (module-registered) ───────────────────────────────────
  // [CATALOG-REG-1 / MERGE-FIX-VIEWMENU-1] START_ORDER is the single choke
  // point every vertical's "customer wants to shop" intent flows through —
  // ORDER, ADD_TO_CART, CHECKOUT, RECOMMENDATION, and REMOVE_FROM_CART all
  // map here via intentEngine.js intentToAction(), as does the 'ORDER'/
  // '🛍 Order Food' button tap, the '1' numeric shortcut on every welcome
  // screen, AND the direct-phrase matches ("I want to order food", "I'd like
  // to book a table" — see ORDER_DIRECT_RE/BOOKING_DIRECT_RE in
  // intentEngine.js). Every one of those must reliably land the customer on
  // the real, instant product/menu list (buildMenuUI et al.) exactly the way
  // the reference implementation always has — that reliability is the whole
  // point of this action.
  //
  // [MERGE-FIX-VIEWMENU-1] This handler PREVIOUSLY auto-substituted the WA
  // (Meta) Commerce Catalog message in place of the normal ORDER flow
  // whenever a tenant had waCatalog.enabled+catalogId configured (see the old
  // offerCatalogOnStartOrder() call this replaces). That meant, for any
  // catalog-configured tenant, tapping "Order Food" — or simply typing "I
  // want to order food" — silently never produced the text/list View Menu at
  // all; the customer got the Meta Catalog UI instead, with no way back to
  // the classic menu from this entry point. That is the exact "client can
  // directly say order food / book a table but View Menu doesn't appear"
  // symptom reported during the merge review.
  //
  // Fix: START_ORDER now ALWAYS goes straight to the normal ORDER flow —
  // startFlow() → the module's handleOrderFlow(message:null) →
  // buildMenuUI(business) — with zero conditions, exactly like the verified
  // reference behaviour. WA Catalog is not removed; it is demoted from an
  // automatic substitution to a purely OPT-IN, customer-requested path:
  // still fully reachable via the explicit "🛍 Browse Catalog" button/
  // BROWSE_CATALOG action below (shouldShowCatalogButton() /
  // withCatalogWelcomeOption() in waCatalogConfig.js, wired into the
  // GREET/SHOW_MENU welcome screens in moduleRouter.js), and via any other
  // explicit catalog entry point — none of that wiring changed. Only the
  // silent, automatic swap-out of the plain View Menu was removed.
  registerAction('START_ORDER', async ({ session, message, business, tenant, intent }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'ORDER', session, business, tenant });
  });

  // [CATALOG-UX-BUTTON] Explicit customer-initiated "🛍 Browse Catalog" tap —
  // unlike START_ORDER above, this ALWAYS shows WA Catalog when the tenant has
  // it enabled+configured (see shouldShowCatalogButton() in waCatalogConfig.js),
  // independent of waCatalog.mode. Falls back to the normal ORDER flow on any
  // send failure — see browseCatalogExplicit()'s own [Failure handling].
  registerAction('BROWSE_CATALOG', async ({ session, business, tenant }) => {
    const { browseCatalogExplicit } = await import('../../modules/catalog/waCatalogFlow.js');
    return browseCatalogExplicit({ session, business, tenant });
  });

  registerAction('START_BOOKING', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'BOOKING', session, business, tenant });
  });

  // WALKIN action — salon/barbershop walk-in queue (no date/time needed)
  registerAction('WALKIN', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'WALKIN', session, business, tenant });
  });

  registerAction('CAKE_CUSTOMIZATION', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'CAKE_CUSTOMIZATION', session, business, tenant });
  });

  registerAction('SKINCARE_ADVICE', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'SKINCARE_ADVICE', session, business, tenant });
  });

  // [FIX-F] SPEC_REQUEST action was never registered — unknown action fell through to
  // a generic fallback. Now starts the SPEC_REQUEST flow registered on ELECTRONICS.
  // For non-electronics modes it falls back gracefully (no SPEC_REQUEST flow registered).
  registerAction('SPEC_REQUEST', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'SPEC_REQUEST', session, business, tenant });
  });

  // COMPARE — side-by-side product comparison (Electronics only).
  // Button id: 'COMPARE' on welcome screen and fallback buttons.
  registerAction('COMPARE', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'COMPARE', session, business, tenant });
  });

  // WARRANTY — warranty + after-sales enquiry (Electronics only).
  // Can be triggered by typing "warranty", "repair", "return" etc., or future button.
  registerAction('WARRANTY', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'WARRANTY', session, business, tenant });
  });

  registerAction('ENQUIRY', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'ENQUIRY', session, business, tenant });
  });

  // [FIX-3] QUESTION action — routes the QUESTION button tap to the mode-specific
  // QUESTION flow (SERVICES: handleServicesQuestion, GENERAL: handleGeneralQuestion,
  // RESTAURANT: handleRestaurantQuestion, SALON/BARBERSHOP: handleSalonQuestion,
  // ELECTRONICS: handleSpecRequest).
  // Previously QUESTION intent mapped to ENQUIRY action which was intercepted by the
  // webhookController inline shortcut, bypassing ACTION_REGISTRY entirely. QUESTION
  // is now in FLOW_PASSTHROUGH_IDS so it reaches route() → ACTION_REGISTRY → here.
  // [FIX-QUESTION-FALLBACK] For modes without a dedicated QUESTION flow registered
  // (BAKERY, COSMETICS, RETAIL, DELIVERY, FASHION), startFlow('QUESTION') previously
  // returned "⚠️ This option is not available right now." — a broken UX for any
  // customer tapping "❓ Ask a Question" in those modes. The fix: check whether a
  // mode-specific QUESTION flow exists FIRST; if not, fall back to the generic ENQUIRY
  // flow (sets currentFlow=ENQUIRY / step=AWAITING_QUESTION → AI answers the question).
  registerAction('QUESTION', async ({ session, message, business, tenant }) => {
    const { startFlow }  = await import('../conversations/flowEngine.js');
    const { updateSession } = await import('../sessions/sessionService.js');
    const { getModeConfig } = await import('../../config/modes.js');
    const mode = (business?.businessMode || 'RETAIL').toUpperCase();
    // Modes with dedicated QUESTION flows registered in this registry
    const QUESTION_FLOW_MODES = new Set([
      'RESTAURANT', 'SALON', 'BARBERSHOP', 'ELECTRONICS', 'SERVICES', 'GENERAL',
    ]);
    if (QUESTION_FLOW_MODES.has(mode)) {
      return startFlow({ flowName: 'QUESTION', session, business, tenant });
    }
    // No mode-specific QUESTION flow — use the generic AI question handler
    await updateSession(session.customerPhone, session.tenantId, {
      currentFlow: 'ENQUIRY', step: 'AWAITING_QUESTION',
    });
    const cfg = getModeConfig(business);
    return {
      type:    'buttons',
      body:    '❓ What would you like to know? Type your question below.',
      buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
    };
  });

  registerAction('QUOTE_FOLLOW', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'QUOTE_FOLLOW', session, business, tenant });
  });

  // [FIX-8] ABOUT action — delegates directly to the mode handler via route()'s
  // ACTION_REGISTRY. moduleRouter's ABOUT case already checks ACTION_REGISTRY first,
  // so registering here is correct. We call startFlow only for GENERAL (which has a
  // registered GENERAL:ABOUT flow). For all other modes the moduleRouter fallback
  // inline ABOUT response runs. Removed the blanket startFlow('ABOUT') wrapper that
  // created a spurious currentFlow write-then-immediate-clear on every ABOUT view.
  registerAction('ABOUT', async ({ session, message, business, tenant, intent, isInteractive, suggestion }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    const mode = (business?.businessMode || 'RETAIL').toUpperCase();
    if (mode === 'GENERAL') {
      return startFlow({ flowName: 'ABOUT', session, business, tenant });
    }
    // For non-GENERAL modes, return null so moduleRouter's inline ABOUT handler runs.
    return null;
  });

  registerAction('PRODUCT_QUERY', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'PRODUCT_QUERY', session, business, tenant });
  });

  registerAction('REPEAT_ORDER', async ({ session, message, business, tenant }) => {
    const { getLastOrderItem } = await import('../../services/orderService.js');
    const { startFlow }        = await import('../conversations/flowEngine.js');
    const { updateSession }    = await import('../sessions/sessionService.js');

    const lastItem = await getLastOrderItem(session.customerPhone, session.tenantId).catch(() => null);
    if (lastItem) {
      // [AUDIT-FIX-REPEAT-1] getLastOrderItem() only returns the stored item NAME
      // (Order.item is a plain string, not a reference). Previously this handler
      // wrote `data.item = { name: lastItem }` straight into the session with no
      // `price` field. The QUANTITY step's `item?.price || 0` then silently priced
      // every repeated order at 0 — and because the CONFIRM step only shows/collects
      // payment when `data.totalPrice` is truthy, a totalPrice of 0 also skipped the
      // payment step entirely for tenants with payment enabled. Customers repeating
      // an order got it for free and admins were never asked to verify payment.
      // Fix: re-resolve the full menu item (price, image, description, etc.) from
      // business.menuItems by name so the repeat flow carries the same data a fresh
      // SELECT_ITEM pick would. If the item was removed/renamed since the last order,
      // fall back to the name-only stub but tell the customer their price may differ
      // rather than silently ordering it for D0.
      const menu = (business?.menuItems || []).filter(i => i.available !== false);
      const normName = (s = '') => String(s).toLowerCase().trim();
      const fullItem = menu.find(i => normName(i.name) === normName(lastItem)) || null;

      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER', step: 'QUANTITY',
        data: { item: fullItem || { name: lastItem } }, menuViewed: true,
      });

      const priceWarning = !fullItem
        ? `\n\n⚠️ We couldn't confirm the current price for this item — we'll follow up with the total before confirming your order.`
        : '';

      return {
        type: 'buttons',
        body: `🔁 *Repeat your last order*\n\nYou previously ordered *${lastItem}*.\n\nHow many would you like this time?${priceWarning}\n\n_(Enter a number or word — e.g. *1*, *2*, *three*)_`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }
    return startFlow({ flowName: 'ORDER', session, business, tenant });
  });

  registerAction('TRACK_ORDER', async ({ session, business }) => {
    // [AUDIT-FIX-14] Root cause of two related bugs visible when a customer asks
    // "do I have any active order or booking?":
    //   1. This handler only ever looked at Order records, via getRecentOrders(...,1),
    //      which returns the single MOST RECENT order regardless of its status. A
    //      customer whose only order was completed days ago got it presented as
    //      "Your latest order" with no indication it wasn't current — misleading when
    //      the question was specifically about *active* items.
    //   2. Bookings were never queried at all, so a customer who had just made a table
    //      booking (as in the reported case) got an answer that silently ignored it,
    //      even though they explicitly asked about "order OR booking".
    // Fix: check for a genuinely active order (via the same non-terminal-status /
    // 24h-pending-cutoff definition activeOrderResolver already uses elsewhere, so
    // "active" means the same thing everywhere in the app) AND a genuinely active
    // booking, and report on whichever actually exist — rather than always resurfacing
    // history.
    const { resolveActiveOrder }             = await import('../../services/activeOrderResolver.js');
    const { getActiveBooking }                = await import('../../services/bookingService.js');
    const { getModeConfig }                   = await import('../../config/modes.js');

    const [orderResolution, activeBooking] = await Promise.all([
      resolveActiveOrder(session.customerPhone, session.tenantId, business, session).catch(() => null),
      getActiveBooking(session.customerPhone, session.tenantId).catch(() => null),
    ]);
    const activeOrder = orderResolution?.state !== 'NO_ACTIVE_ORDER' ? (orderResolution?.order || null) : null;

    const phone    = business?.adminPhone;
    const cfg      = getModeConfig(business);
    const canOrder = cfg.flows?.includes('ORDER');

    const ORDER_STATUS_LABELS = {
      pending: '⏳ Pending', payment_pending_verification: '⏳ Awaiting payment verification',
      confirmed: '✅ Confirmed', preparing: '👨‍🍳 Preparing', ready: '📦 Ready for collection',
      out_for_delivery: '🚚 Out for delivery', delivered: '✅ Delivered',
    };
    const BOOKING_STATUS_LABELS = { pending: '⏳ Awaiting confirmation', confirmed: '✅ Confirmed' };

    const extraOrderCount = Math.max((orderResolution?.orders?.length || 0) - 1, 0);

    const sections = [];
    if (activeOrder) {
      sections.push(
        `🍽 *${activeOrder.item}* × ${activeOrder.quantity}\n📅 ${new Date(activeOrder.createdAt).toLocaleDateString()}\n` +
        `🔖 Status: *${ORDER_STATUS_LABELS[activeOrder.status] || activeOrder.status}*` +
        (extraOrderCount > 0 ? `\n_+${extraOrderCount} more active order${extraOrderCount > 1 ? 's' : ''} — contact us for the full list_` : '')
      );
    }
    if (activeBooking) {
      const when = [activeBooking.date, activeBooking.time].filter(Boolean).join(' • ');
      sections.push(
        `📅 *Booking*${when ? ` — ${when}` : ''}\n` +
        `🔖 Status: *${BOOKING_STATUS_LABELS[activeBooking.status] || activeBooking.status}*`
      );
    }

    let body;
    if (sections.length) {
      const heading = activeOrder && activeBooking ? '📦 *Your active order & booking*' :
                      activeBooking ? '📅 *Your active booking*' : '📦 *Your active order*';
      body = `${heading}\n\n${sections.join('\n\n')}\n\n` +
        (phone ? `For live updates: 📞 *${phone}*` : 'Contact us for live updates.');
    } else {
      body = `You don't have any active order or booking right now.\n\n` +
        (phone ? `Contact us: 📞 *${phone}*` : 'Contact us directly for help.');
    }

    return {
      type: 'buttons',
      body,
      buttons: [
        canOrder ? { id: 'ORDER', title: '🛍 New Order' } : null,
        { id: 'SUPPORT',   title: '💬 Contact Support' },
        { id: 'SHOW_MENU', title: '🔄 Start Over'       },
      ].filter(Boolean).slice(0, 3),
    };
  });

  logger.info('[Registry] All modules registered ✓');
}
