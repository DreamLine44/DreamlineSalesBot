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
// [FIX-CATALOG-GATE] Static import — these are two pure, synchronous,
// zero-I/O boolean checks (see waCatalogConfig.js) with no dependencies of
// their own. Importing them statically means the START_ORDER handler below
// can decide "does WA Catalog even apply to this tenant?" without touching
// import() at all for the common case, so there is no dynamic-import
// indirection anywhere on the path a non-catalog tenant's "Order Food" tap
// takes — that path is now the exact same shape it was before WA Catalog
// existed: one direct call to startFlow('ORDER').
import { isCatalogEnabled, hasSellableProducts } from '../../modules/catalog/waCatalogConfig.js';

async function parseDirectBookingRequest(message, business) {
  const raw = String(message || '').trim();
  const partyMatch = raw.match(/\b(?:table|party)\s*(?:for|of)?\s*(\d{1,2})\b/i)
    || raw.match(/\bfor\s+(\d{1,2})\b/i);
  const timeMatch = raw.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
  const dateMatch = raw.match(/\b(?:today|tomorrow|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i)
    || raw.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?\b/i);
  if (!partyMatch || !timeMatch || !dateMatch) return null;

  const { resolveBookingDateInput } = await import('../../services/bookingDateParser.js');
  const tz = business?.hours?.timezone || 'UTC';
  const resolved = await resolveBookingDateInput(dateMatch[0], tz);
  if (!resolved.ok) return null;

  const time = timeMatch[1].replace(/\s+/g, ' ').trim();
  return {
    partySize: Number(partyMatch[1]),
    date: resolved.label,
    parsedDate: resolved.parsed,
    dateRaw: resolved.raw,
    time,
  };
}

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
  // [AUDIT-FIX-CATALOG-STARTORDER] modules/catalog/waCatalogFlow.js's
  // offerCatalogOnStartOrder() was fully implemented and its own header comment
  // documents it as "Called from the moduleRegistry.js START_ORDER action
  // override (see [CATALOG-REG-1] there)" — but no such override existed here.
  // Same "implemented but unwired" bug class as withCatalogWelcomeOption()
  // (see [AUDIT-FIX-CATALOG-WELCOME] in moduleRouter.js): WA-Catalog-enabled
  // tenants in AI_DECIDES/ALWAYS_OFFER mode could never actually have their
  // "🍔 Order Food" tap open with WA Catalog — it always silently went straight
  // to the module's own text/list menu, no matter how the tenant was configured.
  //
  // Immediate-display guarantee: shouldOfferCatalog() (called first, inside
  // offerCatalogOnStartOrder) short-circuits on `isCatalogEnabled(business) &&
  // hasSellableProducts(business)` — two synchronous field/array checks, zero
  // I/O, zero network calls. For any tenant without WA Catalog enabled (the
  // default for every tenant that hasn't explicitly opted in), this resolves
  // instantly and falls straight through to the exact same
  // startFlow({ flowName: 'ORDER' }) call that ran here before — View Menu
  // still displays immediately, with no added delay and no risk of silence.
  // Only WA-Catalog-enabled tenants take the (documented, already-guarded)
  // sendAndArmCatalog() network path, and any failure there still falls back
  // to startFlow('ORDER') below rather than leaving the customer with no reply.
  // [FIX-CATALOG-GATE] Two explicit, separately-readable paths, exactly as
  // requested — not one path with a conditional buried inside it:
  //
  //   PATH A — tenant has no WA Catalog configured (the default, and every
  //   tenant that existed before this integration): checked synchronously,
  //   with the two pure functions imported at the top of this file, zero
  //   dynamic import, zero await, zero network call, zero dependency on
  //   waCatalogFlow.js loading correctly. Goes STRAIGHT to
  //   startFlow({ flowName: 'ORDER' }) — the identical single call this
  //   codebase made before WA Catalog existed. "View Menu" cannot be
  //   silently eaten by anything catalog-related on this path, because
  //   nothing catalog-related runs on this path at all.
  //
  //   PATH B — tenant HAS WA Catalog enabled and configured with sellable
  //   products: only then do we load waCatalogFlow.js and run the
  //   AI/mode-based offer decision. Any failure there (bad catalogId, Graph
  //   API error, thrown exception) still falls back to the exact same
  //   startFlow('ORDER') call PATH A uses — WA Catalog can never become a
  //   dead end for a customer, even for tenants who opted into it.
  registerAction('START_ORDER', async ({ session, message, business, tenant, intent }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    const { advance } = await import('../conversations/flowEngine.js');
    const { updateSession } = await import('../sessions/sessionService.js');
    const normalizedIntent = intent === 'START_ORDER' ? 'ORDER' : (intent || 'ORDER');
    const msgUpper = String(message || '').trim().toUpperCase();
    const explicitOrderTap = msgUpper === 'ORDER' || msgUpper === 'NEW_ORDER';

    // [ENHANCED-NLU] Pre-seed cart when AI extracted matched products (HIGH-confidence only).
    // A complete product request must bypass the catalog/menu and go directly
    // to the existing cart review step (e.g. "two plates of Benachin").
    // The catalog remains the path for an incomplete request such as "I want
    // to order".
    let orderSession = session;
    const nluProducts = session?.data?._nluPending?.products;
    const { mergeCartLines, parseMultiItemMessage, parseNaturalOrderMessage } = await import('../shared/cartEngine.js');
    const menu = (business?.menuItems || []).filter(item => item.available !== false);
    const parsedDirect = parseMultiItemMessage(menu, message) || parseNaturalOrderMessage(menu, message);
    const lines = Array.isArray(nluProducts) && nluProducts.length > 0
      ? nluProducts
        .filter(p => p?.item)
        .map(p => ({ item: p.item, quantity: p.quantity || 1, variant: p.variant || null }));
      : (parsedDirect?.lines || []);
    if (lines.length > 0) {
      const cart = mergeCartLines([], lines);
      const newData = { ...(session.data || {}), cart, _nluPending: null };
      const updated = await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER',
        step: 'CONFIRM',
        data: newData,
        orderChannel: 'menu',
        menuViewed: true,
      });
      orderSession = { ...session, ...updated, data: newData, currentFlow: 'ORDER', step: 'CONFIRM', orderChannel: 'menu' };
      return advance({ flowReply: null, session: orderSession, message: null, business, tenant });
    }

    // PATH A — no WA Catalog for this tenant. Old-version behavior, verbatim.
    const catalogReady = isCatalogEnabled(business) && hasSellableProducts(business);
    if (!catalogReady) {
      return startFlow({ flowName: 'ORDER', session: { ...orderSession, orderChannel: 'menu' }, business, tenant });
    }

    // [ORDER-CHANNEL] Customer chose Browse Catalog earlier — keep them on catalog
    // for every subsequent "New Order" / ORDER tap (including MANUAL_ONLY tenants).
    if (orderSession?.orderChannel === 'catalog' || explicitOrderTap) {
      const { browseCatalogExplicit } = await import('../../modules/catalog/waCatalogFlow.js');
      return browseCatalogExplicit({ session: orderSession, business, tenant });
    }

    // PATH B — WA Catalog is actually configured for this tenant.
    const { offerCatalogOnStartOrder } = await import('../../modules/catalog/waCatalogFlow.js');
    const { offered } = await offerCatalogOnStartOrder({ session: orderSession, business, tenant, intent: normalizedIntent }).catch(() => ({ offered: false }));
    if (offered) return null; // WA Catalog message already dispatched directly — nothing further to send
    return startFlow({ flowName: 'ORDER', session: { ...orderSession, orderChannel: 'menu' }, business, tenant });
  });

  registerAction('START_BOOKING', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    const { advance } = await import('../conversations/flowEngine.js');
    const directBooking = await parseDirectBookingRequest(message, business).catch(() => null);
    if (directBooking && !(business?.services || []).length) {
      const updated = await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'BOOKING',
        step: 'BOOKING_CONFIRM',
        data: { ...(session.data || {}), ...directBooking },
      });
      return advance({
        session: { ...session, ...updated, currentFlow: 'BOOKING', step: 'BOOKING_CONFIRM', data: { ...(session.data || {}), ...directBooking } },
        message: null,
        business,
        tenant,
      });
    }
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
      // [AUDIT-FIX-REPEAT-1] getLastOrderItem() only ever returns the stored item
      // NAME (Order.item is a plain string) — writing that straight into session
      // data as { name: lastItem } gave the QUANTITY step no price to work with,
      // silently totalling D0 and, since totalPrice:0 also skips the payment
      // step, quietly treated every repeat order as a free cash order with no
      // admin payment-verification prompt. Re-resolve the full menu item (with
      // price/image/etc.) from the current menu by name, falling back to the
      // name-only stub — with an explicit price-uncertainty notice — only when
      // the item can no longer be found (e.g. it was removed from the menu).
      const fullItem = (business?.menuItems || []).find(
        mi => (mi.name || '').toLowerCase() === lastItem.toLowerCase()
      ) || null;

      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER', step: 'QUANTITY',
        data: { item: fullItem || { name: lastItem } }, menuViewed: true,
      });
      const priceNotice = !fullItem
        ? `\n\n⚠️ We couldn't confirm the current price for this item — we'll follow up with the exact total before your order is finalised.`
        : '';
      return {
        type: 'buttons',
        body: `🔁 *Repeat your last order*\n\nYou previously ordered *${lastItem}*.${priceNotice}\n\nHow many would you like this time?\n\n_(Enter a number or word — e.g. *1*, *2*, *three*)_`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }
    return startFlow({ flowName: 'ORDER', session, business, tenant });
  });

  registerAction('TRACK_ORDER', async ({ session, business, message }) => {
    const { buildStatusReply } = await import('../../services/activityStatusService.js');
    return buildStatusReply({ session, business, message });
  });

  logger.info('[Registry] All modules registered ✓');
}
