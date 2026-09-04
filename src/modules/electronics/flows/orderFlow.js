/**
 * modules/electronics/flows/orderFlow.js
 *
 * Full ORDER, SPEC_REQUEST, COMPARE, and WARRANTY flows for the Electronics module.
 *
 * ── Why electronics is different ────────────────────────────────────────────
 * A restaurant customer knows what they want (jollof rice, a burger).
 * An electronics customer starts with a CATEGORY ("phones", "laptops") then
 * narrows to a model. They want to READ SPECS before committing, and often need
 * compatibility / warranty info. Pickup vs delivery is a real choice because
 * electronics can be heavy and customers want to inspect before collecting.
 *
 * ── Flow steps ────────────────────────────────────────────────────────────────
 *   ORDER:
 *     BROWSE_CATEGORY → SELECT_ITEM → SUGGEST_CONFIRM → ITEM_DETAIL
 *       → QUANTITY → FULFILMENT → CONFIRM → [PAYMENT?] → DONE
 *   SPEC_REQUEST:
 *     SPEC_QUESTION (open AI Q&A, no purchase)
 *   COMPARE:
 *     SELECT_FIRST → SELECT_SECOND → SHOW_COMPARISON
 *   WARRANTY:
 *     WARRANTY_QUERY (AI-powered after-sales)
 *
 * ── Fixes applied ─────────────────────────────────────────────────────────────
 * [FIX-1] All dynamic imports (uiBuilders, dispatcher, paymentService, Order, flowEngine)
 *         moved to static top-level imports. Dynamic imports inside switch cases created
 *         unnecessary async overhead and masked missing-export errors until runtime.
 *
 * [FIX-2] CONTACT_* button ID removed from handleWarranty. The webhookController
 *         has no CONTACT_* handler — tapping it produced a silent no-op. Replaced
 *         with SUPPORT which is already handled by the core moduleRouter.
 *
 * [FIX-3] QUESTION action not separately registered for ELECTRONICS — moduleRegistry
 *         now registers ELECTRONICS:QUESTION → handleSpecRequest so any "❓ Ask a
 *         Question" tap or typed question in ELECTRONICS mode reaches the right handler.
 *         (Registration is in moduleRegistry.js, not here.)
 *
 * [FIX-4] handleCompare: SHOW_COMPARISON now transitions directly into the ORDER
 *         flow's ITEM_DETAIL step using advance() instead of calling buildItemDetail
 *         manually. This ensures the flowEngine's step tracking stays in sync.
 *
 * [FIX-5] Warranty keyword routing — handleWarranty is now also reachable by the
 *         SPEC_REQUEST flow via typed keywords ("warranty", "repair", "return").
 *         The SPEC_REQUEST handler detects these keywords and redirects to WARRANTY.
 */

import { updateSession }  from '../../../core/sessions/sessionService.js';
import { completeFlow, startFlow } from '../../../core/conversations/flowEngine.js';
import { getAIReply, findBestMatch, parseQuantity } from '../../../core/nlu/nluFeature.js';
import { saveOrder }      from '../../../services/order/orderService.js';
import { trackOrderAnalytics } from '../../../core/analytics/analyticsService.js';
import { buildPaymentInstructionsUI } from '../../../services/payment/paymentFeature.js';
import { dispatchMessage } from '../../../core/whatsapp/dispatcher.js';
import Order from '../../../models/Order.js';
import {
  buildCategoryUI,
  buildProductList,
  buildItemDetail,
  buildOrderSummary,
  buildComparisonCard,
  buildAdminOrderAlertBody,
} from '../handlers/uiBuilders.js';
import { itemLabel, formatMoney } from '../../../utils/formatFeature.js';
import logger from '../../../config/logger.js';
import { getAdminPhones } from '../../../utils/adminPhones.js';

// ── Normalise text for fuzzy comparisons ─────────────────────────────────────
const norm = (s = '') =>
  s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

// ── Keywords that should redirect to WARRANTY flow instead of spec Q&A ────────
const WARRANTY_RE = /\b(warrant(y|ies)|repair|service\s+cent(er|re)|return|refund|replace|broken|damaged|fault|defect|spare\s+parts?|after.?sales?)\b/i;

// ─────────────────────────────────────────────────────────────────────────────
// handleElectronicsOrder — main ORDER flow
// ─────────────────────────────────────────────────────────────────────────────

export async function handleElectronicsOrder({
  session, message, business, tenant, isInteractive = false,
}) {
  const raw   = String(message || '').trim();
  const clean = norm(raw);
  const step  = session.step || 'BROWSE_CATEGORY';
  const data  = session.data || {};
  const menu  = (business?.menuItems || []).filter(i => i.available !== false);
  const currency = business?.payment?.currency || 'D';

  // ── Empty catalogue guard ─────────────────────────────────────────────────
  if (!menu.length) {
    await updateSession(session.customerPhone, session.tenantId, {
      currentFlow: null, step: null, data: {},
    });
    return {
      type:    'buttons',
      body:    '⚠️ Our catalogue is currently being updated. Please check back soon or contact us directly.',
      buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }],
    };
  }

  // ── INIT (message === null — startFlow called us with null to get first UI) ─
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'BROWSE_CATEGORY', data: {}, menuViewed: false,
    });
    const categories = _getCategories(menu);
    if (categories.length > 1) {
      return buildCategoryUI(categories, business);
    }
    // Single category or none — go straight to product list
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_ITEM', menuViewed: true,
    });
    return buildProductList(menu, business);
  }

  switch (step) {

    // ── BROWSE_CATEGORY ──────────────────────────────────────────────────────
    case 'BROWSE_CATEGORY': {
      const categories = _getCategories(menu);

      // CAT_PHONES, CAT_LAPTOPS, etc. — these are flow-internal button IDs
      // registered in FLOW_PASSTHROUGH_IDS so they always reach here
      if (/^CAT_/i.test(raw)) {
        const catKey  = raw.slice(4).replace(/_/g, ' ').toLowerCase();
        const catName = categories.find(c => c.toLowerCase() === catKey) || catKey;
        const filtered = menu.filter(
          i => (i.category || 'General').toLowerCase() === catKey
        );
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'SELECT_ITEM',
          data: { ...data, category: catName },
          menuViewed: true,
        });
        return buildProductList(filtered.length ? filtered : menu, business, catName);
      }

      // Typed text — product search or category name
      if (clean.length >= 2) {
        // Category name typed? (e.g. "phones", "accessories")
        const catMatch = categories.find(
          c => norm(c).includes(clean) || clean.includes(norm(c))
        );
        if (catMatch) {
          const filtered = menu.filter(
            i => (i.category || 'General').toLowerCase() === catMatch.toLowerCase()
          );
          await updateSession(session.customerPhone, session.tenantId, {
            step: 'SELECT_ITEM',
            data: { ...data, category: catMatch },
            menuViewed: true,
          });
          return buildProductList(filtered, business, catMatch);
        }

        // Product name typed — fuzzy match
        const { item, confidenceLevel } = findBestMatch(menu, clean);
        if (confidenceLevel === 'HIGH' || confidenceLevel === 'MEDIUM') {
          await updateSession(session.customerPhone, session.tenantId, {
            step: 'ITEM_DETAIL',
            data: { ...data, item },
            menuViewed: true,
          });
          return buildItemDetail(item, currency);
        }

        // No confident match — AI fallback
        const aiReply = await getAIReply({
          customerMessage: raw, business, session, intent: 'PRODUCT_SEARCH',
        });
        return {
          type:    'buttons',
          body:    aiReply || `I couldn't find *"${raw}"* in our catalogue. Browse by category:`,
          buttons: [
            { id: 'ORDER',     title: '🛒 Browse Products' },
            { id: 'SHOW_MENU', title: '🔄 Start Over'      },
          ],
        };
      }

      return categories.length > 1
        ? buildCategoryUI(categories, business)
        : buildProductList(menu, business);
    }

    // ── SELECT_ITEM ──────────────────────────────────────────────────────────
    case 'SELECT_ITEM': {
      const filteredMenu = data.category
        ? menu.filter(i => (i.category || 'General').toLowerCase() === data.category.toLowerCase())
        : menu;
      const listMenu = filteredMenu.length ? filteredMenu : menu;

      // Guard: number typed before seeing catalogue
      if (!isInteractive && !session.menuViewed && /^\d+$/.test(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
        return buildProductList(listMenu, business, data.category);
      }

      // Numeric selection from list
      // [AUDIT-FIX-PARSEINT] parseInt("2 red shirts", 10) === 2, NOT NaN — so any
      // message merely STARTING with a digit silently hijacked the menu index
      // once menuViewed was true (the normal case). Only trust the parsed index
      // for a bare number or an interactive tap; everything else falls through
      // to fuzzy name matching below.
      const isPureNumeric = /^\d+$/.test(raw.trim());
      const numIdx = (isInteractive || isPureNumeric) ? parseInt(raw, 10) - 1 : NaN;
      let item = (!isNaN(numIdx) && listMenu[numIdx]) ? listMenu[numIdx] : null;

      if (!item) {
        const { item: matched, confidenceLevel } = findBestMatch(listMenu, clean);
        if (confidenceLevel === 'HIGH') {
          item = matched;
        } else if (confidenceLevel === 'LOW' && matched) {
          await updateSession(session.customerPhone, session.tenantId, {
            step: 'SUGGEST_CONFIRM',
            data: { ...data, suggestion: matched.name, suggestedItem: matched },
          });
          return {
            type:    'buttons',
            body:    `🤔 Did you mean *${matched.name}*?`,
            buttons: [
              { id: 'CONFIRM_SUGGESTION', title: `✅ Yes` },
              { id: 'SHOW_MENU',          title: '🔄 Start Over' },
            ],
          };
        }
      }

      if (!item) {
        const aiReply = await getAIReply({
          customerMessage: raw, business, session, intent: 'PRODUCT_SEARCH',
        });
        return {
          type:    'buttons',
          body:    aiReply || `I couldn't find that product. Here's what we carry:`,
          buttons: [
            { id: 'SHOW_MENU',    title: '📋 Browse Products' },
            { id: 'SPEC_REQUEST', title: '❓ Ask a Question'  },
          ],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'ITEM_DETAIL',
        data: { ...data, item },
        menuViewed: true,
      });
      return buildItemDetail(item, currency);
    }

    // ── SUGGEST_CONFIRM ──────────────────────────────────────────────────────
    // Customer is confirming or rejecting a fuzzy-matched product suggestion.
    // CONFIRM_SUGGESTION button is in FLOW_PASSTHROUGH_IDS → always reaches here.
    case 'SUGGEST_CONFIRM': {
      if (/^(yes|y|yep|yeah|confirm|ok|okay|confirm_suggestion)$/i.test(clean)) {
        const item = data.suggestedItem
          || menu.find(i => norm(i.name) === norm(data.suggestion || ''));
        if (item) {
          await updateSession(session.customerPhone, session.tenantId, {
            step: 'ITEM_DETAIL',
            data: { ...data, item },
            menuViewed: true,
          });
          return buildItemDetail(item, currency);
        }
      }
      // Rejected or no item found — back to browse
      const categories = _getCategories(menu);
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'BROWSE_CATEGORY', data: { ...data, suggestedItem: undefined, suggestion: undefined },
      });
      return categories.length > 1
        ? buildCategoryUI(categories, business)
        : buildProductList(menu, business);
    }

    // ── ITEM_DETAIL ──────────────────────────────────────────────────────────
    // Customer is viewing the spec card. CONFIRM_ITEM ("Order This") is in
    // FLOW_PASSTHROUGH_IDS so it always reaches here instead of intent detection.
    case 'ITEM_DETAIL': {
      // [FIX-P2] SPEC_REQUEST / WARRANTY button taps — "❓ Ask a Question" / "🛡 Warranty"
      // on the item detail card. Previously the raw button ID string reached the text
      // branch (length ≥ 3) and was sent verbatim to the AI, producing nonsense.
      // Fix: detect and dispatch to the correct flow handler so item context is preserved.
      if (raw.toUpperCase() === 'SPEC_REQUEST') {
        return startFlow({ flowName: 'SPEC_REQUEST', session, business, tenant });
      }
      if (raw.toUpperCase() === 'WARRANTY') {
        return startFlow({ flowName: 'WARRANTY', session, business, tenant });
      }
      if (/^(confirm_item|order_this|order|yes|y|ok|buy)$/i.test(clean)) {
        const MAX_QTY = business?.settings?.maxOrderQuantity || 10;
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'QUANTITY',
        });
        return {
          type: 'buttons',
          body:
            `📱 *${data.item?.name}*\n\n` +
            `How many units would you like?\n` +
            `_(Maximum: ${MAX_QTY} per order)_`,
          buttons: [
            { id: 'QTY_1', title: '1️⃣  1 unit'  },
            { id: 'QTY_2', title: '2️⃣  2 units' },
            { id: 'QTY_3', title: '3️⃣  3 units' },
          ],
          footer: 'Or type any number',
        };
      }

      // Customer typed a question about the item currently on screen
      if (raw.length >= 3) {
        const aiReply = await getAIReply({
          customerMessage: raw, business, session, intent: 'SPEC_REQUEST',
        });
        return {
          type: 'buttons',
          body: aiReply || `Great question! Our team will be happy to assist. 📱`,
          buttons: [
            { id: 'CONFIRM_ITEM', title: '🛒 Order This'  },
            { id: 'SHOW_MENU',    title: '🔄 Browse More' },
          ],
        };
      }

      // Empty/emoji — re-show the spec card
      return buildItemDetail(data.item || {}, currency);
    }

    // ── QUANTITY ─────────────────────────────────────────────────────────────
    case 'QUANTITY': {
      const QTY_SHORTCUTS = { QTY_1: 1, QTY_2: 2, QTY_3: 3 };
      // QTY_* IDs are in FLOW_PASSTHROUGH_IDS globally — they reach here correctly
      const qty     = QTY_SHORTCUTS[raw.toUpperCase()] ?? parseQuantity(raw);
      const MAX_QTY = business?.settings?.maxOrderQuantity || 10;

      if (!qty || qty < 1) {
        return {
          type:    'buttons',
          body:    `Please type the number of units you'd like for *${data.item?.name}*.\n\n_(e.g. *1*, *2*, *three* — maximum ${MAX_QTY})_`,
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

      // If business has only one fulfilment mode configured, skip the choice
      const hasDelivery = business?.settings?.delivery !== false;
      const hasPickup   = business?.settings?.pickup   !== false;

      if (hasDelivery && !hasPickup) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'CONFIRM',
          data: { ...data, quantity: qty, totalPrice: total, fulfilment: 'DELIVERY' },
        });
        return buildOrderSummary({ item: itemLabel(data.item, data.variant), qty, total, fulfilment: 'DELIVERY', business });
      }
      if (hasPickup && !hasDelivery) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'CONFIRM',
          data: { ...data, quantity: qty, totalPrice: total, fulfilment: 'PICKUP' },
        });
        return buildOrderSummary({ item: itemLabel(data.item, data.variant), qty, total, fulfilment: 'PICKUP', business });
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'FULFILMENT',
        data: { ...data, quantity: qty, totalPrice: total },
      });
      return {
        type: 'buttons',
        body:
          `📦 *${qty}× ${itemLabel(data.item, data.variant)}*\n` +
          (total ? `💰 *${currency}${formatMoney(total)}*\n` : '') +
          `\nHow would you like to receive your order?`,
        buttons: [
          { id: 'PICKUP',   title: '🏪 Pick Up In-Store' },
          { id: 'DELIVERY', title: '🚚 Delivery'          },
        ],
      };
    }

    // ── FULFILMENT ───────────────────────────────────────────────────────────
    // PICKUP and DELIVERY button IDs are already in FLOW_PASSTHROUGH_IDS (retail module)
    case 'FULFILMENT': {
      let fulfilment = null;
      if (/^(pickup|pick_up|collect|store|in.?store)$/i.test(clean)) fulfilment = 'PICKUP';
      if (/^(delivery|deliver|ship|shipping|send)$/i.test(clean))    fulfilment = 'DELIVERY';

      if (!fulfilment) {
        return {
          type:    'buttons',
          body:    'Please choose how you\'d like to receive your order:',
          buttons: [
            { id: 'PICKUP',   title: '🏪 Pick Up In-Store' },
            { id: 'DELIVERY', title: '🚚 Delivery'          },
          ],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM',
        data: { ...data, fulfilment },
      });
      return buildOrderSummary({
        item: itemLabel(data.item, data.variant), qty: data.quantity, total: data.totalPrice, fulfilment, business,
      });
    }

    // ── CONFIRM ──────────────────────────────────────────────────────────────
    case 'CONFIRM': {
      // [FIX-DUALLAYER-CONFIRM] See core/nlu/resolution/confirmationMatcher.js — the
      // bare exact-word regex missed compound phrasing like "yes please" /
      // "sounds good" / "go ahead". Widened via the shared sync regex guard
      // (no AI here — this step has no cart-modification path to protect,
      // but AI adds latency this simple gate doesn't need).
      const { isAffirmative: _isAffirmativeConfirm } = await import('../../../core/nlu/nluFeature.js');
      const isConfirm = /^(yes|y|confirm|ok|okay|sure|place|confirmed)$/i.test(clean) ||
        _isAffirmativeConfirm(raw);
      if (!isConfirm) {
        return buildOrderSummary({
          item: itemLabel(data.item, data.variant), qty: data.quantity, total: data.totalPrice,
          fulfilment: data.fulfilment, business,
        });
      }

      const payment = business?.payment;

      // ── Save order ────────────────────────────────────────────────────────
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          // [AUDIT-FIX-CATALOG-VARIANT-LOSS] data.variant is set by
          // waCatalogFlow.js when this item was chosen via WA Catalog;
          // electronics had no variant-specific step and previously dropped it.
          item:          itemLabel(data.item, data.variant),
          quantity:      data.quantity,
          totalPrice:    data.totalPrice,
          // [AUDIT-FIX-ELEC-1] orderService.saveOrder() destructures a fixed set of
          // fields ({ item, quantity, totalPrice, addOns, notes, customerName,
          // customerPhone, tenantId, businessId, status }) — `fulfilment` is not one
          // of them, and the Order schema itself has no `fulfilment` column. Passing
          // fulfilment: data.fulfilment here was silently dropped at the destructuring
          // step before it ever reached Mongoose, so every electronics order's
          // pickup/delivery choice was visible in the live WhatsApp admin alert but
          // permanently lost from the database — the dashboard order list and any
          // later lookup (e.g. after the chat alert scrolled away) showed nothing.
          // Every other module that captures fulfilment (bakery, retail, delivery)
          // persists it by folding it into the free-text `notes` field, which IS in
          // both the saveOrder() signature and the Order schema. Match that pattern.
          notes:         data.fulfilment
            ? `Fulfilment: ${data.fulfilment === 'DELIVERY' ? 'Delivery' : 'In-store pick-up'}`
            : null,
          customerName:  session.customerName || null, // [FIX-SAVE-2]
          customerPhone: session.customerPhone,
          tenantId:      session.tenantId,
          businessId:    business._id,
        });

        trackOrderAnalytics(
          itemLabel(data.item, data.variant),
          business.phoneNumberId || null,
          data.quantity,
          data.totalPrice || 0,
          session.tenantId
        ).catch(() => {});
        // [AUDIT-FIX-4] recordRevenue() moved to adminCommandService.confirmPayment() —
        // recording it here at placement time counted unconfirmed/later-rejected orders
        // as revenue. See adminCommandService.js AUDIT-FIX-4 for full rationale.
      } catch (err) {
        logger.error('[ElectronicsOrder] saveOrder failed', { err: err.message });
        // [FIX-SAVE-ERR-ELECTRONICS] Don't fall through to payment/admin-confirm for an
        // order that was never persisted. Clear flow and let the customer retry.
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

      // ── Payment configured? ───────────────────────────────────────────────
      if (payment?.enabled && data.totalPrice) {
        const shortId = savedOrder?.shortId || '';
        const now  = new Date();
        const mm   = String(now.getMonth() + 1).padStart(2, '0');
        const dd   = String(now.getDate()).padStart(2, '0');
        const ref  = `ELC-${mm}${dd}-${shortId}`;

        if (savedOrder?._id) {
          // [FIX-1] Static import — no dynamic import needed
          await Order.updateOne({ _id: savedOrder._id }, { $set: { paymentReference: ref } });
        }

        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });

        try {
          const adminPhones = getAdminPhones(business, tenant);
          if (adminPhones.length && tenant && savedOrder) {
            // [FIX-1] Static import — dispatchMessage already imported at top of file
            const alertPayload = {
              type: 'text',
              body:
                `🔔 *New Order — ${business.name || 'Electronics Store'}*\n\n` +
                `👤 Customer: *${session.customerPhone}*\n` +
                `📱 *${data.quantity}× ${itemLabel(data.item, data.variant)}*\n` +
                `💰 Total: *${currency}${formatMoney(data.totalPrice)}*\n` +
                `📦 Fulfilment: *${data.fulfilment === 'DELIVERY' ? 'Delivery' : 'In-store pick-up'}*\n` +
                `📝 Ref: *${ref}*\n\n` +
                `⏳ Status: *Pending* — awaiting payment screenshot.`,
            };
            for (const adminPhone of adminPhones) {
              await dispatchMessage(adminPhone, alertPayload, tenant).catch(() => {});
            }
          }
        } catch { /* non-fatal */ }

        // [FIX-1] Static import — buildPaymentInstructionsUI already imported at top of file
        return buildPaymentInstructionsUI(business, data.totalPrice, shortId, ref);
      }

      // ── No payment / cash / COD ────────────────────────────────────────────
      try {
        const adminPhones = getAdminPhones(business, tenant);
        if (adminPhones.length && tenant && savedOrder) {
          // [FIX-1] Static import — dispatchMessage already imported at top of file
          const alertBody = buildAdminOrderAlertBody({
            customerPhone: session.customerPhone,
            item:          itemLabel(data.item, data.variant),
            quantity:      data.quantity,
            totalPrice:    data.totalPrice,
            fulfilment:    data.fulfilment,
            shortId:       savedOrder.shortId,
            business,
          });
          const alertPayload = {
            type:    'buttons',
            body:    alertBody,
            buttons: [
              { id: `APPROVE_${savedOrder.shortId}`, title: '✅ Confirm Order' },
              { id: `REJECT_${savedOrder.shortId}`,  title: '❌ Cancel Order'  },
            ],
          };
          for (const adminPhone of adminPhones) {
            await dispatchMessage(adminPhone, alertPayload, tenant).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn('[ElectronicsOrder] Admin notification failed (non-fatal)', { err: err.message });
      }

      // Park session — wait for admin confirmation before customer can reorder
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER',
        data: { ...data },
      });

      const hasChannels = Array.isArray(payment?.channels) && payment.channels.length > 0;
      const cashBody =
        `💳 *Payment*\n\n` +
        `🛒 Total: *${currency}${formatMoney(data.totalPrice || 0)}*\n\n` +
        (hasChannels
          ? (() => {
              const lines = (payment?.channels || []).map((ch, i) =>
                `${i + 1}. *${ch.provider}* → \`${ch.accountNo}\`` +
                (ch.label ? ` (${ch.label})` : '') +
                (ch.isDefault ? ' ⭐' : '')
              ).join('\n');
              return `📲 Please pay to any of the following:\n\n${lines}\n\nThen send your payment screenshot in this chat.`;
            })()
          : `💵 *Payment:* Cash on delivery / pick-up.\n\nPlease have *${currency}${formatMoney(data.totalPrice || 0)}* ready.`
        );

      return {
        type: 'text',
        body:
          cashBody + '\n\n' +
          '⏳ Your order has been received. Please wait for our team to confirm before placing a new one.',
      };
    }

    // ── Default ───────────────────────────────────────────────────────────────
    default: {
      const categories = _getCategories(menu);
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'BROWSE_CATEGORY', data: {},
      });
      return categories.length > 1
        ? buildCategoryUI(categories, business)
        : buildProductList(menu, business);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// handleSpecRequest — AI-powered tech Q&A
// ─────────────────────────────────────────────────────────────────────────────

export async function handleSpecRequest({ session, message, business, tenant }) {
  // INIT
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SPEC_QUESTION', data: {},
    });
    return {
      type: 'text',
      body:
        `📋 *Tech Help*\n\n` +
        `Ask me anything about our products:\n` +
        `  • Specs & features\n` +
        `  • Compatibility questions\n` +
        `  • Which model is right for you\n` +
        `  • Accessories & add-ons\n\n` +
        `What would you like to know?`,
    };
  }

  const raw = String(message || '').trim();

  if (!raw || raw.length < 2) {
    return {
      type: 'text',
      body: 'What product or tech question can I help you with? 📱',
    };
  }

  // [FIX-5] Redirect warranty/after-sales queries to the WARRANTY flow
  if (WARRANTY_RE.test(raw)) {
    // [FIX-1] Static import — startFlow already imported at top of file
    return startFlow({ flowName: 'WARRANTY', session, business, tenant });
  }

  const aiReply = await getAIReply({
    customerMessage: raw, business, session, intent: 'SPEC_REQUEST',
  });

  // Answer-only: stay in Question Mode (step: SPEC_QUESTION) and wait for the next
  // question — no buttons, and no completeFlow() reset. Switching to another
  // activity (ordering, warranty, etc.) is detected upstream from the customer's
  // own words (webhookController's mid-flow switch detector), not from a tap target.
  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: session.currentFlow || 'SPEC_REQUEST', step: 'SPEC_QUESTION', data: {},
  });

  return {
    type: 'text',
    body: aiReply || `📋 Great question! Let me help you with that. 📱`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// handleCompare — side-by-side product comparison
// ─────────────────────────────────────────────────────────────────────────────

export async function handleCompare({ session, message, business, tenant }) {
  const raw   = String(message || '').trim();
  const clean = norm(raw);
  const step  = session.step || 'SELECT_FIRST';
  const data  = session.data || {};
  const menu  = (business?.menuItems || []).filter(i => i.available !== false);
  const currency = business?.payment?.currency || 'D';

  // INIT
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_FIRST', data: {},
    });
    return {
      type: 'text',
      body:
        `⚖️ *Product Comparison*\n\n` +
        `I'll compare two products side-by-side so you can choose the right one.\n\n` +
        `Type the name of the *first* product you want to compare:`,
    };
  }

  switch (step) {

    case 'SELECT_FIRST': {
      if (clean.length < 2) {
        return { type: 'text', body: 'Please type the name of the first product to compare:' };
      }
      const { item, confidenceLevel } = findBestMatch(menu, clean);
      if (!item || (confidenceLevel !== 'HIGH' && confidenceLevel !== 'MEDIUM')) {
        const aiReply = await getAIReply({
          customerMessage: raw, business, session, intent: 'PRODUCT_SEARCH',
        });
        return {
          type:    'buttons',
          body:    aiReply || `I couldn't find *"${raw}"* in our catalogue. Please try a different name:`,
          buttons: [
            { id: 'ORDER',     title: '🛒 Browse Products' },
            { id: 'SHOW_MENU', title: '🔄 Start Over'      },
          ],
        };
      }
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'SELECT_SECOND',
        data: { ...data, compareA: item },
      });
      return {
        type: 'text',
        body:
          `✅ Got it — *${item.name}*.\n\n` +
          `Now type the name of the *second* product to compare:`,
      };
    }

    case 'SELECT_SECOND': {
      if (clean.length < 2) {
        return { type: 'text', body: 'Please type the name of the second product:' };
      }
      const { item, confidenceLevel } = findBestMatch(menu, clean);
      if (!item || (confidenceLevel !== 'HIGH' && confidenceLevel !== 'MEDIUM')) {
        const aiReply = await getAIReply({
          customerMessage: raw, business, session, intent: 'PRODUCT_SEARCH',
        });
        return {
          type:    'buttons',
          body:    aiReply || `I couldn't find *"${raw}"* in our catalogue. Please try another name:`,
          buttons: [
            { id: 'SHOW_MENU', title: '🔄 Start Over' },
            { id: 'CANCEL',    title: '❌ Cancel'      },
          ],
        };
      }
      if (norm(item.name) === norm(data.compareA?.name || '')) {
        return {
          type: 'text',
          body: `That's the same product! Please type a *different* product to compare with *${data.compareA?.name}*:`,
        };
      }
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'SHOW_COMPARISON',
        data: { ...data, compareB: item },
      });
      return buildComparisonCard(data.compareA, item, currency);
    }

    case 'SHOW_COMPARISON': {
      // [FIX-4] PICK_A_* / PICK_B_* are in FLOW_PASSTHROUGH_IDS — they reach here.
      // Transition into ORDER:ITEM_DETAIL by updating session then calling the handler.
      const pickedA = /^PICK_A/i.test(raw) || norm(raw) === norm(data.compareA?.name || '');
      const pickedB = /^PICK_B/i.test(raw) || norm(raw) === norm(data.compareB?.name || '');

      if (pickedA || pickedB) {
        const chosenItem = pickedA ? data.compareA : data.compareB;
        await updateSession(session.customerPhone, session.tenantId, {
          currentFlow: 'ORDER', step: 'ITEM_DETAIL',
          data: { item: chosenItem }, menuViewed: true,
        });
        return buildItemDetail(chosenItem, currency);
      }

      // Any other tap/text — re-show the comparison card
      return buildComparisonCard(data.compareA || {}, data.compareB || {}, currency);
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'SELECT_FIRST', data: {},
      });
      return { type: 'text', body: 'Type the name of the first product you want to compare:' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// handleWarranty — warranty and after-sales enquiries
// ─────────────────────────────────────────────────────────────────────────────

export async function handleWarranty({ session, message, business, tenant }) {
  // INIT
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'WARRANTY_QUERY', data: {},
    });
    return {
      type: 'buttons',
      body:
        `🛡 *Warranty & After-Sales*\n\n` +
        `I can help with:\n` +
        `  • Warranty coverage for a product\n` +
        `  • Repair / service requests\n` +
        `  • Returns & exchanges\n` +
        `  • Spare parts & accessories\n\n` +
        `What do you need help with?`,
      buttons: [
        { id: 'ORDER',   title: '🛒 Shop Products'  },
        { id: 'SUPPORT', title: '💬 Contact Support' },
      ],
    };
  }

  const raw = String(message || '').trim();
  if (!raw || raw.length < 3) {
    return {
      type:    'buttons',
      body:    'Please describe your warranty or after-sales query:',
      buttons: [{ id: 'SUPPORT', title: '💬 Contact Support' }],
    };
  }

  const aiReply = await getAIReply({
    customerMessage: raw, business, session, intent: 'WARRANTY',
  });

  // [FIX-ELEC-CF-1] completeFlow was imported but never called for the WARRANTY flow.
  // After delivering the AI answer the session still had currentFlow='WARRANTY', so
  // any subsequent button tap (SUPPORT, ORDER, SPEC_REQUEST) re-entered handleWarranty
  // with the button ID as the customer message, producing nonsensical AI responses.
  // completeFlow clears the flow state and sets postFlowAck so follow-up messages
  // (thanks, ok) get a warm reply instead of falling through to a stale flow handler.
  await completeFlow(session, 'WARRANTY', business, null);

  return {
    type: 'buttons',
    // [FIX-2] Use SUPPORT button ID (handled by core) — not a dynamic CONTACT_* ID
    body: aiReply || `🛡 For warranty matters, please contact our support team directly.`,
    buttons: [
      { id: 'SUPPORT',      title: '💬 Contact Support' },
      { id: 'ORDER',        title: '🛒 Shop Products'   },
      { id: 'SPEC_REQUEST', title: '❓ Tech Help'        },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function _getCategories(menu) {
  return [...new Set(menu.map(i => i.category).filter(Boolean))];
}

