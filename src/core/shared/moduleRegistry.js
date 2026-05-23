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
  ['RESTAURANT','SALON','BARBERSHOP','BAKERY','COSMETICS','DELIVERY'].forEach(mode => {
    registerFlow(mode, 'BOOKING', handleBookingFlow);
  });
  registerGenericFlow('BOOKING', handleBookingFlow);

  // ── Restaurant ─────────────────────────────────────────────────────────────
  const { handleOrderFlow }        = await import('../../modules/restaurant/flows/orderFlow.js');
  registerFlow('RESTAURANT', 'ORDER', handleOrderFlow);
  registerFlow('RETAIL',     'ORDER', handleOrderFlow);
  registerFlow('SUPERMARKET','ORDER', handleOrderFlow);
  registerFlow('PHARMACY',   'ORDER', handleOrderFlow);
  registerFlow('DELIVERY',   'ORDER', handleOrderFlow);
  registerGenericFlow('ORDER', handleOrderFlow);

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

  registerAction('REPEAT_ORDER', async ({ session, message, business, tenant }) => {
    const { getLastOrder }  = await import('../../services/orderService.js');
    const { startFlow }     = await import('../conversations/flowEngine.js');
    const { updateSession } = await import('../sessions/sessionService.js');

    // [FIX] getLastOrder returns full doc (with price). Without price, QUANTITY step
    // computes totalPrice = 0 * qty = D0 and shows the customer an incorrect D0 total.
    const lastOrder = await getLastOrder(session.customerPhone, session.tenantId).catch(() => null);
    if (lastOrder?.item) {
      const savedUnit = (lastOrder.totalPrice && lastOrder.quantity)
        ? Math.round(lastOrder.totalPrice / lastOrder.quantity) : 0;
      const liveItem  = (business?.menuItems || []).find(
        i => i.name?.toLowerCase() === lastOrder.item?.toLowerCase()
      );
      const item = liveItem || { name: lastOrder.item, price: savedUnit };

      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER', step: 'QUANTITY',
        data: { item }, menuViewed: true,
      });
      return {
        type: 'buttons',
        body: `🔁 *Repeat your last order*\n\nYou ordered *${item.name}*${item.price ? \` — D\${item.price} each\` : ''}.\n\nHow many would you like this time?`,
        buttons: [
          { id: 'QTY_1', title: '1️⃣ One'   },
          { id: 'QTY_2', title: '2️⃣ Two'   },
          { id: 'QTY_3', title: '3️⃣ Three' },
        ],
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
