/**
 * modules/retail/flows/index.js
 *
 * RETAIL mode — dedicated flow for physical retail stores.
 * Not the generic restaurant order logic — proper retail personality with:
 *   - Category-first browsing (if categories exist on menu items)
 *   - Variant / size awareness
 *   - Stock-check friendly messaging
 *   - In-store pick-up vs delivery selection
 *   - Wishlisting / hold request for out-of-stock
 *
 * Flows:
 *   ORDER   — browse → category → item → variant → quantity → fulfilment → confirm
 *   ENQUIRY — product availability / stock check via AI
 *
 * [MULTICART-FLOW-1] SELECT_ITEM → [CART_REVIEW ↔ (checkout)] → SELECT_VARIANT →
 * QUANTITY → FULFILMENT → CONFIRM → [PAYMENT?]. CART_REVIEW is only entered when a
 * message names 2+ known items at once AND every matched item has zero variants
 * (see utils/multiItemParser.js and modules/restaurant/flows/orderFlow.js for the
 * full rationale) — retail has no per-cart-line variant-selection sub-step, so an
 * item with variants always falls through to the existing single-item
 * SELECT_VARIANT flow unchanged rather than silently guessing "no variant".
 * Checkout from CART_REVIEW skips SELECT_VARIANT/QUANTITY straight into FULFILMENT.
 */

import { updateSession }  from '../../../core/sessions/sessionService.js';
import { completeFlow }   from '../../../core/conversations/flowEngine.js';
import { getAIReply }     from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }  from '../../../utils/matchEngine.js';
import { extractCartLines } from '../../../utils/multiItemParser.js';
import { buildWhatsAppImageUrl } from '../../../config/cloudinary.js';
import { saveOrder }      from '../../../services/orderService.js';
import { parseQuantity }  from '../../../utils/parseQuantity.js';
import { trackOrderAnalytics } from '../../../core/analytics/analyticsService.js';
import { itemLabel as _itemLabel } from '../../../utils/itemLabel.js';
import logger             from '../../../config/logger.js';

// [MULTICART-FLOW-1] A matched cart line is only eligible for the no-variant-picker
// cart flow if the item has no variants to choose between — retail has no per-line
// variant-selection sub-step, so an item with variants must go through the existing
// single-item SELECT_VARIANT flow instead of silently defaulting to "no variant".
const _hasNoVariants = (l) => !(l.item.variants && l.item.variants.length > 0);

// ── Config ────────────────────────────────────────────────────────────────────

export const RETAIL_CONFIG = {
  businessMode: 'RETAIL',
  flows: ['ORDER'],
  persona: 'a friendly retail shop assistant who helps customers find the right product and checks stock availability',
  steps: {
    ORDER: ['BROWSE_CATEGORY', 'SELECT_ITEM', 'SELECT_VARIANT', 'QUANTITY', 'FULFILMENT', 'CONFIRM'],
  },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',     title: '🛍 Shop Now'          },
      { id: 'SHOW_MENU', title: '📋 View All Products'  },
      { id: 'QUESTION',  title: '❓ Product Query'      },
    ],
    fallbackButtons: [
      { id: 'ORDER',     title: '🛍 Shop'      },
      { id: 'SHOW_MENU', title: '📋 Products'  },
      { id: 'QUESTION',  title: '❓ Ask'        },
    ],
    confirmButtons: [
      { id: 'CONFIRM', title: '✅ Confirm Order' },
      { id: 'CANCEL',  title: '❌ Cancel'         },
    ],
  },
  messages: {
    welcome:      '🛍 Welcome! What are you shopping for today?\n\nBrowse our products or type what you\'re looking for.',
    orderPrompt:  '🛍 Our products — what catches your eye?',
    cancelMsg:    '✅ No problem! Come back anytime — we\'re always here. 🛍',
    fallback:     'Would you like to *browse products*, place an *order*, or ask a *question*?',
  },
};

// ── Main Order Flow ───────────────────────────────────────────────────────────

export async function handleRetailOrder({ session, message, business, tenant, isInteractive }) {
  const raw   = String(message || '').trim();
  const clean = raw.toLowerCase();
  const step  = session.step || 'BROWSE_CATEGORY';
  const data  = session.data || {};
  const menu  = (business?.menuItems || []).filter(i => i.available !== false);

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    // [FIX-FLOW-STUCK] Clear flow if no products are available so session is not permanently stuck.
    if (!menu.length) {
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: null, step: null, data: {},
      });
      return _buildProductList(menu, business); // returns empty-catalogue UI
    }
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'BROWSE_CATEGORY',
      data: {},
      menuViewed: false,
    });

    const categories = _getCategories(menu);
    if (categories.length > 1) {
      return _buildCategoryUI(categories, business);
    }
    // No categories — go straight to product list
    await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', menuViewed: true });
    return _buildProductList(menu, business);
  }

  switch (step) {

    // ── BROWSE_CATEGORY ───────────────────────────────────────────────────────
    case 'BROWSE_CATEGORY': {
      const categories = _getCategories(menu);

      // If they pressed a category button
      const catMatch = categories.find(c => raw.toUpperCase() === `CAT_${c.toUpperCase().replace(/\s+/g, '_')}`);
      if (catMatch) {
        const filtered = menu.filter(i => (i.category || 'General') === catMatch);
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'SELECT_ITEM',
          data: { ...data, category: catMatch },
          menuViewed: true,
        });
        return _buildProductList(filtered, business, catMatch);
      }

      // They typed something — treat as a search
      if (raw.length >= 2) {
        const { item, confidenceLevel } = findBestMatch(menu, clean);
        if (confidenceLevel === 'HIGH' || confidenceLevel === 'MEDIUM') {
          await updateSession(session.customerPhone, session.tenantId, {
            step: 'SELECT_VARIANT',
            data: { ...data, item },
            menuViewed: true,
          });
          return _buildItemDetail(item, business); // [FIX-RETAIL-BUSINESS-SCOPE]
        }
        // Low confidence — show all products
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', menuViewed: true });
        return {
          type: 'buttons',
          body: `🔍 Searching for *"${raw}"*...\n\nHere's what we have:`,
          buttons: [{ id: 'SHOW_MENU', title: '📋 All Products' }, { id: 'CANCEL', title: '❌ Cancel' }],
        };
      }

      return _buildCategoryUI(categories, business);
    }

    // ── SELECT_ITEM ───────────────────────────────────────────────────────────
    case 'SELECT_ITEM': {
      // [AUDIT-FIX-RETAIL-SCOPEDINDEX] When a category is active, row ids in
      // _buildProductList are 1-based positions WITHIN that filtered list —
      // but the old code always resolved numeric taps against the full,
      // unfiltered `menu`. A customer inside "Shoes" tapping row 2 could
      // silently receive the 2nd item of the ENTIRE catalogue instead of the
      // 2nd shoe — wrong item, wrong price, wrong order. Numeric/interactive
      // taps now resolve against the same scoped list that was rendered;
      // free-text search still searches the full catalogue (a customer may
      // legitimately type an item from a different category).
      const scopedMenu = data.category
        ? menu.filter(i => (i.category || 'General') === data.category)
        : menu;

      // Guard: number without viewing catalog
      if (!isInteractive && !session.menuViewed && /^\d+$/.test(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
        return _buildProductList(scopedMenu, business, data.category || null);
      }
      if (clean.length < 2) return _buildProductList(scopedMenu, business, data.category || null);

      // [MULTICART-FLOW-1] Only branches into the cart flow when 2+ distinct KNOWN
      // items are named in this one message AND none of them have variants — a
      // single match, a zero match, or any matched item carrying variants all fall
      // straight through to the existing index/fuzzy logic below unchanged.
      const cartParse = extractCartLines(raw, menu);
      if (cartParse.matchedCount >= 2 && cartParse.lines.every(_hasNoVariants)) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'CART_REVIEW', data: { ...data, cart: cartParse.lines }, menuViewed: true,
        });
        return _buildCartSummaryUI(cartParse.lines, business);
      }

      // [AUDIT-FIX-PARSEINT] parseInt("2 red shirts", 10) === 2, NOT NaN — so any
      // message merely STARTING with a digit silently hijacked the menu index
      // once menuViewed was true (the normal case). Only trust the parsed index
      // for a bare number or an interactive tap; everything else falls through
      // to fuzzy name matching below.
      const isPureNumeric = /^\d+$/.test(raw.trim());
      const numIdx = (isInteractive || isPureNumeric) ? parseInt(raw, 10) - 1 : NaN;
      let item = (!isNaN(numIdx) && scopedMenu[numIdx]) ? scopedMenu[numIdx] : null;

      if (!item) {
        const { item: m, confidenceLevel } = findBestMatch(menu, clean);
        if (confidenceLevel === 'HIGH') {
          item = m;
        } else if (confidenceLevel === 'LOW') {
          return {
            type: 'buttons',
            body: `Did you mean *${m?.name}*?`,
            buttons: [
              { id: 'CONFIRM',   title: '✅ Yes'         },
              { id: 'SHOW_MENU', title: '🔄 Browse All'  },
            ],
          };
        }
      }

      if (!item) {
        // Stock check / product query via AI
        const aiReply = await getAIReply({
          customerMessage: raw,
          business,
          session,
          intent: 'PRODUCT_QUERY',
        });
        return {
          type: 'buttons',
          body: aiReply || `I couldn't find *"${raw}"* — here's what we have in stock:`,
          buttons: [
            { id: 'SHOW_MENU', title: '📋 Browse All'    },
            { id: 'QUESTION',  title: '❓ Ask About Stock' },
          ],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'SELECT_VARIANT',
        data: { ...data, item },
        menuViewed: true,
      });
      return _buildItemDetail(item, business); // [FIX-RETAIL-BUSINESS-SCOPE]
    }

    // ── CART_REVIEW ──────────────────────────────────────────────────────────
    // [MULTICART-FLOW-1] Reached only after a message named 2+ known, variant-free
    // items at once.
    case 'CART_REVIEW': {
      const cart = Array.isArray(data.cart) ? data.cart : [];

      const wantsCheckout = /^(checkout|check\s*out|confirm|done|finish|that'?s all|cart_checkout|place\s*order)$/i.test(clean);
      if (wantsCheckout) {
        if (!cart.length) return _buildProductList(menu, business);
        // [MULTICART-FLOW-1] Cart items have no variants (gated on entry) and
        // quantities are already known per line, so checkout skips
        // SELECT_VARIANT/QUANTITY straight into FULFILMENT.
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'FULFILMENT', data: { ...data },
        });
        return {
          type: 'buttons',
          body: `📦 How would you like to receive your order?`,
          buttons: [
            { id: 'PICKUP',   title: '🏪 In-Store Pick-Up' },
            { id: 'DELIVERY', title: '🚚 Delivery'          },
          ],
        };
      }

      const wantsAddMore = /^(add\s*more|add|more|cart_add_more)$/i.test(clean);
      if (wantsAddMore) {
        return {
          type: 'text',
          body: `What else would you like to add? You can type one item, or several at once (e.g. "2 t-shirts and a cap").`,
        };
      }

      const parsed = extractCartLines(raw, menu);
      if (parsed.matchedCount >= 1 && parsed.lines.every(_hasNoVariants)) {
        const merged = _mergeCartLines(cart, parsed.lines);
        await updateSession(session.customerPhone, session.tenantId, { data: { ...data, cart: merged } });
        return _buildCartSummaryUI(merged, business);
      }

      return _buildCartSummaryUI(cart, business);
    }

    // ── SELECT_VARIANT ────────────────────────────────────────────────────────
    case 'SELECT_VARIANT': {
      const item = data.item;
      if (!item) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM' });
        return _buildProductList(menu, business);
      }

      const hasVariants = item.variants && item.variants.length > 0;

      // No variants — skip to quantity
      if (!hasVariants) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'QUANTITY',
          data: { ...data, variant: null },
        });
        return {
          type: 'buttons',
          body: `🛍 *${item.name}*\n\nHow many would you like?\n_(Type a number)_`,
          buttons: [
            { id: 'QTY_1', title: '1️⃣  1' },
            { id: 'QTY_2', title: '2️⃣  2' },
            { id: 'QTY_3', title: '3️⃣  3' },
          ],
          footer: 'Or type any number',
        };
      }

      // Has variants — they should pick one
      const variantKeys = item.variants.map(v => v.name || v);
      const matchedVariant = variantKeys.find(v =>
        v.toLowerCase() === clean ||
        raw === `VAR_${v.toUpperCase().replace(/\s+/g, '_')}`
      );

      if (matchedVariant) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'QUANTITY',
          data: { ...data, variant: matchedVariant },
        });
        return {
          type: 'buttons',
          body: `🛍 *${item.name}* — ${matchedVariant}\n\nHow many would you like?`,
          buttons: [
            { id: 'QTY_1', title: '1️⃣  1' },
            { id: 'QTY_2', title: '2️⃣  2' },
            { id: 'QTY_3', title: '3️⃣  3' },
          ],
          footer: 'Or type any number',
        };
      }

      // Show variant picker
      // [AUDIT-FIX-RETAIL-VARIANT] ≤3 variants: build the FULL button array
      // (all variantKeys + CANCEL) THEN slice to 3 — the old code sliced
      // variantKeys to 3 first and re-sliced after appending CANCEL, which
      // silently dropped CANCEL for any item with 3+ variants. 4+ variants:
      // switch to a flat top-level `rows` list (unsliced — dispatcher.js
      // hard-caps at Meta's real 10-rows-total limit, see [FIX-LIST-CAP-2]
      // in core/whatsapp/dispatcher.js) instead of only ever offering the
      // first 3 options with no way to reach the rest.
      if (variantKeys.length > 3) {
        return {
          type: 'list',
          body:   `🛍 *${item.name}*\n\nWhich option would you like?`,
          button: 'Choose option',
          rows: variantKeys.map(v => ({
            id:    `VAR_${v.toUpperCase().replace(/\s+/g, '_')}`,
            title: v,
          })),
        };
      }
      return {
        type: 'buttons',
        body: `🛍 *${item.name}*\n\nWhich option would you like?`,
        buttons: [
          ...variantKeys.map(v => ({
            id: `VAR_${v.toUpperCase().replace(/\s+/g, '_')}`,
            title: v,
          })),
          { id: 'CANCEL', title: '❌ Cancel' },
        ].slice(0, 3),
      };
    }

    // ── QUANTITY ──────────────────────────────────────────────────────────────
    case 'QUANTITY': {
      // QTY shortcut buttons
      const qtyShortcut = { 'QTY_1': 1, 'QTY_2': 2, 'QTY_3': 3 };
      const qty = qtyShortcut[raw.toUpperCase()] ?? parseQuantity(raw);

      if (!qty || qty < 1 || qty > 100) {
        return {
          type: 'buttons',
          body: `How many *${data.item?.name}* would you like?\n_(Enter a number between 1 and 100)_`,
          buttons: [
            { id: 'QTY_1', title: '1️⃣  1' },
            { id: 'QTY_2', title: '2️⃣  2' },
            { id: 'QTY_3', title: '3️⃣  3' },
          ],
          footer: 'Or type any number',
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'FULFILMENT',
        data: { ...data, quantity: qty },
      });

      return {
        type: 'buttons',
        body: `🛍 *${data.item?.name}* × ${qty}\n\nHow would you like to receive your order?`,
        buttons: [
          { id: 'PICKUP',   title: '🏪 In-Store Pick-Up' },
          { id: 'DELIVERY', title: '🚚 Delivery'          },
        ],
      };
    }

    // ── FULFILMENT ────────────────────────────────────────────────────────────
    case 'FULFILMENT': {
      const FULFILMENT_MAP = {
        'PICKUP':   'In-Store Pick-Up',
        'DELIVERY': 'Delivery',
      };
      const fulfilment = FULFILMENT_MAP[raw.toUpperCase()] || raw;

      if (!fulfilment) {
        return {
          type: 'buttons',
          body: 'How would you like to receive your order?',
          buttons: [
            { id: 'PICKUP',   title: '🏪 Pick-Up'  },
            { id: 'DELIVERY', title: '🚚 Delivery'  },
          ],
        };
      }

      const isCart = Array.isArray(data.cart) && data.cart.length > 0;
      const currency = business?.payment?.currency || 'D';

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM',
        data: { ...data, fulfilment },
      });

      if (isCart) {
        const allPriced = data.cart.every(l => typeof l.item.price === 'number');
        const total = allPriced ? data.cart.reduce((sum, l) => sum + l.item.price * l.quantity, 0) : null;
        const itemsLine = data.cart.map(l => `${l.quantity}× ${_itemLabel(l.item, l.variant)}`).join(', ');
        const priceLine = total !== null ? `\n💰 *Price:* ${currency}${total}` : '';
        return {
          type: 'buttons',
          body: `🧾 *Order Summary*\n\n` +
            `🛍 *Items:* ${itemsLine}\n` +
            `📦 *Fulfilment:* ${fulfilment}` + priceLine + `\n\nReady to confirm?`,
          buttons: [
            { id: 'CONFIRM', title: '✅ Confirm Order' },
            { id: 'CANCEL',  title: '❌ Cancel'         },
          ],
        };
      }

      const item     = data.item;
      const qty      = data.quantity || 1;
      const variant  = data.variant  ? ` (${data.variant})` : '';
      const price    = item?.price   ? `\n💰 *Price:* ${item.currency || currency}${(item.price * qty).toFixed(2)}` : '';

      return {
        type: 'buttons',
        body: `🧾 *Order Summary*\n\n` +
          `🛍 *Item:* ${item?.name}${variant}\n` +
          `🔢 *Qty:* ${qty}\n` +
          `📦 *Fulfilment:* ${fulfilment}` + price + `\n\nReady to confirm?`,
        buttons: [
          { id: 'CONFIRM', title: '✅ Confirm Order' },
          { id: 'CANCEL',  title: '❌ Cancel'         },
        ],
      };
    }

    // ── CONFIRM ───────────────────────────────────────────────────────────────
    case 'CONFIRM': {
      if (!['CONFIRM', 'YES'].includes(raw.toUpperCase())) {
        return {
          type: 'buttons',
          body: 'Would you like to confirm your order?',
          buttons: [
            { id: 'CONFIRM', title: '✅ Confirm' },
            { id: 'CANCEL',  title: '❌ Cancel'  },
          ],
        };
      }

      const isCart     = Array.isArray(data.cart) && data.cart.length > 0;
      const item       = data.item;
      const qty        = data.quantity || 1;
      const variant    = data.variant  || null;
      const fulfilment = data.fulfilment || 'In-Store Pick-Up';
      // [MULTICART-FLOW-1] mirrors modules/restaurant/flows/orderFlow.js
      const cartAllPriced = isCart && data.cart.every(l => typeof l.item.price === 'number');
      const totalPrice = isCart
        ? (cartAllPriced ? data.cart.reduce((sum, l) => sum + l.item.price * l.quantity, 0) : null)
        : (item?.price ? item.price * qty : null);
      const itemLabel  = isCart
        ? data.cart.map(l => `${l.quantity}× ${_itemLabel(l.item, l.variant)}`).join(', ')
        : _itemLabel(item, variant);
      // [MULTICART-FLOW-1] itemLabel already bakes per-line quantities in for a
      // cart, so the display string must not be prefixed with the single-item
      // `qty` again — this is the one line every admin alert/success message
      // below reads from instead of raw `${qty}× ${itemLabel}`.
      const displayItemsLine = isCart ? itemLabel : `${qty}× ${itemLabel}`;

      // [FIX-BUG4-RETAIL] saveOrder previously hardcoded status:'confirmed', bypassing
      // admin review entirely. Now saved as 'pending' so APPROVE_/REJECT_ buttons work.
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          tenantId:      session.tenantId,
          customerPhone: session.customerPhone,
          customerName:  session.customerName,
          item:          isCart ? undefined : itemLabel,
          quantity:      isCart ? undefined : qty,
          notes:         `Fulfilment: ${fulfilment}`,
          status:        'pending',
          // [FIX-RETAIL-1] totalAmount renamed to totalPrice — orderService.saveOrder
          // destructures { totalPrice } not { totalAmount }. Passing totalAmount meant
          // every retail order had totalPrice=undefined in the DB, breaking payment
          // amount display in admin alerts and the receiveProof order lookup.
          totalPrice:    totalPrice || undefined,
          items:         isCart
            ? data.cart.map(l => ({
                item:      _itemLabel(l.item, l.variant),
                quantity:  l.quantity,
                unitPrice: typeof l.item.price === 'number' ? l.item.price : undefined,
              }))
            : undefined,
          // [FIX-RETAIL-3] businessId was missing — every other module's saveOrder()
          // call passes business._id; retail omitted it, leaving Order.businessId null
          // for every retail order and breaking business-scoped admin views/reports.
          businessId:    business._id,
        });

        // [AUDIT-FIX-4] recordRevenue() moved to adminCommandService.confirmPayment() —
        // recording it here at placement time counted unconfirmed/later-rejected orders
        // as revenue. See adminCommandService.js AUDIT-FIX-4 for full rationale.
        // [FIX-RETAIL-3] trackOrderAnalytics called as (tenantId, 'retail_order') but
        // correct signature is (item, phoneNumberId, quantity, revenue, tenantId).
        // Positional mismatch meant item=tenantId and all other fields were undefined.
        trackOrderAnalytics(itemLabel, null, qty, totalPrice || 0, session.tenantId).catch(() => {});
      } catch (err) {
        logger.error('[Retail] saveOrder error:', err.message);
        // [FIX-SAVE-ERR-RETAIL] Don't proceed to payment/admin-confirm for an order
        // that wasn't saved. Clear flow and let the customer retry.
        await updateSession(session.customerPhone, session.tenantId, {
          currentFlow: null, step: null, data: {},
        });
        return {
          type:    'buttons',
          body:    `⚠️ *Something went wrong saving your order.*\n\nPlease try again — tap below to start over.`,
          buttons: [
            { id: 'ORDER',    title: '🛒 Try Again'   },
            { id: 'SUPPORT',  title: '💬 Contact Us'  },
          ],
        };
      }

      // [FIX-BUG4-RETAIL] Payment flow — was completely absent. If tenant has
      // payment enabled and item has a price, show payment instructions and wait
      // for screenshot, same as restaurant/electronics/bakery.
      const payment = business?.payment;
      if (payment?.enabled && totalPrice) {
        const shortId = savedOrder?.shortId || '';
        const now  = new Date();
        const mm   = String(now.getMonth() + 1).padStart(2, '0');
        const dd   = String(now.getDate()).padStart(2, '0');
        const ref  = `RTL-${mm}${dd}-${shortId}`;

        if (savedOrder?._id) {
          const { default: Order } = await import('../../../models/Order.js');
          Order.updateOne({ _id: savedOrder._id }, { $set: { paymentReference: ref } }).catch(() => {});
        }

        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });

        try {
          const adminPhone = business?.adminPhone;
          if (adminPhone && tenant && savedOrder) {
            const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
            const currency = payment.currency || 'D';
            await dispatchMessage(adminPhone, {
              type: 'text',
              body:
                `🔔 *New Retail Order — ${business?.name || 'Store'}*\n\n` +
                `📞 Customer: *${session.customerPhone}*\n` +
                `🛍 *${displayItemsLine}*\n` +
                `📦 Fulfilment: *${fulfilment}*\n` +
                `💰 Total: *${currency}${totalPrice}*\n` +
                `📝 Ref: *${ref}*\n\n` +
                `⏳ Status: *Pending* — awaiting payment screenshot.`,
            }, tenant).catch(() => {});
          }
        } catch { /* non-fatal */ }

        const { buildPaymentInstructionsUI } = await import('../../../services/paymentService.js');
        return buildPaymentInstructionsUI(business, totalPrice, shortId, ref);
      }

      // [FIX-BUG3-RETAIL] Admin alert: upgraded from dispatchText (no buttons) to
      // dispatchMessage with APPROVE_/REJECT_ buttons. Session parked at
      // AWAIT_ADMIN_CONFIRM so customer cannot place duplicate orders before admin acts.
      try {
        const adminPhone = business?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const currency = payment?.currency || 'D';
          await dispatchMessage(adminPhone, {
            type: 'buttons',
            body:
              `🔔 *New Retail Order — ${business?.name || 'Store'}*\n\n` +
              `📞 Customer: *${session.customerPhone}*\n` +
              `🛍 *${displayItemsLine}*\n` +
              `📦 Fulfilment: *${fulfilment}*\n` +
              (totalPrice ? `💰 Total: *${currency}${totalPrice}*\n` : '') +
              `🔖 Ref: \`${savedOrder?.shortId || 'N/A'}\``,
            buttons: [
              { id: `APPROVE_${savedOrder.shortId}`, title: '✅ Confirm Order' },
              { id: `REJECT_${savedOrder.shortId}`,  title: '❌ Cancel Order'  },
            ],
          }, tenant);
        }
      } catch (err) {
        logger.warn('[Retail] admin notify failed:', err.message);
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER',
        data: { ...data, totalPrice },
      });

      return {
        type: 'text',
        body:
          `✅ *Order Received!* 🛍\n\n` +
          `*${displayItemsLine}*\n` +
          `📦 *${fulfilment}*\n\n` +
          `⏳ Our team will confirm your order shortly. Please wait for confirmation before placing a new one. 🙏`,
      };
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, { step: 'BROWSE_CATEGORY', data: {}, menuViewed: false });
      return handleRetailOrder({ session: { ...session, step: 'BROWSE_CATEGORY', data: {} }, message: null, business, tenant, isInteractive });
  }
}

// ── Product Query (AI) ────────────────────────────────────────────────────────

export async function handleProductQuery({ session, message, business, tenant }) {
  const raw = String(message || '').trim();
  const aiReply = await getAIReply({
    customerMessage: raw,
    business,
    session,
    intent: 'PRODUCT_QUERY',
  });
  // [FIX-24] Was: completeFlow(session, 'ORDER', ...) which sets postFlowAck='ORDER'
  // and tells the customer "We're preparing your order" — completely wrong after a
  // product Q&A. Correct ackCtx is 'QUESTION' so postFlowHandler delivers a warm
  // "any other questions?" reply on the customer's next message.
  const _lcRpq = await completeFlow(session, 'QUESTION', business, tenant);
  if (_lcRpq) return _lcRpq;
  return {
    type: 'buttons',
    body: aiReply || "Great question! Let me point you to the right product.",
    buttons: [
      { id: 'ORDER',     title: '🛍 Shop Now'    },
      { id: 'SHOW_MENU', title: '📋 View All'    },
    ],
  };
}

// ── UI Helpers ────────────────────────────────────────────────────────────────

// ── Cart helpers [MULTICART-FLOW-1] ─────────────────────────────────────────
function _mergeCartLines(existingLines, newLines) {
  const merged = existingLines.map(l => ({ item: l.item, quantity: l.quantity }));
  for (const line of newLines) {
    const key = line.item._id ? String(line.item._id) : line.item.name.toLowerCase();
    const existing = merged.find(l => (l.item._id ? String(l.item._id) : l.item.name.toLowerCase()) === key);
    if (existing) existing.quantity += line.quantity;
    else merged.push({ item: line.item, quantity: line.quantity });
  }
  return merged;
}

function _buildCartSummaryUI(lines, business) {
  const currency  = business?.payment?.currency || 'D';
  const allPriced = lines.every(l => typeof l.item.price === 'number');
  const total     = allPriced ? lines.reduce((sum, l) => sum + l.item.price * l.quantity, 0) : null;
  const rows = lines
    .map(l => `• *${l.quantity}× ${l.item.name}*${typeof l.item.price === 'number' ? ` — ${currency}${l.item.price * l.quantity}` : ''}`)
    .join('\n');
  return {
    type: 'buttons',
    body: `🛒 *Your Cart*\n\n${rows}${total !== null ? `\n\n💰 Total: *${currency}${total}*` : ''}\n\nWhat would you like to do?`,
    buttons: [
      { id: 'CART_CHECKOUT', title: '✅ Checkout'  },
      { id: 'CART_ADD_MORE', title: '➕ Add More'  },
      { id: 'CANCEL',        title: '❌ Cancel'    },
    ],
  };
}

function _getCategories(menu) {
  const cats = [...new Set(menu.map(i => i.category).filter(Boolean))];
  return cats;
}

function _buildCategoryUI(categories, business) {
  // [AUDIT-FIX-CATCAP] This is a single labelled "Categories" section, capped
  // at 9 rows so the "📋 Browse All" row always has its own slot within
  // Meta's real 10-rows-total-per-message limit (dispatcher.js hard-caps
  // there too, but a category picker reads best as one section rather than
  // relying on that fallback truncation — see [FIX-LIST-CAP-2] in
  // core/whatsapp/dispatcher.js for the actual limit dispatcher enforces).
  const shown    = categories.slice(0, 9);
  const overflow = categories.length > 9;

  return {
    type: 'list',
    body:   `🛍 *${business?.name || 'Our Store'}*\n\nWhat are you shopping for today?`,
    button: 'Choose category',
    sections: [{
      title: 'Categories',
      rows: shown.map(c => ({
        id:    `CAT_${c.toUpperCase().replace(/\s+/g, '_')}`,
        title: c,
      })).concat([{ id: 'SHOW_MENU', title: '📋 Browse All' }]),
    }],
    footer: overflow
      ? `Showing ${shown.length} of ${categories.length} categories — tap "Browse All" or type what you're looking for`
      : 'Tap a category or type what you\'re looking for',
  };
}

function _buildProductList(items, business, category = null) {
  // [UX-3] WhatsApp list widget — every product is a tappable row.
  // Previously rendered as a text block ("1. Item Name — $price\n2. ...") requiring
  // customers to type a number. Now they tap directly.
  const header = category
    ? `🛍 *${category}*`
    : `🛍 *${business?.name || 'Our Products'}*`;

  if (!items.length) {
    return {
      type:    'buttons',
      body:    `${header}\n\nNo products available in this category right now.`,
      buttons: [{ id: 'SHOW_MENU', title: '🔄 All Categories' }, { id: 'CANCEL', title: '❌ Cancel' }],
    };
  }

  // [FIX-LIST-CAP-2] No build-time slice needed here — dispatcher.js now
  // hard-caps the OUTGOING message at Meta's real limit of 10 rows TOTAL
  // across all sections (not 10/section as previously assumed here — that
  // assumption caused production 400s: "Total row count exceed max
  // allowed count: 10"). If this list has more than 10 items, the
  // dispatcher truncates and adds a footer hint; consider category
  // browsing (see _buildCategoryUI-style helpers elsewhere) so customers
  // aren't silently missing items past #10.
  const rows = items.map((item, idx) => ({
    id:          String(idx + 1),
    title:       item.name.slice(0, 24),
    description: [
      item.description ? item.description.slice(0, 40) : null,
      item.price ? `${item.currency || 'D'}${item.price}` : null,
    ].filter(Boolean).join(' — ').slice(0, 72) || undefined,
  }));

  return {
    type: 'list',
    header,
    body:   'Tap a product to select it, or type what you\'re looking for:',
    button: 'View Products',
    rows,
  };
}

function _buildItemDetail(item, business) { // [FIX-RETAIL-BUSINESS-SCOPE] business now passed in to avoid ReferenceError
  const price    = item.price    ? `💰 *Price:* ${item.currency || business?.payment?.currency || 'D'}${item.price}\n` : '';
  const desc     = item.description ? `\n_${item.description}_\n` : '';
  const variants = item.variants && item.variants.length > 0
    ? `\n📐 *Options:* ${item.variants.map(v => v.name || v).join(', ')}\n`
    : '';

  const detailPrompt = {
    type: 'buttons',
    body: `🛍 *${item.name}*\n${desc}${price}${variants}\nWould you like to order this item?`,
    buttons: [
      { id: 'CONFIRM',   title: '🛍 Yes, I want this' },
      { id: 'SHOW_MENU', title: '🔄 Browse Others'    },
      { id: 'CANCEL',    title: '❌ Cancel'            },
    ],
  };

  // [FEAT-CATALOG-IMAGES] Same pattern as restaurant/flows/orderFlow.js's
  // item-detail image send — the only vertical that had this before. A
  // tenant's uploaded product photo is stored correctly (Cloudinary +
  // BusinessConfig.menuItems[].image.url) regardless of vertical, but
  // nothing outside restaurant ever actually sent it to the customer in
  // this fallback (non-Meta-Catalog) chat tier.
  const imageUrl = item?.image?.url;
  if (imageUrl && item?.showImageOnSelect !== false) {
    return [
      {
        type:    'image',
        url:     buildWhatsAppImageUrl(imageUrl),
        caption: `*${item.name}*${item.price ? ` — ${item.currency || business?.payment?.currency || 'D'}${item.price}` : ''}`,
      },
      detailPrompt,
    ];
  }
  return detailPrompt;
}
