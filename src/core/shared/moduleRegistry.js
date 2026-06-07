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
  const { handleOrderFlow }        = await import('../../modules/restaurant/flows/orderFlow.js');
  registerFlow('RESTAURANT', 'ORDER', handleOrderFlow);
  registerFlow('SUPERMARKET','ORDER', handleOrderFlow); // SUPERMARKET: still shares restaurant logic
  registerFlow('PHARMACY',   'ORDER', handleOrderFlow); // PHARMACY: still shares restaurant logic
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

  // ── Salon / Barbershop ─────────────────────────────────────────────────────
  const { handleSalonBooking } = await import('../../modules/salon/flows/index.js');
  registerFlow('SALON',      'BOOKING', handleSalonBooking);
  registerFlow('BARBERSHOP', 'BOOKING', handleSalonBooking);

  // ── Fashion ────────────────────────────────────────────────────────────────
  const { handleFashionOrder } = await import('../../modules/fashion/flows/index.js');
  registerFlow('FASHION', 'ORDER', handleFashionOrder);

  // ── Cosmetics ──────────────────────────────────────────────────────────────
  const { handleCosmeticsOrder, handleCosmeticsBooking, handleSkincareAdvice } = await import('../../modules/cosmetics/flows/index.js');
  registerFlow('COSMETICS', 'ORDER',           handleCosmeticsOrder);
  registerFlow('COSMETICS', 'BOOKING',         handleCosmeticsBooking);
  registerFlow('COSMETICS', 'SKINCARE_ADVICE', handleSkincareAdvice);

  // ── Electronics ────────────────────────────────────────────────────────────
  const { handleElectronicsOrder, handleSpecRequest } = await import('../../modules/electronics/flows/index.js');
  registerFlow('ELECTRONICS', 'ORDER',        handleElectronicsOrder);
  registerFlow('ELECTRONICS', 'SPEC_REQUEST', handleSpecRequest);

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

  registerAction('ENQUIRY', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'ENQUIRY', session, business, tenant });
  });

  // [FIX-3] QUESTION action — routes the QUESTION button tap to the mode-specific
  // QUESTION flow (SERVICES: handleServicesQuestion, GENERAL: handleGeneralQuestion).
  // Previously QUESTION intent mapped to ENQUIRY action which was intercepted by the
  // webhookController inline shortcut, bypassing ACTION_REGISTRY entirely. QUESTION
  // is now in FLOW_PASSTHROUGH_IDS so it reaches route() → ACTION_REGISTRY → here.
  // For modes without a QUESTION flow registered, startFlow falls back gracefully
  // (flowEngine logs a warning and returns a "not available" prompt with menu buttons).
  registerAction('QUESTION', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'QUESTION', session, business, tenant });
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
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER', step: 'QUANTITY',
        data: { item: { name: lastItem } }, menuViewed: true,
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
