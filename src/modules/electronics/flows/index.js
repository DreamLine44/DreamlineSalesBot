/**
 * modules/electronics/flows/index.js
 * Electronics module — specs · warranty · accessories · compatibility
 */
import { updateSession }  from '../../../core/sessions/sessionService.js';
import { completeFlow }   from '../../../core/conversations/flowEngine.js';
import { getAIReply }     from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }  from '../../../utils/matchEngine.js';
import { saveOrder }      from '../../../services/orderService.js';
import { parseQuantity }  from '../../../utils/parseQuantity.js';
import logger             from '../../../config/logger.js';

export const ELECTRONICS_CONFIG = {
  businessMode: 'ELECTRONICS',
  flows: ['ORDER'],
  persona: 'knowledgeable electronics expert who answers spec questions accurately and helps customers pick the right product',
  steps: {
    ORDER: ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
  },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: '📱 Browse Products' },
      { id: 'QUESTION', title: '❓ Tech Question'   },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '📱 Browse'   },
      { id: 'QUESTION', title: '❓ Question' },
    ],
    confirmButtons: [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
    upsellButtons:  [{ id: 'UPSELL_YES', title: '✅ Add it' }, { id: 'UPSELL_NO', title: '❌ No thanks' }],
  },
  messages: {
    welcome:   "📱 Welcome! Looking for the best tech deals? Let's find the right product for you.",
    cancelMsg: '✅ Order cancelled. Type *Browse* to shop again. 📱',
    fallback:  'Would you like to *browse products*, get *tech advice*, or place an *order*?',
  },
};

export async function handleElectronicsOrder({ session, message, business, tenant, isInteractive }) {
  const raw   = String(message || '').trim();
  const clean = raw.toLowerCase();
  const step  = session.step || 'SELECT_ITEM';
  const data  = session.data || {};
  const menu  = (business?.menuItems || []).filter(i => i.available !== false);

  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', data: {}, menuViewed: false });
    return buildProductCatalog(business);
  }

  switch (step) {
    case 'SELECT_ITEM': {
      // Guard: number without viewing catalog
      if (!isInteractive && !session.menuViewed && /^\d+$/.test(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
        return buildProductCatalog(business);
      }
      if (clean.length < 3) return buildProductCatalog(business);

      const numIdx = parseInt(raw, 10) - 1;
      let item = (!isNaN(numIdx) && menu[numIdx]) ? menu[numIdx] : null;
      if (!item) {
        const { item: m, confidenceLevel } = findBestMatch(menu, clean);
        if (confidenceLevel === 'HIGH') item = m;
        else if (confidenceLevel === 'LOW') {
          return { type: 'buttons', body: `Did you mean *${m.name}*?`,
            buttons: [{ id: 'CONFIRM', title: `✅ Yes` }, { id: 'SHOW_MENU', title: '📋 Browse' }] };
        }
      }
      if (!item) {
        // Maybe asking about specs — use AI
        const aiReply = await getAIReply({ customerMessage: raw, business, session, intent: 'SPEC_REQUEST' });
        return {
          type: 'buttons',
          body: aiReply || "I couldn't find that product. Here's our catalogue:",
          buttons: [{ id: 'SHOW_MENU', title: '📱 Browse Products' }],
        };
      }
      // Show spec + upsell accessories
      const specStr = item.description ? `\n\n📋 *${item.description}*` : '';
      await updateSession(session.customerPhone, session.tenantId, { step: 'QUANTITY', data: { item }, menuViewed: true });
      return {
        type: 'buttons',
        body: `📱 *${item.name}*${item.price ? ` — D${item.price}` : ''}${specStr}\n\nHow many would you like?`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }

    case 'QUANTITY': {
      // [FIX] parseInt(raw,10)||1 silently coerces 'five' or '' to 1.
      // Use parseQuantity() which handles word numbers and validates range.
      const qty = parseQuantity(raw);
      if (!qty || qty < 1 || qty > 99) {
        return { type: 'text', body: 'Please enter a valid quantity (e.g. *1*, *2*, *three*)' };
      }
      const total = (data.item?.price || 0) * qty;
      await updateSession(session.customerPhone, session.tenantId, { step: 'CONFIRM', data: { ...data, quantity: qty, totalPrice: total } });
      return {
        type: 'buttons',
        body: `🧾 *Order Summary*\n\n📱 *${qty}× ${data.item?.name}*${total ? `\n💰 D${total}` : ''}\n\nConfirm?`,
        buttons: [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
      };
    }

    case 'CONFIRM': {
      if (!/^(yes|y|confirm|ok)$/i.test(clean)) {
        return { type: 'text', body: 'Tap *Confirm* to place your order.' };
      }
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({ item: data.item?.name, quantity: data.quantity, totalPrice: data.totalPrice,
          customerPhone: session.customerPhone, tenantId: session.tenantId, businessId: business._id });
      } catch (err) { logger.error('[ElectronicsModule] saveOrder failed', { err: err.message }); }

      // FIX #15 — analytics
      try {
        const { trackOrderAnalytics, recordRevenue } = await import('../../../core/analytics/analyticsService.js');
        trackOrderAnalytics(data.item?.name, session.phoneNumberId, data.quantity, data.totalPrice, session.tenantId).catch(() => {});
        if (data.totalPrice) recordRevenue({ item: data.item?.name, quantity: data.quantity, revenue: data.totalPrice, tenantId: session.tenantId, customerPhone: session.customerPhone, phoneNumberId: session.phoneNumberId }).catch(() => {});
      } catch { /* non-fatal */ }

      // FIX #16 — admin notification
      const adminPhone = business?.adminPhone || tenant?.adminPhone;
      if (adminPhone && tenant) {
        const { dispatchText } = await import('../../../core/whatsapp/dispatcher.js');
        const adminMsg =
          `📱 *New Electronics Order*\n\n` +
          `Item: *${data.item?.name}* × ${data.quantity || 1}\n` +
          `${data.totalPrice ? `Total: *D${data.totalPrice}*\n` : ''}` +
          `Customer: ${session.customerPhone}\n` +
          (savedOrder?.shortId ? `Ref: \`${savedOrder.shortId}\`` : '');
        dispatchText(adminPhone, adminMsg, tenant).catch(() => {});
      }

      // FIX #14 — payment gate
      if (business?.payment?.enabled && data.totalPrice) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'PAYMENT_PROOF' });
        const { buildPaymentInstructionsUI } = await import('../../../services/paymentService.js');
        const last4 = savedOrder?._id?.toString().slice(-4) || '****';
        return buildPaymentInstructionsUI(business, data.totalPrice, last4);
      }

      await completeFlow(session, 'ORDER');
      return { type: 'text', body: `✅ *Order received!*\n\n📦 *${data.quantity}× ${data.item?.name}*\n\nWe'll verify stock and reach out with delivery details. Thank you! 📱` };
    }

    default: return buildProductCatalog(business);
  }
}

/** Spec request handler — AI-powered technical answers */
export async function handleSpecRequest({ session, message, business, tenant }) {
  // [FIX] Handle init (message === null) — flowEngine.startFlow calls handler with null.
  // Without this guard, String(null || '') = '' is passed to AI which returns an unhelpful reply.
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, { step: 'SPEC_QUESTION', data: {} });
    return {
      type: 'text',
      body: '📱 *Product Specs*\n\nWhat would you like to know? Type your question or the product name.',
    };
  }

  const raw = String(message || '').trim();
  if (!raw) {
    return { type: 'text', body: 'What product or spec would you like help with? 📱' };
  }

  const aiReply = await getAIReply({ customerMessage: raw, business, session, intent: 'SPEC_REQUEST' });
  return {
    type: 'buttons',
    body: aiReply || 'Great question! Let me find the specs for you. 📱',
    buttons: [
      { id: 'ORDER',     title: '📱 Buy Now'        },
      { id: 'QUESTION',  title: '❓ More Questions'  },
      { id: 'SHOW_MENU', title: '🏠 Back to Menu'   },
    ],
  };
}

function buildProductCatalog(business) {
  const items = (business?.menuItems || []).filter(i => i.available !== false);
  if (!items.length) return { type: 'text', body: '⚠️ Catalogue not available. Please contact us.' };
  const rows = items.map((item, i) => ({
    id: String(i + 1), title: item.name.slice(0, 24),
    description: [item.description, item.price ? `D${item.price}` : ''].filter(Boolean).join(' — ').slice(0, 72),
  }));
  return { type: 'list', header: business?.name || 'Products', body: "Here's our product range:", buttonLabel: 'Browse Products', rows };
}
