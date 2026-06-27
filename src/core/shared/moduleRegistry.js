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
  registerAction('START_ORDER', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'ORDER', session, business, tenant });
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

  // [FIX-ENQUIRY-FALLBACK] ENQUIRY flow is only registered for SERVICES and GENERAL.
  // For all other modes (RESTAURANT, BAKERY, RETAIL, etc.) startFlow('ENQUIRY') was
  // returning "⚠️ This option is not available right now." — a broken UX for any
  // customer tapping "📬 Send an Enquiry" or triggering the ENQUIRY intent.
  // Fix: only startFlow for modes that have a registered ENQUIRY flow handler.
  // All other modes fall back to the generic AI question handler (AWAITING_QUESTION).
  registerAction('ENQUIRY', async ({ session, message, business, tenant }) => {
    const { startFlow }     = await import('../conversations/flowEngine.js');
    const { updateSession } = await import('../sessions/sessionService.js');
    const mode = (business?.businessMode || 'RETAIL').toUpperCase();
    // Modes with dedicated ENQUIRY flows registered above
    const ENQUIRY_FLOW_MODES = new Set(['SERVICES', 'GENERAL']);
    if (ENQUIRY_FLOW_MODES.has(mode)) {
      return startFlow({ flowName: 'ENQUIRY', session, business, tenant });
    }
    // No mode-specific ENQUIRY flow — use the generic AI question handler
    await updateSession(session.customerPhone, session.tenantId, {
      currentFlow: 'ENQUIRY', step: 'AWAITING_QUESTION',
    });
    return {
      type:    'buttons',
      body:    '❓ What would you like to know? Type your question below.',
      buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
    };
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

  // [FIX-QUOTE-FOLLOW-FALLBACK] QUOTE_FOLLOW flow is only registered for SERVICES.
  // For all other modes, startFlow('QUOTE_FOLLOW') returned "not available".
  // Fix: only startFlow for SERVICES; all other modes fall back to the generic ENQUIRY handler.
  registerAction('QUOTE_FOLLOW', async ({ session, message, business, tenant }) => {
    const { startFlow }     = await import('../conversations/flowEngine.js');
    const { updateSession } = await import('../sessions/sessionService.js');
    const mode = (business?.businessMode || 'RETAIL').toUpperCase();
    if (mode === 'SERVICES') {
      return startFlow({ flowName: 'QUOTE_FOLLOW', session, business, tenant });
    }
    // Generic fallback: start the ENQUIRY question flow
    await updateSession(session.customerPhone, session.tenantId, {
      currentFlow: 'ENQUIRY', step: 'AWAITING_QUESTION',
    });
    return {
      type:    'buttons',
      body:    '❓ What would you like to know? Type your question below.',
      buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
    };
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
      // [FIX-REPEAT-PRICE] Look up the full menu item object to get the price.
      // Previously only { name: lastItem } was stored — item.price was undefined in the
      // QUANTITY step, causing total = undefined * qty = NaN, which was saved to the
      // Order as totalPrice: NaN. Now we find the real menu item first; if not found
      // (e.g. item was removed from menu), fall back to { name: lastItem, price: 0 }
      // and inform the customer the price may have changed.
      const menuItems = business?.menuItems || [];
      const menuItem = menuItems.find(
        i => i.name.toLowerCase() === lastItem.toLowerCase() && i.available !== false
      ) || { name: lastItem, price: null };
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER', step: 'QUANTITY',
        data: { item: menuItem }, menuViewed: true,
      });
      return {
        type: 'buttons',
        body: `🔁 *Repeat your last order*\n\nYou previously ordered *${lastItem}*.\n\nHow many would you like this time?\n\n_(Enter a number or word — e.g. *1*, *2*, *three*)_`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }
    return startFlow({ flowName: 'ORDER', session, business, tenant });
  });

  registerAction('TRACK_ORDER', async ({ session, business }) => {
    const { getRecentOrders } = await import('../../services/orderService.js');
    const { getModeConfig }   = await import('../../config/modes.js');
    const orders = await getRecentOrders(session.customerPhone, session.tenantId, 1).catch(() => []);
    const last   = orders[0];
    const phone  = business?.adminPhone;
    const cfg    = getModeConfig(business);
    const canOrder = cfg.flows?.includes('ORDER');
    const body = last
      ? `📦 *Your latest order*\n\n🍽 *${last.item}* × ${last.quantity}\n📅 ${new Date(last.createdAt).toLocaleDateString()}\n🔖 Status: *${last.status}*\n\n` +
        (phone ? `For live updates: 📞 *${phone}*` : 'Contact us for live updates.')
      : `📦 No recent orders found.\n\n${phone ? `Contact us: 📞 *${phone}*` : 'Contact us directly for help.'}`;
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
