/**
 * modules/fashion/flows/index.js
 * Fashion module — product catalog + variants + recommendations
 */
import { updateSession }  from '../../../core/sessions/sessionService.js';
import { completeFlow }   from '../../../core/conversations/flowEngine.js';
import { getAIReply }     from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }  from '../../../utils/matchEngine.js';
import { saveOrder }      from '../../../services/orderService.js';
import { parseQuantity }  from '../../../utils/parseQuantity.js';
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
      await updateSession(session.customerPhone, session.tenantId, { step: 'QUANTITY', data: { ...data, size } });
      return {
        type: 'buttons',
        body: `Size *${size}* — got it! ✅\n\nHow many would you like?`,
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
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({ item: `${data.item?.name}${data.size ? ` (${data.size})` : ''}`,
          quantity: data.quantity, totalPrice: data.totalPrice,
          customerPhone: session.customerPhone, tenantId: session.tenantId, businessId: business._id,
          status: (business?.payment?.enabled && data.totalPrice) ? 'pending_payment' : 'confirmed' });
      } catch (err) { logger.error('[FashionModule] saveOrder failed', { err: err.message }); }

      // [FIX-5] Payment flow — fashion was skipping payment even when payment.enabled=true
      const payment = business?.payment;
      if (payment?.enabled && data.totalPrice) {
        const waveNo = payment.wavePhone || payment.phone || 'N/A';
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });
        return {
          type: 'text',
          body: `💳 *Payment*\n\nTotal: *D${data.totalPrice}*\nSend via *Wave* to: *${waveNo}*\n\nAfter paying, send your *screenshot* here. 📸`,
        };
      }

      // No payment — notify admin
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { buildAdminOrderAlert } = await import('../../restaurant/handlers/uiBuilders.js');
          const alert = buildAdminOrderAlert({
            customerPhone: session.customerPhone,
            item: `${data.item?.name}${data.size ? ` (${data.size})` : ''}`,
            quantity: data.quantity, totalPrice: data.totalPrice,
            shortId: savedOrder.shortId, business,
          });
          const { dispatchText } = await import('../../../core/whatsapp/dispatcher.js');
          dispatchText(adminPhone, alert, tenant).catch(() => {});
        }
      } catch {}

      await completeFlow(session, 'ORDER');
      return {
        type: 'buttons',
        body: `✅ *Order confirmed!*\n\n👗 *${data.quantity}× ${data.item?.name}*\n\nWe'll reach out with delivery details. Thank you! ✨`,
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
