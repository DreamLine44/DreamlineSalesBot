/**
 * modules/fashion/flows/index.js
 * Fashion module — product catalog + variants + recommendations
 */
import { updateSession }  from '../../../core/sessions/sessionService.js';
import { getAIReply }     from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }  from '../../../utils/matchEngine.js';
import { saveOrder }      from '../../../services/orderService.js';
import { parseQuantity }  from '../../../utils/parseQuantity.js';
import { trackOrderAnalytics, recordRevenue } from '../../../core/analytics/analyticsService.js';
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
    // [FIX-FLOW-STUCK] Clear flow if collection is empty so session is not permanently stuck.
    const catalog = buildCatalogUI(business);
    if (!(business?.menuItems || []).filter(i => i.available !== false).length) {
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: null, step: null, data: {},
      });
      return catalog;
    }
    await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', data: {}, menuViewed: false });
    return catalog;
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
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_SIZE', data: { item } });
        // Show up to 3 variants as buttons; if more, use a list
        const variantButtons = item.variants.slice(0, 3).map(v => ({
          id: `SIZE_${String(v).toUpperCase().replace(/\s+/g, '_')}`,
          title: String(v),
        }));
        if (item.variants.length > 3) {
          return {
            type: 'list',
            body: `✨ *${item.name}*${item.price ? ` — D${item.price}` : ''}\n\nWhat *size* would you like?`,
            button: 'Choose size',
            sections: [{ title: 'Available Sizes', rows: item.variants.map(v => ({ id: `SIZE_${String(v).toUpperCase().replace(/\s+/g, '_')}`, title: String(v) })) }],
          };
        }
        return {
          type: 'buttons',
          body: `✨ *${item.name}*${item.price ? ` — D${item.price}` : ''}\n\nWhat *size* would you like?`,
          buttons: [...variantButtons, { id: 'CANCEL', title: '❌ Cancel' }].slice(0, 3),
        };
      }
      await updateSession(session.customerPhone, session.tenantId, { step: 'QUANTITY', data: { item } });
      return {
        type: 'buttons',
        body: `✨ *${item.name}* selected!\n\nHow many would you like?`,
        buttons: [
          { id: 'QTY_1', title: '1️⃣  1' },
          { id: 'QTY_2', title: '2️⃣  2' },
          { id: 'QTY_3', title: '3️⃣  3' },
        ],
        footer: 'Or type any number e.g. 4, 5',
      };
    }

    case 'SELECT_SIZE': {
      // Handle both button IDs (SIZE_XL) and typed values (XL, xl)
      const item = data.item;
      let size;
      if (raw.toUpperCase().startsWith('SIZE_')) {
        size = raw.slice(5).replace(/_/g, ' ');
        // Try to match back to item variants for proper casing
        if (item?.variants?.length) {
          const matched = item.variants.find(v => String(v).toUpperCase().replace(/\s+/g, '_') === raw.slice(5));
          if (matched) size = matched;
        }
      } else {
        size = SIZES.find(s => clean.includes(s.toLowerCase())) || raw;
      }

      // [UX-4] Route to SELECT_COLOR if the item has defined colors, or if the business
      // has a global color list. Skip the step cleanly when neither is present so the
      // flow doesn't stall at a step with no options.
      const itemColors = Array.isArray(item?.colors) && item.colors.length > 0
        ? item.colors
        : COLORS;
      const skipColor = item?.skipColor === true || (business?.settings?.skipColorStep === true);

      if (!skipColor) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_COLOR', data: { ...data, size } });
        const colorButtons = itemColors.slice(0, 9); // WhatsApp list max 10 rows per section
        if (colorButtons.length > 3) {
          return {
            type: 'list',
            body: `Size *${size}* — perfect! ✅\n\nWhat *colour* would you like?`,
            button: 'Choose colour',
            sections: [{
              title: 'Available Colours',
              rows: colorButtons.map(c => ({
                id:    `COLOR_${String(c).toUpperCase().replace(/\s+/g, '_')}`,
                title: String(c),
              })),
            }],
          };
        }
        return {
          type: 'buttons',
          body: `Size *${size}* — perfect! ✅\n\nWhat *colour* would you like?`,
          buttons: [
            ...colorButtons.slice(0, 2).map(c => ({
              id:    `COLOR_${String(c).toUpperCase().replace(/\s+/g, '_')}`,
              title: String(c),
            })),
            { id: 'COLOR_SKIP', title: '⏭ No preference' },
          ],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, { step: 'QUANTITY', data: { ...data, size } });
      return {
        type: 'buttons',
        body: `Size *${size}* — got it! ✅\n\nHow many would you like?`,
        buttons: [
          { id: 'QTY_1', title: '1️⃣  1' },
          { id: 'QTY_2', title: '2️⃣  2' },
          { id: 'QTY_3', title: '3️⃣  3' },
        ],
        footer: 'Or type any number',
      };
    }

    // [UX-4] SELECT_COLOR — was declared in config steps but never implemented.
    // Customers would silently skip colour selection; orders had no colour recorded.
    case 'SELECT_COLOR': {
      let color;
      if (raw.toUpperCase().startsWith('COLOR_')) {
        const colorKey = raw.slice(6);
        if (colorKey === 'SKIP') {
          color = null; // no preference
        } else {
          color = colorKey.replace(/_/g, ' ');
          // Try proper casing from COLORS list
          const matched = COLORS.find(c => c.toUpperCase().replace(/\s+/g, '_') === colorKey);
          if (matched) color = matched;
        }
      } else {
        color = COLORS.find(c => clean.includes(c.toLowerCase())) || (raw.length >= 2 ? raw : null);
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'QUANTITY', data: { ...data, color: color || null },
      });
      const colorConfirm = color ? `Colour *${color}* — ` : '';
      return {
        type: 'buttons',
        body: `${colorConfirm}got it! ✅\n\nHow many would you like?`,
        buttons: [
          { id: 'QTY_1', title: '1️⃣  1' },
          { id: 'QTY_2', title: '2️⃣  2' },
          { id: 'QTY_3', title: '3️⃣  3' },
        ],
        footer: 'Or type any number',
      };
    }

    case 'QUANTITY': {
      // Handle quick-pick buttons
      const QTY_SHORTCUTS = { 'QTY_1': 1, 'QTY_2': 2, 'QTY_3': 3 };
      const qty = QTY_SHORTCUTS[raw.toUpperCase()] ?? parseQuantity(raw);
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
      const sizeStr  = data.size  ? ` (${data.size})`  : '';
      const colorStr = data.color ? ` — ${data.color}` : '';
      return {
        type: 'buttons',
        body: `🧾 *Order Summary*\n\n👗 *${qty}× ${data.item?.name}${sizeStr}${colorStr}*${total ? `\n💰 D${total}` : ''}\n\nConfirm?`,
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
        savedOrder = await saveOrder({ item: `${data.item?.name}${data.size ? ` (${data.size})` : ''}${data.color ? ` — ${data.color}` : ''}`,
          quantity: data.quantity, totalPrice: data.totalPrice,
          customerName: session.customerName || null, // [FIX-SAVE-2]
          customerPhone: session.customerPhone, tenantId: session.tenantId, businessId: business._id });
      } catch (err) { logger.error('[FashionModule] saveOrder failed', { err: err.message }); }

      // [FIX-5] Payment flow — fashion was skipping payment even when payment.enabled=true
      const payment = business?.payment;
      if (payment?.enabled && data.totalPrice) {
        const { buildPaymentInstructionsUI } = await import('../../../services/paymentService.js');
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });
        // [FIX-PAYREF-FASHION] Generate and persist paymentReference — mirrors restaurant/bakery pattern.
        const shortIdRef = savedOrder?.shortId || '';
        let ref = null;
        if (shortIdRef) {
          const now = new Date();
          const mm  = String(now.getMonth() + 1).padStart(2, '0');
          const dd  = String(now.getDate()).padStart(2, '0');
          ref = `DSB-${mm}${dd}-${shortIdRef}`;
          if (savedOrder?._id) {
            const { default: Order } = await import('../../../models/Order.js');
            Order.updateOne({ _id: savedOrder._id }, { $set: { paymentReference: ref } }).catch(() => {});
          }
        }
        return buildPaymentInstructionsUI(business, data.totalPrice, shortIdRef || null, ref);
      }

      // No payment — notify admin with interactive APPROVE/REJECT buttons
      // [FIX-FASHION-ADMIN] Upgraded from dispatchText (no buttons) to dispatchMessage
      // with APPROVE_/REJECT_ buttons — admin can confirm or cancel with one tap.
      // Also parks session at AWAIT_ADMIN_CONFIRM so the customer waits for confirmation.
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { buildAdminOrderAlertBody } = await import('../../restaurant/handlers/uiBuilders.js');
          const alertBody = buildAdminOrderAlertBody({
            customerPhone: session.customerPhone,
            item: `${data.item?.name}${data.size ? ` (${data.size})` : ''}`,
            quantity: data.quantity, totalPrice: data.totalPrice,
            shortId: savedOrder.shortId, business,
          });
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          await dispatchMessage(adminPhone, {
            type:    'buttons',
            body:    alertBody,
            buttons: [
              { id: `APPROVE_${savedOrder.shortId}`, title: '✅ Confirm Order' },
              { id: `REJECT_${savedOrder.shortId}`,  title: '❌ Cancel Order'  },
            ],
          }, tenant).catch(() => {});
        }
      } catch {}

      // Track analytics + revenue BEFORE parking session
      trackOrderAnalytics(
        `${data.item?.name}${data.size ? ` (${data.size})` : ''}`,
        null, data.quantity, data.totalPrice || 0, session.tenantId
      ).catch(() => {});
      if (data.totalPrice) {
        recordRevenue({
          item: data.item?.name, quantity: data.quantity,
          revenue: data.totalPrice, tenantId: session.tenantId,
          customerPhone: session.customerPhone,
        }).catch(() => {});
      }

      // Park session at AWAIT_ADMIN_CONFIRM so stale buttons don't restart the flow
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER',
        data: { ...data },
      });

      // [FIX-FASHION-WAIT] Do NOT call completeFlow here — that clears currentFlow/step
      // and contradicts the AWAIT_ADMIN_CONFIRM park above. The session stays parked until
      // the admin confirms/rejects via APPROVE_/REJECT_ buttons. Customer gets a waiting message.
      return {
        type: 'text',
        body: `✅ *Order received!*\n\n👗 *${data.quantity}× ${data.item?.name}${data.size ? ` (${data.size})` : ''}*\n\n⏳ Our team will confirm your order shortly. We'll send you a message when it's ready! 🙏`,
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
  return { type: 'list', header: business?.name || 'Collection', body: "Our latest collection — choose an item:", button: 'View Collection', rows };
}
