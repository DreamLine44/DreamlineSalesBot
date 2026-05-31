/**
 * modules/fashion/flows/index.js
 * Fashion module — product catalog + variants + recommendations
 *
 * [FIX-FA-1] SELECT_COLOR step was listed in steps.ORDER but never implemented.
 *            Any customer who reached it hit the default branch which returned
 *            buildCatalogUI(), silently wiping their order state mid-flow.
 *            Added a full SELECT_COLOR case. SELECT_SIZE now routes to SELECT_COLOR
 *            when item.colors is configured, otherwise goes straight to QUANTITY.
 *
 * [FIX-FA-2] Payment path now uses buildPaymentInstructionsUI (shared, ICU-safe),
 *            stores paymentReference on the order, and notifies the admin with an
 *            interactive Approve/Reject card — consistent with restaurant orderFlow.
 *            The old inline plain-text payment message had no reference, no stored ref,
 *            and no admin notification.
 *
 * [FIX-FA-3] No-payment admin alert upgraded from plain dispatchText to an interactive
 *            Approve/Reject buttons card, consistent with restaurant orderFlow [FIX-3].
 *
 * [FIX-FA-4] Analytics/revenue tracking moved to BEFORE completeFlow. Previously they
 *            ran after the `if (_lcRf) return _lcRf` guard — if lead capture fired,
 *            completeFlow returned a response and the code returned early, silently
 *            skipping all analytics for that order.
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

export const FASHION_CONFIG = {
  businessMode: 'FASHION',
  flows: ['ORDER'],
  persona: 'stylish fashion consultant who helps customers find the perfect fit',
  steps: {
    ORDER: ['SELECT_ITEM', 'SELECT_SIZE', 'SELECT_COLOR', 'QUANTITY', 'CONFIRM'],
  },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: '👗 Shop Collection' },
      { id: 'QUESTION', title: '❓ Style Help'       },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '👗 Shop'     },
      { id: 'QUESTION', title: '❓ Question' },
    ],
    confirmButtons: [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
    upsellButtons:  [{ id: 'UPSELL_YES', title: '✅ Yes please' }, { id: 'UPSELL_NO', title: '❌ No thanks' }],
  },
  messages: {
    welcome:     "✨ Welcome! Let's find something perfect for you.",
    orderPrompt: '👗 Our latest collection — choose an item:',
    cancelMsg: '✅ No problem! Browse our collection anytime. 👗',
    fallback:    'Would you like to *browse our collection*, or do you have a *style question*?',
  },
};

const SIZES  = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'Free Size'];
const COLORS = ['Black', 'White', 'Red', 'Blue', 'Green', 'Yellow', 'Pink', 'Grey', 'Brown', 'Navy'];

export async function handleFashionOrder({ session, message, business, tenant, isInteractive }) {
  const raw   = String(message || '').trim();
  const clean = raw.toLowerCase();
  const step  = session.step || 'SELECT_ITEM';
  const data  = session.data || {};
  const menu  = (business?.menuItems || []).filter(i => i.available !== false);

  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', data: {}, menuViewed: false });
    return buildCatalogUI(business);
  }

  switch (step) {
    case 'SELECT_ITEM': {
      if (!isInteractive && !session.menuViewed && /^\d+$/.test(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
        return buildCatalogUI(business);
      }
      const numIdx = parseInt(raw, 10) - 1;
      let item = (!isNaN(numIdx) && menu[numIdx]) ? menu[numIdx] : null;
      if (!item) {
        const { item: matched, confidenceLevel } = findBestMatch(menu, clean);
        if (confidenceLevel === 'HIGH') item = matched;
        else if (confidenceLevel === 'LOW') {
          return { type: 'buttons', body: `Did you mean *${matched.name}*?`,
            buttons: [{ id: 'CONFIRM', title: `✅ Yes, ${matched.name}` }, { id: 'SHOW_MENU', title: '🔄 Start Over' }] };
        }
      }
      if (!item) return buildCatalogUI(business);

      // Check if item has variants
      if (item.variants?.length) {
        const sizeList = item.variants.map((v, i) => `*${i+1}.* ${v}`).join('\n');
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_SIZE', data: { item } });
        return {
          type: 'buttons',
          body: `✨ *${item.name}*${item.price ? ` — D${item.price}` : ''}\n\nWhat *size* would you like?\n\n${sizeList}`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      await updateSession(session.customerPhone, session.tenantId, { step: 'QUANTITY', data: { item } });
      return {
        type: 'buttons',
        body: `✨ *${item.name}* selected!\n\nHow many would you like?`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }

    case 'SELECT_SIZE': {
      const size = SIZES.find(s => clean.includes(s.toLowerCase())) || raw;
      // [FIX-FA-1] Route to SELECT_COLOR when the item has color options,
      // otherwise go straight to QUANTITY. Previously always went to QUANTITY,
      // making SELECT_COLOR unreachable despite being in the steps config.
      const itemColors = data.item?.colors || [];
      if (itemColors.length) {
        const colorList = itemColors.map((c, i) => `*${i+1}.* ${c}`).join('\n');
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_COLOR', data: { ...data, size } });
        return {
          type: 'buttons',
          body: `Size *${size}* ✅\n\nWhat *colour* would you like?\n\n${colorList}`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      await updateSession(session.customerPhone, session.tenantId, { step: 'QUANTITY', data: { ...data, size } });
      return {
        type: 'buttons',
        body: `Size *${size}* — got it! ✅\n\nHow many would you like?`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }

    // [FIX-FA-1] SELECT_COLOR — was in steps config but never implemented.
    case 'SELECT_COLOR': {
      const itemColors = data.item?.colors || [];
      const numIdx = parseInt(raw, 10) - 1;
      let color = (!isNaN(numIdx) && itemColors[numIdx]) ? itemColors[numIdx] : null;
      if (!color) {
        color = COLORS.find(c => clean.includes(c.toLowerCase()))
          || itemColors.find(c => clean.includes(c.toLowerCase()))
          || raw;
      }
      await updateSession(session.customerPhone, session.tenantId, { step: 'QUANTITY', data: { ...data, color } });
      return {
        type: 'buttons',
        body: `Colour *${color}* — perfect! ✅\n\nHow many would you like?`,
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
      const sizeStr = data.size ? ` (${data.size})` : '';
      return {
        type: 'buttons',
        body: `🧾 *Order Summary*\n\n👗 *${qty}× ${data.item?.name}${sizeStr}*${total ? `\n💰 D${total}` : ''}\n\nConfirm?`,
        buttons: [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
      };
    }

    case 'CONFIRM': {
      if (!/^(yes|y|confirm|ok)$/i.test(clean)) {
        return {
          type: 'buttons',
          body: '👗 Ready to place your order?',
          buttons: [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      const itemLabel = `${data.item?.name}${data.size ? ` (${data.size})` : ''}${data.color ? ` — ${data.color}` : ''}`;
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({ item: itemLabel,
          quantity: data.quantity, totalPrice: data.totalPrice,
          customerPhone: session.customerPhone, tenantId: session.tenantId, businessId: business._id });
      } catch (err) { logger.error('[FashionModule] saveOrder failed', { err: err.message }); }

      // [FIX-FA-4] Track analytics BEFORE completeFlow so they always fire even
      // when completeFlow triggers lead capture and returns early.
      trackOrderAnalytics(
        itemLabel, null, data.quantity, data.totalPrice || 0, session.tenantId
      ).catch(() => {});
      if (data.totalPrice) {
        recordRevenue({
          item: data.item?.name, quantity: data.quantity,
          revenue: data.totalPrice, tenantId: session.tenantId,
          customerPhone: session.customerPhone,
        }).catch(() => {});
      }

      // [FIX-FA-2] Payment path — use shared buildPaymentInstructionsUI, store ref, notify admin
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
                `🔔 *New Fashion Order — ${business.name || 'Shop'}*\n\n` +
                `👤 Customer: *${session.customerPhone}*\n` +
                `👗 Item: *${data.quantity}× ${itemLabel}*\n` +
                `💰 Total: *${currency}${data.totalPrice}*\n` +
                `📝 Ref: *${ref}*\n\n` +
                `⏳ Status: *Pending* — awaiting payment screenshot.`,
            }, tenant).catch(() => {});
          }
        } catch { /* non-fatal */ }

        return buildPaymentInstructionsUI(business, data.totalPrice, shortId, ref);
      }

      // [FIX-FA-3] No payment — notify admin with interactive Approve/Reject card
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { buildAdminOrderAlertBody } = await import('../../restaurant/handlers/uiBuilders.js');
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const alertBody = buildAdminOrderAlertBody({
            customerPhone: session.customerPhone,
            item: itemLabel,
            quantity: data.quantity, totalPrice: data.totalPrice,
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
        logger.warn('[FashionModule] Admin notification failed (non-fatal)', { err: err.message });
      }

      const _lcRf = await completeFlow(session, 'ORDER', business, tenant);
      if (_lcRf) return _lcRf;

      return {
        type: 'buttons',
        body: `✅ *Order confirmed!*\n\n👗 *${data.quantity}× ${itemLabel}*\n\nWe'll reach out with delivery details. Thank you! ✨`,
        buttons: [
          { id: 'ORDER',     title: '👗 Shop More'      },
          { id: 'QUESTION',  title: '❓ Style Help'      },
          { id: 'SHOW_MENU', title: '🔄 Start Over'      },
        ],
      };
    }

    default: return buildCatalogUI(business);
  }
}

function buildCatalogUI(business) {
  const items = (business?.menuItems || []).filter(i => i.available !== false);
  if (!items.length) {
    return {
      type:    'buttons',
      body:    '⚠️ Our collection is being updated. Please contact us or check back soon.',
      buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }],
    };
  }
  const rows = items.map((item, i) => ({
    id: String(i + 1), title: item.name.slice(0, 24),
    description: [item.description, item.price ? `D${item.price}` : ''].filter(Boolean).join(' — ').slice(0, 72),
  }));
  return { type: 'list', header: business?.name || 'Collection', body: "Our latest collection — choose an item:", buttonLabel: 'View Collection', rows };
}
