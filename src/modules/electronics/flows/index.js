/**
 * modules/electronics/flows/index.js
 * Electronics module — specs · warranty · accessories · compatibility
 *
 * [FIX-EL-1] Payment path now uses buildPaymentInstructionsUI (shared, ICU-safe),
 *            stores paymentReference on the order, and notifies the admin with a
 *            pending-payment alert — consistent with restaurant orderFlow.
 *
 * [FIX-EL-2] No-payment admin alert upgraded from plain dispatchText to an
 *            interactive Approve/Reject buttons card, consistent with [FIX-3].
 *
 * [FIX-EL-3] Analytics/revenue tracking moved to BEFORE completeFlow to ensure
 *            they fire even when lead capture intercepts and returns early.
 */
import { updateSession }  from '../../../core/sessions/sessionService.js';
import { completeFlow }   from '../../../core/conversations/flowEngine.js';
import { getAIReply }     from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }  from '../../../utils/matchEngine.js';
import { saveOrder }      from '../../../services/orderService.js';
import { parseQuantity }  from '../../../utils/parseQuantity.js';
import { trackOrderAnalytics, recordRevenue } from '../../../core/analytics/analyticsService.js';
import { buildPaymentInstructionsUI } from '../../../services/paymentService.js';
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
    cancelMsg: '✅ No problem! What would you like to do?',
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
            buttons: [{ id: 'CONFIRM', title: `✅ Yes` }, { id: 'SHOW_MENU', title: '🔄 Start Over' }] };
        }
      }
      if (!item) {
        // Maybe asking about specs — use AI
        const aiReply = await getAIReply({ customerMessage: raw, business, session, intent: 'SPEC_REQUEST' });
        return {
          type: 'buttons',
          body: aiReply || "I couldn't find that product. Here's our catalogue:",
          buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
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
      const MAX_QTY = business?.settings?.maxOrderQuantity || 20;
      if (!qty || qty < 1) {
        return {
          type:    'buttons',
          body:    `Please enter a number — e.g. *1*, *2*, *three*\n\n_(Maximum: ${MAX_QTY} per order)_`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      if (qty > MAX_QTY) {
        return {
          type:    'buttons',
          body:    `⚠️ Maximum order quantity is *${MAX_QTY}*. Please enter a number between *1* and *${MAX_QTY}*.`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
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
        return {
          type:    'buttons',
          body:    '📱 Ready to place your order?',
          buttons: [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({ item: data.item?.name, quantity: data.quantity, totalPrice: data.totalPrice,
          customerPhone: session.customerPhone, tenantId: session.tenantId, businessId: business._id });
      } catch (err) { logger.error('[ElectronicsModule] saveOrder failed', { err: err.message }); }

      // [FIX-EL-3] Track analytics BEFORE completeFlow so they fire even when
      // lead capture intercepts and returns early.
      trackOrderAnalytics(data.item?.name, null, data.quantity, data.totalPrice || 0, session.tenantId).catch(() => {});
      if (data.totalPrice) {
        recordRevenue({ item: data.item?.name, quantity: data.quantity, revenue: data.totalPrice, tenantId: session.tenantId, customerPhone: session.customerPhone }).catch(() => {});
      }

      // [FIX-EL-1] Payment path — use shared buildPaymentInstructionsUI, store ref, notify admin
      const payment = business?.payment;
      if (payment?.enabled && data.totalPrice) {
        const shortId = savedOrder?.shortId || '';
        const now = new Date();
        const mm  = String(now.getMonth() + 1).padStart(2, '0');
        const dd  = String(now.getDate()).padStart(2, '0');
        const ref = `DSB-${mm}${dd}-${shortId}`;

        if (savedOrder?._id) {
          const { default: Order } = await import('../../../models/Order.js');
          Order.updateOne({ _id: savedOrder._id }, { $set: { paymentReference: ref } }).catch(() => {});
        }

        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });

        // Notify admin of pending payment order
        try {
          const adminPhone = business?.adminPhone || tenant?.adminPhone;
          if (adminPhone && tenant && savedOrder) {
            const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
            const currency = payment.currency || 'D';
            await dispatchMessage(adminPhone, {
              type: 'text',
              body:
                `🔔 *New Electronics Order — ${business.name || 'Shop'}*\n\n` +
                `👤 Customer: *${session.customerPhone}*\n` +
                `📱 Item: *${data.quantity}× ${data.item?.name}*\n` +
                `💰 Total: *${currency}${data.totalPrice}*\n` +
                `📝 Ref: *${ref}*\n\n` +
                `⏳ Status: *Pending* — awaiting payment screenshot.`,
            }, tenant).catch(() => {});
          }
        } catch { /* non-fatal */ }

        return buildPaymentInstructionsUI(business, data.totalPrice, shortId, ref);
      }

      // [FIX-EL-2] No payment — interactive Approve/Reject card instead of plain text
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { buildAdminOrderAlertBody } = await import('../../restaurant/handlers/uiBuilders.js');
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const alertBody = buildAdminOrderAlertBody({
            customerPhone: session.customerPhone,
            item: data.item?.name, quantity: data.quantity, totalPrice: data.totalPrice,
            shortId: savedOrder.shortId, business,
          });
          await dispatchMessage(adminPhone, {
            type:    'buttons',
            body:    alertBody,
            buttons: [
              { id: `APPROVE_${savedOrder.shortId}`, title: '✅ Confirm Received' },
              { id: `REJECT_${savedOrder.shortId}`,  title: '❌ Cancel Order'     },
            ],
          }, tenant).catch(() => {});
        }
      } catch (err) {
        logger.warn('[ElectronicsModule] Admin notification failed (non-fatal)', { err: err.message });
      }

      const _lcRe = await completeFlow(session, 'ORDER', business, tenant);
      if (_lcRe) return _lcRe;

      return {
        type: 'buttons',
        body: `✅ *Order received!*\n\n📦 *${data.quantity}× ${data.item?.name}*\n\nWe'll verify stock and reach out with delivery details. Thank you! 📱`,
        buttons: [
          { id: 'ORDER',     title: '📱 Browse More'  },
          { id: 'QUESTION',  title: '❓ Ask a Question' },
          { id: 'SHOW_MENU', title: '🔄 Start Over'    },
        ],
      };
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
    return {
      type:    'buttons',
      body:    'What product or spec would you like help with? 📱',
      buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
    };
  }

  const aiReply = await getAIReply({ customerMessage: raw, business, session, intent: 'SPEC_REQUEST' });
  return {
    type: 'buttons',
    body: aiReply || 'Great question! Let me find the specs for you. 📱',
    buttons: [
      { id: 'ORDER',     title: '📱 Buy Now'        },
      { id: 'QUESTION',  title: '❓ More Questions'  },
      { id: 'SHOW_MENU', title: '🔄 Start Over' },
    ],
  };
}

function buildProductCatalog(business) {
  const items = (business?.menuItems || []).filter(i => i.available !== false);
  if (!items.length) {
    return {
      type:    'buttons',
      body:    '⚠️ Our catalogue is being updated. Please contact us or check back soon.',
      buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }],
    };
  }
  const rows = items.map((item, i) => ({
    id: String(i + 1), title: item.name.slice(0, 24),
    description: [item.description, item.price ? `D${item.price}` : ''].filter(Boolean).join(' — ').slice(0, 72),
  }));
  return { type: 'list', header: business?.name || 'Products', body: "Here's our product range:", buttonLabel: 'Browse Products', rows };
}
