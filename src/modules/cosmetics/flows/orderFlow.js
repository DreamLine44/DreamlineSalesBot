/**
 * modules/cosmetics/flows/orderFlow.js
 *
 * COSMETICS ORDER FLOW — dedicated, not a restaurant proxy.
 *
 * Cosmetics-specific logic:
 *   • Skin-type/concern context collected BEFORE item selection
 *     (customer who mentions "oily skin" gets filtered recommendations)
 *   • Shade / variant selection step
 *   • Quantity (cosmetics are typically 1–3 units)
 *   • Delivery only (no dine-in / table)
 *   • Optional personalisation note ("gift wrap", "send with card")
 *
 * Steps: SKIN_CONTEXT → SELECT_ITEM → [CART_REVIEW ↔ (checkout)] → SELECT_SHADE → QUANTITY → GIFT_NOTE → CONFIRM → [PAYMENT?]
 *
 * [MULTICART-FLOW-1] SELECT_ITEM also tries utils/multiItemParser.js's
 * extractCartLines() to catch a message naming 2+ known products at once
 * (e.g. "2 lipsticks and a foundation") — same fix as
 * modules/restaurant/flows/orderFlow.js. It ONLY branches into CART_REVIEW
 * when every matched product has zero shade options — a product requiring a
 * shade pick cannot safely be added to a cart via free text (there's no
 * sub-flow here to collect a shade per cart line), so any message naming a
 * shaded product falls straight through to the original single-item flow
 * unchanged, same as a single-item message always has.
 *
 * SKIN_CONTEXT is skippable — if customer taps "Shop Products" directly they go
 * straight to SELECT_ITEM without being forced through the skin-type wizard.
 */

import { updateSession }  from '../../../core/sessions/sessionService.js';
import { completeFlow }   from '../../../core/conversations/flowEngine.js';
import { getAIReply }     from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }  from '../../../utils/matchEngine.js';
import { extractCartLines } from '../../../utils/multiItemParser.js';
import { parseQuantity }  from '../../../utils/parseQuantity.js';
import { saveOrder }      from '../../../services/orderService.js';
import { trackOrderAnalytics } from '../../../core/analytics/analyticsService.js';
import logger             from '../../../config/logger.js';
import { buildWhatsAppImageUrl } from '../../../config/cloudinary.js';

const norm = (s = '') => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

export async function handleCosmeticsOrderFlow({ session, message, business, tenant, isInteractive = false }) {
  const raw   = String(message || '').trim();
  const clean = norm(raw);
  const step  = session.step || 'SELECT_ITEM';
  const data  = session.data || {};
  const menu  = (business?.menuItems || []).filter(i => i.available !== false);

  // ── No menu ───────────────────────────────────────────────────────────────
  if (!menu.length) {
    await updateSession(session.customerPhone, session.tenantId, { currentFlow: null, step: null, data: {} });
    return {
      type:    'buttons',
      body:    '💄 Our product range is being updated. Please check back soon or contact us.',
      buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }, { id: 'SHOW_MENU', title: '🔄 Start Over' }],
    };
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SKIN_CONTEXT', data: {}, menuViewed: false,
    });
    return {
      type:   'list',
      body:   `💄 *Shop Products*\n\nWould you like personalised recommendations based on your skin type, or browse all products?`,
      button: 'Choose',
      sections: [{
        title: 'How to shop',
        rows: [
          { id: 'SKIN_DRY',    title: '💧 Dry Skin',          description: 'Feels tight, flaky, or dull'      },
          { id: 'SKIN_OILY',   title: '✨ Oily Skin',          description: 'Shiny, prone to breakouts'        },
          { id: 'SKIN_COMBO',  title: '🌟 Combination Skin',   description: 'Oily T-zone, dry cheeks'          },
          { id: 'SKIN_NORMAL', title: '😊 Normal / All Types', description: 'Generally balanced skin'          },
          { id: 'SKIP_SKIN',   title: '🛍 Browse All Products', description: 'Skip and see everything'         },
        ],
      }],
    };
  }

  switch (step) {

    // ── SKIN_CONTEXT ──────────────────────────────────────────────────────────
    case 'SKIN_CONTEXT': {
      const SKIN_MAP = {
        'SKIN_DRY':    'dry',
        'SKIN_OILY':   'oily',
        'SKIN_COMBO':  'combination',
        'SKIN_NORMAL': 'normal',
        'SKIP_SKIN':   null,
      };

      const skinType = SKIN_MAP.hasOwnProperty(raw.toUpperCase())
        ? SKIN_MAP[raw.toUpperCase()]
        : (clean.length >= 2 ? clean : null);

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'SELECT_ITEM',
        data: { ...data, skinType: skinType || null },
        menuViewed: false,
      });

      if (skinType) {
        // Filter or rank menu items relevant to skin type if items have tags
        const filtered = menu.filter(i =>
          !i.skinType || i.skinType === skinType || (i.tags || []).includes(skinType)
        );
        const displayMenu = filtered.length >= 3 ? filtered : menu;
        return _buildCosmeticsMenu(displayMenu, business, skinType);
      }

      return _buildCosmeticsMenu(menu, business, null);
    }

    // ── SELECT_ITEM ───────────────────────────────────────────────────────────
    case 'SELECT_ITEM': {
      if (!isInteractive && !session.menuViewed && /^\d+$/.test(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
        return _buildCosmeticsMenu(menu, business, data.skinType || null);
      }
      if (clean.length < 2) return _buildCosmeticsMenu(menu, business, data.skinType || null);

      // [MULTICART-FLOW-1] Only branches into the cart flow when 2+ distinct
      // KNOWN products are named AND none of them require a shade pick (see
      // header comment). A single match, zero matches, or any shaded product
      // in the mix falls straight through to the existing logic below.
      const cartParse = extractCartLines(raw, menu);
      if (cartParse.matchedCount >= 2 && cartParse.lines.every(l => _shadeOptions(l.item).length === 0)) {
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
      let item = (!isNaN(numIdx) && numIdx >= 0 && menu[numIdx]) ? menu[numIdx] : null;

      if (!item) {
        const { item: matched, confidenceLevel } = findBestMatch(menu, clean);
        if (confidenceLevel === 'HIGH') {
          item = matched;
        } else if (confidenceLevel === 'LOW' && matched) {
          // AI-assisted product recommendation based on what they typed
          const aiReply = await getAIReply({
            customerMessage: raw,
            business,
            session,
            intent: 'PRODUCT_QUERY',
          }).catch(() => null);
          return {
            type: 'buttons',
            body: aiReply || `Did you mean *${matched.name}*? 💄`,
            buttons: [
              { id: 'CONFIRM',   title: `✅ Yes, ${matched.name.slice(0, 15)}` },
              { id: 'SHOW_MENU', title: '🛍 Browse All'                         },
            ],
          };
        }
      }

      if (!item) return _buildCosmeticsMenu(menu, business, data.skinType || null);

      await updateSession(session.customerPhone, session.tenantId, {
        step: _shadeOptions(item).length ? 'SELECT_SHADE' : 'QUANTITY',
        data: { ...data, item },
        menuViewed: true,
      });

      let nextPrompt;
      if (_shadeOptions(item).length) {
        nextPrompt = _buildShadeUI(item);
      } else {
        const price = item.price ? ` — ${item.currency || 'D'}${item.price}` : '';
        const desc  = item.description ? `\n_${item.description}_` : '';
        nextPrompt = {
          type: 'buttons',
          body: `💄 *${item.name}*${price}${desc}\n\nHow many would you like?`,
          buttons: [
            { id: 'QTY_1', title: '1️⃣  1' },
            { id: 'QTY_2', title: '2️⃣  2' },
            { id: 'QTY_3', title: '3️⃣  3' },
          ],
          footer: 'Or type any number',
        };
      }

      // [FEAT-CATALOG-IMAGES] Same pattern as restaurant/retail/fashion/
      // electronics — the tenant's uploaded photo is stored correctly
      // regardless of vertical, but cosmetics never sent it before.
      const imageUrl = item?.image?.url;
      if (imageUrl && item?.showImageOnSelect !== false) {
        return [
          {
            type:    'image',
            url:     buildWhatsAppImageUrl(imageUrl),
            caption: `*${item.name}*${item.price ? ` — ${item.currency || 'D'}${item.price}` : ''}`,
          },
          nextPrompt,
        ];
      }
      return nextPrompt;
    }

    // ── SELECT_SHADE ──────────────────────────────────────────────────────────
    case 'SELECT_SHADE': {
      const item = data.item;
      const shades = _shadeOptions(item);

      // Match shade button ID or typed text
      const shadeMatch = shades.find(s =>
        raw.toUpperCase() === `SHADE_${String(s).toUpperCase().replace(/\s+/g, '_')}` ||
        norm(s) === clean
      );

      const shade = shadeMatch || (raw.length >= 2 && !['CANCEL', 'SHOW_MENU'].includes(raw.toUpperCase()) ? raw : null);

      if (!shade) return _buildShadeUI(item);

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'QUANTITY', data: { ...data, shade },
      });

      const price = item.price ? ` — ${item.currency || 'D'}${item.price}` : '';
      return {
        type: 'buttons',
        body: `💄 *${item.name}* — ${shade}${price}\n\nHow many would you like?`,
        buttons: [
          { id: 'QTY_1', title: '1️⃣  1' },
          { id: 'QTY_2', title: '2️⃣  2' },
          { id: 'QTY_3', title: '3️⃣  3' },
        ],
        footer: 'Or type any number',
      };
    }

    // ── CART_REVIEW ──────────────────────────────────────────────────────────
    // [MULTICART-FLOW-1] Reached only after a message named 2+ known,
    // shade-less products at once.
    case 'CART_REVIEW': {
      const cart = Array.isArray(data.cart) ? data.cart : [];

      const wantsCheckout = /^(checkout|check\s*out|confirm|done|finish|that'?s all|cart_checkout|place\s*order)$/i.test(clean);
      if (wantsCheckout) {
        if (!cart.length) return _buildCosmeticsMenu(menu, business, data.skinType || null);
        const allPriced = cart.every(l => typeof l.item.price === 'number');
        const total = allPriced ? cart.reduce((sum, l) => sum + l.item.price * l.quantity, 0) : null;
        const totalQty = cart.reduce((sum, l) => sum + l.quantity, 0);
        // [MULTICART-FLOW-1] Quantities are already known per line — skip
        // straight to GIFT_NOTE (also skips SELECT_SHADE, guaranteed unneeded
        // since cart entry required zero shade options on every line).
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'GIFT_NOTE', data: { ...data, quantity: totalQty, totalPrice: total },
        });
        return {
          type: 'buttons',
          body: `🎁 Any special requests?\n_(e.g. "Gift wrap", "Include a card", "Fragrance-free packaging")_`,
          buttons: [
            { id: 'GIFT_NONE', title: '✅ No special requests' },
            { id: 'CANCEL',    title: '❌ Cancel'               },
          ],
          footer: 'Or type your request and send',
        };
      }

      const wantsAddMore = /^(add\s*more|add|more|cart_add_more)$/i.test(clean);
      if (wantsAddMore) {
        return {
          type: 'text',
          body: `What else would you like to add? You can type one item, or several at once — just make sure any shaded items are added one at a time.`,
        };
      }

      const parsed = extractCartLines(raw, menu);
      const addable = parsed.lines.filter(l => _shadeOptions(l.item).length === 0);
      if (addable.length >= 1) {
        const merged = _mergeCartLines(cart, addable);
        await updateSession(session.customerPhone, session.tenantId, { data: { ...data, cart: merged } });
        return _buildCartSummaryUI(merged, business);
      }

      return _buildCartSummaryUI(cart, business);
    }

    // ── QUANTITY ──────────────────────────────────────────────────────────────
    case 'QUANTITY': {
      const QTY = { 'QTY_1': 1, 'QTY_2': 2, 'QTY_3': 3 };
      const qty = QTY[raw.toUpperCase()] ?? parseQuantity(raw);
      const MAX = business?.settings?.maxOrderQuantity || 20;

      if (!qty || qty < 1) {
        return {
          type:    'buttons',
          body:    `💄 How many *${data.item?.name}* would you like?`,
          buttons: [
            { id: 'QTY_1', title: '1️⃣  1' },
            { id: 'QTY_2', title: '2️⃣  2' },
            { id: 'QTY_3', title: '3️⃣  3' },
          ],
          footer: `Max: ${MAX} per order`,
        };
      }
      if (qty > MAX) {
        return {
          type:    'buttons',
          body:    `⚠️ Maximum is *${MAX}* per order. For bulk orders please contact us.`,
          buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }, { id: 'CANCEL', title: '❌ Cancel' }],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'GIFT_NOTE', data: { ...data, quantity: qty, totalPrice: (data.item?.price || 0) * qty },
      });

      return {
        type: 'buttons',
        body: `🎁 Any special requests?\n_(e.g. "Gift wrap", "Include a card", "Fragrance-free packaging")_`,
        buttons: [
          { id: 'GIFT_NONE', title: '✅ No special requests' },
          { id: 'CANCEL',    title: '❌ Cancel'               },
        ],
        footer: 'Or type your request and send',
      };
    }

    // ── GIFT_NOTE ─────────────────────────────────────────────────────────────
    case 'GIFT_NOTE': {
      const giftNote = raw.toUpperCase() === 'GIFT_NONE' ? null : raw;
      const isCart   = Array.isArray(data.cart) && data.cart.length > 0;
      const item     = data.item;
      const qty      = data.quantity || 1;
      // [AUDIT-FIX-CATALOG-VARIANT-LOSS] data.shade is set by the in-chat
      // SELECT_SHADE step above; data.variant is set instead when this item
      // was chosen via WA Catalog (see waCatalogFlow.js) and SELECT_SHADE was
      // skipped because the shade was already resolved. Fall back so a
      // catalog-resolved shade isn't lost from here on.
      const shadeVal = data.shade || data.variant;
      const shade    = shadeVal ? ` (${shadeVal})` : '';
      const total    = data.totalPrice;
      const currency = business?.payment?.currency || item?.currency || 'D';
      const itemsLine = isCart
        ? data.cart.map(l => `${l.quantity}× ${l.item.name}`).join(', ')
        : `${qty}× ${item?.name}${shade}`;

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM', data: { ...data, giftNote: giftNote || null },
      });

      return {
        type: 'buttons',
        body:
          `🧾 *Order Summary*\n\n` +
          `💄 *${itemsLine}*\n` +
          (total ? `💰 *Total:* ${currency}${total}\n` : '') +
          (giftNote ? `🎁 *Note:* ${giftNote}\n` : '') +
          `\nReady to confirm?`,
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
          type:    'buttons',
          body:    '💄 Ready to place your order?',
          buttons: [
            { id: 'CONFIRM', title: '✅ Confirm Order' },
            { id: 'CANCEL',  title: '❌ Cancel'         },
          ],
        };
      }

      const shadeVal = data.shade || data.variant;
      const shade    = shadeVal ? ` (${shadeVal})` : '';
      const skinNote = data.skinType ? `Skin type: ${data.skinType}` : null;
      // [MULTICART-FLOW-1] mirrors modules/restaurant/flows/orderFlow.js
      const isCart = Array.isArray(data.cart) && data.cart.length > 0;
      const displayItemsLine = isCart
        ? data.cart.map(l => `${l.quantity}× ${l.item.name}`).join(', ')
        : `${data.quantity || 1}× ${data.item?.name}${shade}`;

      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          tenantId:      session.tenantId,
          customerPhone: session.customerPhone,
          customerName:  session.customerName,
          item:          isCart ? undefined : `${data.item?.name}${shade}`,
          quantity:      isCart ? undefined : (data.quantity || 1),
          totalPrice:    data.totalPrice || 0,
          items:         isCart
            ? data.cart.map(l => ({
                item:      l.item.name,
                quantity:  l.quantity,
                unitPrice: typeof l.item.price === 'number' ? l.item.price : undefined,
              }))
            : undefined,
          notes:         [skinNote, data.giftNote].filter(Boolean).join(' | ') || undefined,
          businessId:    business._id,
        });
      } catch (err) {
        logger.error('[CosmeticsOrder] saveOrder failed', { err: err.message });
        // [FIX-SAVE-ERR-COSMETICS] Don't proceed to payment/admin-confirm for an order
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

      // Payment
      const payment = business?.payment;
      if (payment?.enabled && data.totalPrice) {
        const { buildPaymentInstructionsUI } = await import('../../../services/paymentService.js');
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });
        // [FIX-PAYREF-COSMETICS] Generate and persist paymentReference — mirrors restaurant/bakery pattern.
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

      // [FIX-BUG3-COSMETICS] Upgrade admin alert from dispatchText (plain text, no buttons)
      // to dispatchMessage with APPROVE_/REJECT_ buttons. Also parks session at
      // AWAIT_ADMIN_CONFIRM — mirrors restaurant/electronics/bakery pattern.
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const currency = business?.payment?.currency || 'D';
          await dispatchMessage(adminPhone, {
            type: 'buttons',
            body:
              `🔔 *New Cosmetics Order — ${business?.name || 'Beauty'}*\n\n` +
              `📞 Customer: *${session.customerPhone}*\n` +
              `💄 *${displayItemsLine}*\n` +
              (skinNote ? `🌿 ${skinNote}\n` : '') +
              (data.giftNote ? `🎁 ${data.giftNote}\n` : '') +
              (data.totalPrice ? `💰 Total: *${currency}${data.totalPrice}*\n` : '') +
              `🔖 Ref: \`${savedOrder?.shortId || 'N/A'}\``,
            buttons: [
              { id: `APPROVE_${savedOrder.shortId}`, title: '✅ Confirm Order' },
              { id: `REJECT_${savedOrder.shortId}`,  title: '❌ Cancel Order'  },
            ],
          }, tenant).catch(e => logger.warn('[CosmeticsOrder] admin notify failed', { err: e.message }));
        }
      } catch {}

      trackOrderAnalytics(displayItemsLine, null, data.quantity, data.totalPrice || 0, session.tenantId).catch(() => {});
      // [AUDIT-FIX-4] recordRevenue() moved to adminCommandService.confirmPayment() —
      // recording it here at placement time counted unconfirmed/later-rejected orders
      // as revenue. See adminCommandService.js AUDIT-FIX-4 for full rationale.

      // Park session — customer waits for admin confirmation
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER',
        data: { ...data },
      });

      return {
        type: 'text',
        body:
          `✅ *Order Received!* 💄\n\n` +
          `*${displayItemsLine}*\n` +
          (data.giftNote ? `🎁 ${data.giftNote}\n` : '') +
          `\n⏳ Our team will confirm your order shortly. Please wait for confirmation before placing a new one. 🙏`,
      };
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', data: {} });
      return handleCosmeticsOrderFlow({ session: { ...session, step: 'SELECT_ITEM', data: {} }, message: null, business, tenant, isInteractive });
  }
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

function _buildCosmeticsMenu(items, business, skinType = null) {
  const name   = business?.businessName || business?.name || 'Beauty';
  const header = skinType
    ? `💄 Products for *${skinType} skin*`
    : `💄 *${name}*`;

  if (!items.length) {
    return {
      type:    'buttons',
      body:    `${header}\n\nNo products available right now. Please check back soon.`,
      buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }],
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
  const rows = items.map((item, i) => ({
    id:          String(i + 1),
    title:       item.name.slice(0, 24),
    description: [
      item.description?.slice(0, 40),
      item.price ? `${item.currency || 'D'}${item.price}` : null,
    ].filter(Boolean).join(' — ').slice(0, 72) || undefined,
  }));

  return {
    type:   'list',
    header,
    body:   skinType
      ? `Products recommended for *${skinType} skin* — tap to select:`
      : `Our full range — tap a product to select:`,
    button: 'View Products',
    rows,
  };
}

// [AUDIT-FIX-CATALOG-SHADE-1] item.variants is the one field that actually
// round-trips through Mongoose (see BusinessConfig.js FIX-VARIANTS-SCHEMA)
// and the only field waCatalogHelpers.js (buildRetailerId/resolveCatalogItem/
// buildCategorizedSections) reads when syncing to and resolving from Meta's
// WA Catalog. item.shades is NOT in the schema — any value written to it via
// addMenuItem/updateMenuItem is silently dropped by Mongoose strict mode, so
// it is always undefined on a persisted item. That meant SELECT_SHADE could
// never actually trigger for any cosmetics tenant, and any shade options a
// tenant configured never made it into the synced WA Catalog either. Reading
// from item.variants (with the legacy item.shades checked only as a
// belt-and-suspenders fallback, in case it's ever populated by an older
// write path) fixes both problems at once: shade selection now works for
// in-chat customers, and it lines up with exactly what WA Catalog syncs and
// resolves for the very same item.
function _shadeOptions(item) {
  const raw = (item?.variants?.length ? item.variants : item?.shades) || [];
  return raw.map(v => (v && typeof v === 'object') ? v.name : v).filter(Boolean);
}

function _buildShadeUI(item) {
  const shades = _shadeOptions(item);
  if (shades.length <= 3) {
    return {
      type: 'buttons',
      body: `💄 *${item.name}*\n\nWhich shade would you like?`,
      buttons: shades.slice(0, 3).map(s => ({
        id:    `SHADE_${String(s).toUpperCase().replace(/\s+/g, '_')}`,
        title: String(s),
      })),
    };
  }
  return {
    type:   'list',
    body:   `💄 *${item.name}*\n\nWhich shade would you like?`,
    button: 'Choose shade',
    sections: [{
      title: 'Available Shades',
      rows: shades.map(s => ({
        id:    `SHADE_${String(s).toUpperCase().replace(/\s+/g, '_')}`,
        title: String(s),
      })),
    }],
    footer: 'Or type your preferred shade',
  };
}
