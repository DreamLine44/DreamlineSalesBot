/**
 * modules/cosmetics/flows/orderFlow.js
 *
 * COSMETICS ORDER FLOW â€” dedicated, not a restaurant proxy.
 *
 * Cosmetics-specific logic:
 *   â€¢ Skin-type/concern context collected BEFORE item selection
 *     (customer who mentions "oily skin" gets filtered recommendations)
 *   â€¢ Shade / variant selection step
 *   â€¢ Quantity (cosmetics are typically 1â€“3 units)
 *   â€¢ Delivery only (no dine-in / table)
 *   â€¢ Optional personalisation note ("gift wrap", "send with card")
 *
 * Steps: SKIN_CONTEXT â†’ SELECT_ITEM â†’ SELECT_SHADE â†’ QUANTITY â†’ GIFT_NOTE â†’ CONFIRM â†’ [PAYMENT?]
 *
 * SKIN_CONTEXT is skippable â€” if customer taps "Shop Products" directly they go
 * straight to SELECT_ITEM without being forced through the skin-type wizard.
 */

import { updateSession }  from '../../../core/sessions/sessionService.js';
import { completeFlow, cancelFlow } from '../../../core/conversations/flowEngine.js';
import { getAIReply }     from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }  from '../../../utils/matchEngine.js';
import { parseQuantity }  from '../../../utils/parseQuantity.js';
import { saveOrder }      from '../../../services/order/orderService.js';
import { trackOrderAnalytics } from '../../../core/analytics/analyticsService.js';
import logger             from '../../../config/logger.js';
import { buildWhatsAppImageUrl } from '../../../config/cloudinary.js';
import { formatMoney } from '../../../utils/formatCurrency.js';
import {
  parseMultiItemMessage, mergeCartLines, enforceCartLimit,
  cartTotal, cartToOrderItems, formatCartSummary, buildUnmatchedNote,
  parseCartModification, applyCartModification,
} from '../../../core/shared/cartEngine.js';

const norm = (s = '') => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

export async function handleCosmeticsOrderFlow({ session, message, business, tenant, isInteractive = false }) {
  const raw   = String(message || '').trim();
  const clean = norm(raw);
  const step  = session.step || 'SELECT_ITEM';
  const data  = session.data || {};
  const menu  = (business?.menuItems || []).filter(i => i.available !== false);

  // â”€â”€ No menu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!menu.length) {
    await updateSession(session.customerPhone, session.tenantId, { currentFlow: null, step: null, data: {} });
    return {
      type:    'buttons',
      body:    'ðŸ’„ Our product range is being updated. Please check back soon or contact us.',
      buttons: [{ id: 'SUPPORT', title: 'ðŸ’¬ Contact Us' }, { id: 'SHOW_MENU', title: 'ðŸ”„ Start Over' }],
    };
  }

  // â”€â”€ INIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SKIN_CONTEXT', data: {}, menuViewed: false,
    });
    return {
      type:   'list',
      body:   `ðŸ’„ *Shop Products*\n\nWould you like personalised recommendations based on your skin type, or browse all products?`,
      button: 'Choose',
      sections: [{
        title: 'How to shop',
        rows: [
          { id: 'SKIN_DRY',    title: 'ðŸ’§ Dry Skin',          description: 'Feels tight, flaky, or dull'      },
          { id: 'SKIN_OILY',   title: 'âœ¨ Oily Skin',          description: 'Shiny, prone to breakouts'        },
          { id: 'SKIN_COMBO',  title: 'ðŸŒŸ Combination Skin',   description: 'Oily T-zone, dry cheeks'          },
          { id: 'SKIN_NORMAL', title: 'ðŸ˜Š Normal / All Types', description: 'Generally balanced skin'          },
          { id: 'SKIP_SKIN',   title: 'ðŸ› Browse All Products', description: 'Skip and see everything'         },
        ],
      }],
    };
  }

  switch (step) {

    // â”€â”€ SKIN_CONTEXT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ SELECT_ITEM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'SELECT_ITEM': {
      if (!isInteractive && !session.menuViewed && /^\d+$/.test(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
        return _buildCosmeticsMenu(menu, business, data.skinType || null);
      }
      if (clean.length < 2) return _buildCosmeticsMenu(menu, business, data.skinType || null);

      // [CART-AI] Try multi-item parsing FIRST â€” "a lipstick and 2 cleansers"
      // resolves to 2+ distinct product lines and jumps straight to
      // CART_REVIEW. Restricted to messages where NONE of the resolved
      // items have shade/variant options â€” a multi-item cart line has no
      // per-line shade picker (yet), so a shade-bearing product always
      // falls through to the existing single-item SELECT_SHADE flow below,
      // one product at a time, exactly as before.
      const multi = parseMultiItemMessage(menu, raw);
      if (multi && !multi.lines.some(l => _shadeOptions(l.item).length)) {
        const merged = mergeCartLines(Array.isArray(data.cart) ? data.cart : [], multi.lines);
        const { cart: cappedCart, overflowCount } = enforceCartLimit(merged, business);
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'CART_REVIEW', data: { ...data, cart: cappedCart }, menuViewed: true,
        });
        let note = buildUnmatchedNote(multi.unmatchedSegments);
        if (overflowCount > 0) {
          note += `\n\n_(Your cart can hold up to ${business?.multiItemCart?.maxItems || 10} items â€” ${overflowCount} extra item${overflowCount > 1 ? 's were' : ' was'} left out.)_`;
        }
        return _buildCosmeticsCartSummaryUI(cappedCart, business, note);
      }

      // [AUDIT-FIX-PARSEINT] parseInt("2 red shirts", 10) === 2, NOT NaN â€” so any
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
            body: aiReply || `Did you mean *${matched.name}*? ðŸ’„`,
            buttons: [
              { id: 'CONFIRM',   title: `âœ… Yes, ${matched.name.slice(0, 15)}` },
              { id: 'SHOW_MENU', title: 'ðŸ› Browse All'                         },
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
        const price = item.price ? ` â€” ${item.currency || 'D'}${formatMoney(item.price)}` : '';
        const desc  = item.description ? `\n_${item.description}_` : '';
        nextPrompt = {
          type: 'buttons',
          body: `ðŸ’„ *${item.name}*${price}${desc}\n\nHow many would you like?`,
          buttons: [
            { id: 'QTY_1', title: '1ï¸âƒ£  1' },
            { id: 'QTY_2', title: '2ï¸âƒ£  2' },
            { id: 'QTY_3', title: '3ï¸âƒ£  3' },
          ],
          footer: 'Or type any number',
        };
      }

      // [FEAT-CATALOG-IMAGES] Same pattern as restaurant/retail/fashion/
      // electronics â€” the tenant's uploaded photo is stored correctly
      // regardless of vertical, but cosmetics never sent it before.
      const imageUrl = item?.image?.url;
      if (imageUrl && item?.showImageOnSelect !== false) {
        return [
          {
            type:    'image',
            url:     buildWhatsAppImageUrl(imageUrl),
            caption: `*${item.name}*${item.price ? ` â€” ${item.currency || 'D'}${formatMoney(item.price)}` : ''}`,
          },
          nextPrompt,
        ];
      }
      return nextPrompt;
    }

    // â”€â”€ CART_REVIEW â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // [CART-AI] Reached once data.cart has 2+ distinct shade-less products.
    // Checkout skips SELECT_SHADE/QUANTITY (already resolved per line) and
    // goes straight to GIFT_NOTE, same convergence point the single-item
    // path uses before CONFIRM.
    case 'CART_REVIEW': {
      const cart = Array.isArray(data.cart) ? data.cart : [];

      // [FIX-DUALLAYER-CONFIRM] Widened via shared regex guard so "yes please" /
      // "let's checkout" / "go ahead" also register, not just a bare word.
      const { isAffirmative: _isAffirmativeCheckout } = await import('../../../core/shared/confirmationMatcher.js');
      const isCheckout = raw === 'CONFIRM' || /^(yes|y|yeah|yep|confirm|ok|okay|sure|checkout|place|done)$/i.test(clean) ||
        _isAffirmativeCheckout(raw);
      if (isCheckout) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'GIFT_NOTE', data: { ...data, totalPrice: cartTotal(cart) },
        });
        return {
          type: 'buttons',
          body: `ðŸ’„ *Your Order:*\n\n${formatCartSummary(cart, business)}\n\nAny special requests for the whole order?\n_(e.g. "Gift wrap", "Include a card")_`,
          buttons: [
            { id: 'GIFT_NONE', title: 'âœ… No special requests' },
            { id: 'CANCEL',    title: 'âŒ Cancel'               },
          ],
          footer: 'Or type your request and send',
        };
      }

      const isExplicitAddMore = raw === 'ADD_ANOTHER_ITEM' || /^(add more|add another|add another item|another item|add item|more items?)$/i.test(clean);
      if (isExplicitAddMore) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM' });
        return _buildCosmeticsMenu(menu, business, data.skinType || null);
      }

      // [CART-AI-MODIFY] "remove the lipstick" / "make it 2 cleansers" â€”
      // resolved against items ALREADY in the cart, checked before treating
      // the message as an attempt to add a brand-new product.
      const mod = parseCartModification(cart, raw);
      if (mod) {
        const updatedCart = applyCartModification(cart, mod);
        await updateSession(session.customerPhone, session.tenantId, { data: { ...data, cart: updatedCart } });
        if (!updatedCart.length) {
          await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', data: { ...data, cart: [] } });
          return _buildCosmeticsMenu(menu, business, data.skinType || null);
        }
        return _buildCosmeticsCartSummaryUI(updatedCart, business,
          mod.type === 'remove' ? '\n\n_(Removed from your cart.)_' : '\n\n_(Updated the quantity.)_');
      }

      // Treat the message itself as more products to add â€” same shade-less
      // restriction as SELECT_ITEM above.
      const multiAdd = parseMultiItemMessage(menu, raw);
      let newLines = null;
      if (multiAdd && !multiAdd.lines.some(l => _shadeOptions(l.item).length)) {
        newLines = multiAdd.lines;
      } else {
        const { item: singleItem, confidenceLevel: singleConf } = findBestMatch(menu, clean);
        if (singleItem && singleConf === 'HIGH' && !_shadeOptions(singleItem).length) {
          newLines = [{ item: singleItem, quantity: 1, variant: null }];
        }
      }

      if (newLines) {
        const merged = mergeCartLines(cart, newLines);
        const { cart: cappedCart, overflowCount } = enforceCartLimit(merged, business);
        await updateSession(session.customerPhone, session.tenantId, { data: { ...data, cart: cappedCart } });
        let note = multiAdd ? buildUnmatchedNote(multiAdd.unmatchedSegments) : '';
        if (overflowCount > 0) {
          note += `\n\n_(Your cart can hold up to ${business?.multiItemCart?.maxItems || 10} items â€” ${overflowCount} extra item${overflowCount > 1 ? 's were' : ' was'} left out.)_`;
        }
        return _buildCosmeticsCartSummaryUI(cappedCart, business, note);
      }

      return _buildCosmeticsCartSummaryUI(cart, business,
        `\n\n_(I didn't catch a product in that â€” try naming something, or tap Checkout/Add More.)_`);
    }

    // â”€â”€ SELECT_SHADE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

      const price = item.price ? ` â€” ${item.currency || 'D'}${formatMoney(item.price)}` : '';
      return {
        type: 'buttons',
        body: `ðŸ’„ *${item.name}* â€” ${shade}${price}\n\nHow many would you like?`,
        buttons: [
          { id: 'QTY_1', title: '1ï¸âƒ£  1' },
          { id: 'QTY_2', title: '2ï¸âƒ£  2' },
          { id: 'QTY_3', title: '3ï¸âƒ£  3' },
        ],
        footer: 'Or type any number',
      };
    }

    // â”€â”€ QUANTITY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'QUANTITY': {
      const QTY = { 'QTY_1': 1, 'QTY_2': 2, 'QTY_3': 3 };
      const qty = QTY[raw.toUpperCase()] ?? parseQuantity(raw);
      const MAX = business?.settings?.maxOrderQuantity || 20;

      if (!qty || qty < 1) {
        return {
          type:    'buttons',
          body:    `ðŸ’„ How many *${data.item?.name}* would you like?`,
          buttons: [
            { id: 'QTY_1', title: '1ï¸âƒ£  1' },
            { id: 'QTY_2', title: '2ï¸âƒ£  2' },
            { id: 'QTY_3', title: '3ï¸âƒ£  3' },
          ],
          footer: `Max: ${MAX} per order`,
        };
      }
      if (qty > MAX) {
        return {
          type:    'buttons',
          body:    `âš ï¸ Maximum is *${MAX}* per order. For bulk orders please contact us.`,
          buttons: [{ id: 'SUPPORT', title: 'ðŸ’¬ Contact Us' }, { id: 'CANCEL', title: 'âŒ Cancel' }],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'GIFT_NOTE', data: { ...data, quantity: qty, totalPrice: (data.item?.price || 0) * qty },
      });

      return {
        type: 'buttons',
        body: `ðŸŽ Any special requests?\n_(e.g. "Gift wrap", "Include a card", "Fragrance-free packaging")_`,
        buttons: [
          { id: 'GIFT_NONE', title: 'âœ… No special requests' },
          { id: 'CANCEL',    title: 'âŒ Cancel'               },
        ],
        footer: 'Or type your request and send',
      };
    }

    // â”€â”€ GIFT_NOTE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'GIFT_NOTE': {
      const giftNote = raw.toUpperCase() === 'GIFT_NONE' ? null : raw;
      const cart     = Array.isArray(data.cart) ? data.cart : [];
      const isCart   = cart.length > 0;
      const item     = data.item;
      const qty      = data.quantity || 1;
      // [AUDIT-FIX-CATALOG-VARIANT-LOSS] data.shade is set by the in-chat
      // SELECT_SHADE step above; data.variant is set instead when this item
      // was chosen via WA Catalog (see waCatalogFlow.js) and SELECT_SHADE was
      // skipped because the shade was already resolved. Fall back so a
      // catalog-resolved shade isn't lost from here on.
      const shadeVal = data.shade || data.variant;
      const shade    = shadeVal ? ` (${shadeVal})` : '';
      const currency = business?.payment?.currency || 'D';
      const total    = isCart ? cartTotal(cart) : data.totalPrice;
      const itemsLine = isCart
        ? formatCartSummary(cart, business)
        : `ðŸ’„ *${qty}Ã— ${item?.name}${shade}*`;

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM', data: { ...data, giftNote: giftNote || null, totalPrice: total },
      });

      return {
        type: 'buttons',
        body:
          `ðŸ§¾ *Order Summary*\n\n` +
          `${itemsLine}\n` +
          (total != null ? `ðŸ’° *Total:* ${currency}${formatMoney(total)}\n` : '') +
          (giftNote ? `ðŸŽ *Note:* ${giftNote}\n` : '') +
          `\nReady to confirm?`,
        buttons: [
          { id: 'CONFIRM', title: 'âœ… Confirm Order' },
          { id: 'CANCEL',  title: 'âŒ Cancel'         },
        ],
      };
    }

    // â”€â”€ CONFIRM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // [FIX-DUALLAYER-CONFIRM] See core/shared/confirmationMatcher.js â€” was
    // exact-match-only, so a typed "yes please"/"go ahead" never registered.
    case 'CONFIRM': {
      const { resolveConfirmation } = await import('../../../core/shared/confirmationMatcher.js');
      const verdict = await resolveConfirmation({ raw, business });
      if (verdict === 'no') return cancelFlow(session, business);
      if (verdict !== 'yes') {
        return {
          type:    'buttons',
          body:    'ðŸ’„ Ready to place your order?',
          buttons: [
            { id: 'CONFIRM', title: 'âœ… Confirm Order' },
            { id: 'CANCEL',  title: 'âŒ Cancel'         },
          ],
        };
      }

      const shadeVal = data.shade || data.variant;
      const shade    = shadeVal ? ` (${shadeVal})` : '';
      const skinNote = data.skinType ? `Skin type: ${data.skinType}` : null;
      const cart     = Array.isArray(data.cart) ? data.cart : [];
      const isCart   = cart.length > 0;

      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          tenantId:      session.tenantId,
          customerPhone: session.customerPhone,
          customerName:  session.customerName,
          // [CART-AI] Multi-item cart â†’ items[]; orderService.resolveOrderFields()
          // mirrors items[0] into item/quantity/addOns for backward-compat readers.
          ...(isCart
            ? { items: cartToOrderItems(cart), totalPrice: cartTotal(cart) }
            : {
                item:       `${data.item?.name}${shade}`,
                quantity:   data.quantity || 1,
                totalPrice: data.totalPrice || 0,
              }),
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
          body:    `âš ï¸ *Something went wrong saving your order.*\n\nPlease try again â€” tap below to start over.`,
          buttons: [
            { id: 'ORDER',    title: 'ðŸ›’ Try Again'   },
            { id: 'SUPPORT',  title: 'ðŸ’¬ Contact Us'  },
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
        // [FIX-PAYREF-COSMETICS] Generate and persist paymentReference â€” mirrors restaurant/bakery pattern.
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
      // AWAIT_ADMIN_CONFIRM â€” mirrors restaurant/electronics/bakery pattern.
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const currency = business?.payment?.currency || 'D';
          const itemsLine = isCart
            ? `ðŸ’„ ${formatCartSummary(cart, business).replace(/\n/g, '\nðŸ’„ ')}\n`
            : `ðŸ’„ *${data.quantity}Ã— ${data.item?.name}${shade}*\n`;
          await dispatchMessage(adminPhone, {
            type: 'buttons',
            body:
              `ðŸ”” *New Cosmetics Order â€” ${business?.name || 'Beauty'}*\n\n` +
              `ðŸ“ž Customer: *${session.customerPhone}*\n` +
              itemsLine +
              (skinNote ? `ðŸŒ¿ ${skinNote}\n` : '') +
              (data.giftNote ? `ðŸŽ ${data.giftNote}\n` : '') +
              (data.totalPrice ? `ðŸ’° Total: *${currency}${formatMoney(data.totalPrice)}*\n` : '') +
              `ðŸ”– Ref: \`${savedOrder?.shortId || 'N/A'}\``,
            buttons: [
              { id: `APPROVE_${savedOrder.shortId}`, title: 'âœ… Confirm Order' },
              { id: `REJECT_${savedOrder.shortId}`,  title: 'âŒ Cancel Order'  },
            ],
          }, tenant).catch(e => logger.warn('[CosmeticsOrder] admin notify failed', { err: e.message }));
        }
      } catch {}

      trackOrderAnalytics(
        isCart ? formatCartSummary(cart, business) : `${data.item?.name}${shade}`,
        null,
        isCart ? cart.reduce((n, l) => n + l.quantity, 0) : data.quantity,
        data.totalPrice || 0,
        session.tenantId,
      ).catch(() => {});
      // [AUDIT-FIX-4] recordRevenue() moved to adminCommandService.confirmPayment() â€”
      // recording it here at placement time counted unconfirmed/later-rejected orders
      // as revenue. See adminCommandService.js AUDIT-FIX-4 for full rationale.

      // Park session â€” customer waits for admin confirmation
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER',
        data: { ...data },
      });

      return {
        type: 'text',
        body:
          `âœ… *Order Received!* ðŸ’„\n\n` +
          (isCart
            ? `${formatCartSummary(cart, business)}\n`
            : `*${data.quantity}Ã— ${data.item?.name}${shade}*\n`) +
          (data.giftNote ? `ðŸŽ ${data.giftNote}\n` : '') +
          `\nâ³ Our team will confirm your order shortly. Please wait for confirmation before placing a new one. ðŸ™`,
      };
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', data: {} });
      return handleCosmeticsOrderFlow({ session: { ...session, step: 'SELECT_ITEM', data: {} }, message: null, business, tenant, isInteractive });
  }
}

// â”€â”€ UI Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _buildCosmeticsCartSummaryUI(cart, business, note = '') {
  const currency = business?.payment?.currency || 'D';
  const total = cartTotal(cart);
  return {
    type: 'buttons',
    body: `ðŸ§¾ *Your Order*\n\n${formatCartSummary(cart, business)}${total != null ? `\n\nðŸ’° Total: *${currency}${formatMoney(total)}*` : ''}${note}\n\nReady to checkout, or add something else?`,
    buttons: [
      { id: 'CONFIRM',          title: 'âœ… Checkout'  },
      { id: 'ADD_ANOTHER_ITEM', title: 'âž• Add More'   },
      { id: 'CANCEL',           title: 'âŒ Cancel'     },
    ],
  };
}

function _buildCosmeticsMenu(items, business, skinType = null) {
  const name   = business?.businessName || business?.name || 'Beauty';
  const header = skinType
    ? `ðŸ’„ Products for *${skinType} skin*`
    : `ðŸ’„ *${name}*`;

  if (!items.length) {
    return {
      type:    'buttons',
      body:    `${header}\n\nNo products available right now. Please check back soon.`,
      buttons: [{ id: 'SUPPORT', title: 'ðŸ’¬ Contact Us' }],
    };
  }

  // [FIX-LIST-CAP-2] No build-time slice needed here â€” dispatcher.js now
  // hard-caps the OUTGOING message at Meta's real limit of 10 rows TOTAL
  // across all sections (not 10/section as previously assumed here â€” that
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
      item.price ? `${item.currency || 'D'}${formatMoney(item.price)}` : null,
    ].filter(Boolean).join(' â€” ').slice(0, 72) || undefined,
  }));

  return {
    type:   'list',
    header,
    body:   skinType
      ? `Products recommended for *${skinType} skin* â€” tap to select:`
      : `Our full range â€” tap a product to select:`,
    button: 'View Products',
    rows,
  };
}

// [AUDIT-FIX-CATALOG-SHADE-1] item.variants is the one field that actually
// round-trips through Mongoose (see BusinessConfig.js FIX-VARIANTS-SCHEMA)
// and the only field waCatalogHelpers.js (buildRetailerId/resolveCatalogItem/
// buildCategorizedSections) reads when syncing to and resolving from Meta's
// WA Catalog. item.shades is NOT in the schema â€” any value written to it via
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
      body: `ðŸ’„ *${item.name}*\n\nWhich shade would you like?`,
      buttons: shades.slice(0, 3).map(s => ({
        id:    `SHADE_${String(s).toUpperCase().replace(/\s+/g, '_')}`,
        title: String(s),
      })),
    };
  }
  return {
    type:   'list',
    body:   `ðŸ’„ *${item.name}*\n\nWhich shade would you like?`,
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

