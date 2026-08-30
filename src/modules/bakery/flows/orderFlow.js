/**
 * modules/bakery/flows/orderFlow.js
 *
 * BAKERY ORDER FLOW â€” dedicated, not a restaurant proxy.
 *
 * Bakery-specific logic:
 *   â€¢ Collection vs delivery (not dine-in/table)
 *   â€¢ Pickup time slot selection (morning / afternoon batches)
 *   â€¢ Custom message notes (e.g. "wedding cake, write Happy Anniversary")
 *   â€¢ Payment via Wave/cash â€” same payment service as restaurant
 *
 * Steps: SELECT_ITEM â†’ QUANTITY â†’ NOTES â†’ FULFILMENT â†’ PICKUP_TIME â†’ CONFIRM â†’ [PAYMENT?]
 */

import { updateSession }  from '../../../core/sessions/sessionService.js';
import { completeFlow, cancelFlow } from '../../../core/conversations/flowEngine.js';
import { findBestMatch }  from '../../../utils/matchEngine.js';
import { parseQuantity }  from '../../../utils/parseQuantity.js';
import { saveOrder }      from '../../../services/order/orderService.js';
import { trackOrderAnalytics } from '../../../core/analytics/analyticsService.js';
import { buildWhatsAppImageUrl } from '../../../config/cloudinary.js';
import { itemLabel }      from '../../../utils/itemLabel.js';
import { formatMoney }    from '../../../utils/formatCurrency.js';
import logger             from '../../../config/logger.js';
import {
  parseMultiItemMessage, mergeCartLines, enforceCartLimit,
  cartTotal, cartToOrderItems, formatCartSummary, buildUnmatchedNote,
  parseCartModification, applyCartModification,
} from '../../../core/shared/cartEngine.js';

const norm = (s = '') => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

export async function handleBakeryOrderFlow({ session, message, business, tenant, isInteractive = false }) {
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
      body:    'ðŸ¥ Our menu is being updated â€” please check back soon or contact us directly.',
      buttons: [{ id: 'SUPPORT', title: 'ðŸ’¬ Contact Us' }, { id: 'SHOW_MENU', title: 'ðŸ”„ Start Over' }],
    };
  }

  // â”€â”€ INIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (message === null) {
    // [FEAT-BAKERY-CATEGORY] Only shown when the tenant has 2+ distinct
    // categories set (e.g. "Bread", "Cakes", "Pastries") â€” real data, not a
    // forced step. Mirrors retail/fashion's exact pattern.
    const categories = _getCategories(menu);
    if (categories.length > 1) {
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'BROWSE_CATEGORY', data: {}, menuViewed: false, upsellSent: false,
      });
      return _buildCategoryUI(categories, business);
    }
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_ITEM', data: {}, menuViewed: true, upsellSent: false,
    });
    return _buildBakeryMenu(menu, business);
  }

  switch (step) {

    // â”€â”€ BROWSE_CATEGORY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'BROWSE_CATEGORY': {
      const categories = _getCategories(menu);
      const catMatch = categories.find(c => raw.toUpperCase() === `CAT_${c.toUpperCase().replace(/\s+/g, '_')}`);
      if (catMatch) {
        const filtered = menu.filter(i => (i.category || 'General') === catMatch);
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'SELECT_ITEM',
          data: { category: catMatch },
          menuViewed: true,
        });
        return _buildBakeryMenu(filtered, business, catMatch);
      }
      if (clean.length >= 2) {
        // Typed text while browsing categories â€” recurse into SELECT_ITEM
        // with the same message so its existing fuzzy-match logic runs
        // unchanged instead of duplicating it here.
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'SELECT_ITEM', data: {}, menuViewed: true,
        });
        return handleBakeryOrderFlow({
          session: { ...session, step: 'SELECT_ITEM', data: {}, menuViewed: true },
          message, business, tenant, isInteractive,
        });
      }
      return _buildCategoryUI(categories, business);
    }

    // â”€â”€ SELECT_ITEM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'SELECT_ITEM': {
      // [FEAT-BAKERY-CATEGORY] Scope numeric/interactive taps to the
      // category-filtered list actually rendered â€” same fix class as
      // [AUDIT-FIX-RETAIL-SCOPEDINDEX], applied here from the start.
      const scopedMenu = data.category
        ? menu.filter(i => (i.category || 'General') === data.category)
        : menu;

      if (!isInteractive && !session.menuViewed && /^\d+$/.test(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
        return _buildBakeryMenu(scopedMenu, business, data.category || null);
      }
      if (clean.length < 2) return _buildBakeryMenu(scopedMenu, business, data.category || null);

      // [CART-AI] Try multi-item parsing FIRST â€” "2 croissants and a loaf of
      // bread" resolves to 2+ distinct menu lines and jumps straight to
      // CART_REVIEW. A normal single-item message ("croissant", "6 donuts")
      // never resolves 2+ lines, so this is a pure no-op for the vast
      // majority of messages â€” the existing single-item path below runs
      // completely unchanged for those. Same pattern as restaurant/salon.
      const multi = parseMultiItemMessage(menu, raw);
      if (multi) {
        const merged = mergeCartLines(Array.isArray(data.cart) ? data.cart : [], multi.lines);
        const { cart: cappedCart, overflowCount } = enforceCartLimit(merged, business);
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'CART_REVIEW', data: { ...data, cart: cappedCart }, menuViewed: true,
        });
        let note = buildUnmatchedNote(multi.unmatchedSegments);
        if (overflowCount > 0) {
          note += `\n\n_(Your cart can hold up to ${business?.multiItemCart?.maxItems || 10} items â€” ${overflowCount} extra item${overflowCount > 1 ? 's were' : ' was'} left out.)_`;
        }
        return _buildBakeryCartSummaryUI(cappedCart, business, note);
      }

      // [AUDIT-FIX-PARSEINT] parseInt("2 red buns", 10) === 2, NOT NaN â€” so any
      // message merely STARTING with a digit silently hijacked the menu index
      // once menuViewed was true (the normal case). Only trust the parsed index
      // for a bare number or an interactive tap; everything else falls through
      // to fuzzy name matching below.
      const isPureNumeric = /^\d+$/.test(raw.trim());
      const numIdx = (isInteractive || isPureNumeric) ? parseInt(raw, 10) - 1 : NaN;
      let item = (!isNaN(numIdx) && numIdx >= 0 && scopedMenu[numIdx]) ? scopedMenu[numIdx] : null;

      if (!item) {
        const { item: matched, confidenceLevel } = findBestMatch(menu, clean);
        if (confidenceLevel === 'HIGH') {
          item = matched;
        } else if (confidenceLevel === 'LOW' && matched) {
          return {
            type: 'buttons',
            body: `Did you mean *${matched.name}*? ðŸ¥`,
            buttons: [
              { id: 'CONFIRM',   title: `âœ… Yes, ${matched.name.slice(0, 15)}` },
              { id: 'SHOW_MENU', title: 'ðŸ”„ Browse All'                         },
            ],
          };
        }
      }

      if (!item) return _buildBakeryMenu(scopedMenu, business, data.category || null);

      const price = item.price ? ` â€” ${item.currency || 'D'}${formatMoney(item.price)}` : '';
      const desc  = item.description ? `\n_${item.description}_` : '';
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'QUANTITY', data: { item }, menuViewed: true,
      });

      const qtyPrompt = {
        type: 'buttons',
        body: `ðŸ§ *${item.name}*${price}${desc}\n\nHow many would you like?`,
        buttons: [
          { id: 'QTY_1', title: '1ï¸âƒ£  1' },
          { id: 'QTY_2', title: '2ï¸âƒ£  2' },
          { id: 'QTY_3', title: '3ï¸âƒ£  3' },
        ],
        footer: 'Or type any number e.g. 6, 12, 24',
      };

      // [FEAT-CATALOG-IMAGES] Same pattern as restaurant/retail/fashion/
      // electronics/cosmetics â€” the tenant's uploaded photo is stored
      // correctly regardless of vertical, but bakery never sent it before.
      const imageUrl = item?.image?.url;
      if (imageUrl && item?.showImageOnSelect !== false) {
        return [
          {
            type:    'image',
            url:     buildWhatsAppImageUrl(imageUrl),
            caption: `*${item.name}*${item.price ? ` â€” ${item.currency || 'D'}${formatMoney(item.price)}` : ''}`,
          },
          qtyPrompt,
        ];
      }
      return qtyPrompt;
    }

    // â”€â”€ CART_REVIEW â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // [CART-AI] Reached once data.cart has 2+ distinct items â€” either from a
    // single multi-item message (SELECT_ITEM above) or repeated additions.
    // Checkout skips the per-item QUANTITY step (each cart line already
    // carries its own quantity) and goes straight to NOTES.
    case 'CART_REVIEW': {
      const cart = Array.isArray(data.cart) ? data.cart : [];

      // [FIX-DUALLAYER-CONFIRM] Widened via shared regex guard so "yes please" /
      // "let's checkout" / "go ahead" also register, not just a bare word.
      const { isAffirmative: _isAffirmativeCheckout } = await import('../../../core/shared/confirmationMatcher.js');
      const isCheckout = raw === 'CONFIRM' || /^(yes|y|yeah|yep|confirm|ok|okay|sure|checkout|place|done)$/i.test(clean) ||
        _isAffirmativeCheckout(raw);
      if (isCheckout) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'NOTES', data: { ...data, totalPrice: cartTotal(cart) },
        });
        return {
          type: 'buttons',
          body: `ðŸŽ‚ *Your Order:*\n\n${formatCartSummary(cart, business)}\n\nAny special message or notes for the whole order?\n_(e.g. "Write Happy Birthday Sara", "No nuts")_`,
          buttons: [
            { id: 'NOTES_NONE', title: 'âœ… No special notes' },
            { id: 'CANCEL',     title: 'âŒ Cancel'            },
          ],
          footer: 'Or type your message/notes and send',
        };
      }

      const isExplicitAddMore = raw === 'ADD_ANOTHER_ITEM' || /^(add more|add another|add another item|another item|add item|more items?)$/i.test(clean);
      if (isExplicitAddMore) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM' });
        return _buildBakeryMenu(menu, business, data.category || null);
      }

      // [CART-AI-MODIFY] "remove the croissant" / "make it 6 donuts" â€”
      // resolved against items ALREADY in the cart, checked before treating
      // the message as an attempt to add a brand-new item.
      const mod = parseCartModification(cart, raw);
      if (mod) {
        const updatedCart = applyCartModification(cart, mod);
        await updateSession(session.customerPhone, session.tenantId, { data: { ...data, cart: updatedCart } });
        if (!updatedCart.length) {
          await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', data: { ...data, cart: [] } });
          return _buildBakeryMenu(menu, business, data.category || null);
        }
        return _buildBakeryCartSummaryUI(updatedCart, business,
          mod.type === 'remove' ? '\n\n_(Removed from your cart.)_' : '\n\n_(Updated the quantity.)_');
      }

      // Treat the message itself as more items to add.
      const multiAdd = parseMultiItemMessage(menu, raw);
      let newLines = null;
      if (multiAdd) {
        newLines = multiAdd.lines;
      } else {
        const { item: singleItem, confidenceLevel: singleConf } = findBestMatch(menu, clean);
        if (singleItem && singleConf === 'HIGH') newLines = [{ item: singleItem, quantity: 1, variant: null }];
      }

      if (newLines) {
        const merged = mergeCartLines(cart, newLines);
        const { cart: cappedCart, overflowCount } = enforceCartLimit(merged, business);
        await updateSession(session.customerPhone, session.tenantId, { data: { ...data, cart: cappedCart } });
        let note = multiAdd ? buildUnmatchedNote(multiAdd.unmatchedSegments) : '';
        if (overflowCount > 0) {
          note += `\n\n_(Your cart can hold up to ${business?.multiItemCart?.maxItems || 10} items â€” ${overflowCount} extra item${overflowCount > 1 ? 's were' : ' was'} left out.)_`;
        }
        return _buildBakeryCartSummaryUI(cappedCart, business, note);
      }

      return _buildBakeryCartSummaryUI(cart, business,
        `\n\n_(I didn't catch an item in that â€” try naming something, or tap Checkout/Add More.)_`);
    }

    // â”€â”€ QUANTITY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'QUANTITY': {
      const QTY = { 'QTY_1': 1, 'QTY_2': 2, 'QTY_3': 3 };
      const qty = QTY[raw.toUpperCase()] ?? parseQuantity(raw);
      const MAX = business?.settings?.maxOrderQuantity || 100;

      if (!qty || qty < 1) {
        return {
          type:    'buttons',
          body:    `ðŸ§ How many *${data.item?.name}* would you like?\n_(Enter a number, e.g. 1, 6, 12)_`,
          buttons: [
            { id: 'QTY_1', title: '1ï¸âƒ£  1'  },
            { id: 'QTY_2', title: '2ï¸âƒ£  2'  },
            { id: 'QTY_3', title: '3ï¸âƒ£  3'  },
          ],
          footer: `Maximum: ${MAX}`,
        };
      }
      if (qty > MAX) {
        return {
          type:    'buttons',
          body:    `âš ï¸ Maximum order is *${MAX}* per order. For bulk/wholesale orders please contact us directly.`,
          buttons: [{ id: 'SUPPORT', title: 'ðŸ“ž Contact Us' }, { id: 'CANCEL', title: 'âŒ Cancel' }],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'NOTES', data: { ...data, quantity: qty, totalPrice: (data.item?.price || 0) * qty },
      });

      return {
        type: 'buttons',
        body: `ðŸŽ‚ *${qty}Ã— ${data.item?.name}*\n\nAny special message or notes?\n_(e.g. "Write Happy Birthday Sara", "No nuts", "Extra icing")_`,
        buttons: [
          { id: 'NOTES_NONE', title: 'âœ… No special notes' },
          { id: 'CANCEL',     title: 'âŒ Cancel'            },
        ],
        footer: 'Or type your message/notes and send',
      };
    }

    // â”€â”€ NOTES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'NOTES': {
      const notes = raw.toUpperCase() === 'NOTES_NONE' ? null : raw;

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'FULFILMENT', data: { ...data, notes: notes || null },
      });

      return {
        type: 'buttons',
        body: `ðŸ“¦ *How would you like to receive your order?*`,
        buttons: [
          { id: 'COLLECT',  title: 'ðŸª Collect In-Store' },
          { id: 'DELIVERY', title: 'ðŸšš Home Delivery'     },
        ],
      };
    }

    // â”€â”€ FULFILMENT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'FULFILMENT': {
      const isDelivery = raw.toUpperCase() === 'DELIVERY';
      const isCollect  = raw.toUpperCase() === 'COLLECT';

      if (!isDelivery && !isCollect) {
        return {
          type: 'buttons',
          body: 'ðŸ“¦ Would you like to collect in-store or have it delivered?',
          buttons: [
            { id: 'COLLECT',  title: 'ðŸª Collect In-Store' },
            { id: 'DELIVERY', title: 'ðŸšš Home Delivery'     },
          ],
        };
      }

      if (isDelivery) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'DELIVERY_ADDRESS', data: { ...data, fulfilment: 'Delivery' },
        });
        return {
          type:    'buttons',
          body:    `ðŸ“ *Delivery Address*\n\nPlease type your full delivery address.\n\n_Include: street, area, and a landmark._`,
          buttons: [{ id: 'CANCEL', title: 'âŒ Cancel' }],
          footer:  'Type address and send',
        };
      }

      // Collect â€” pick a time slot
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'PICKUP_TIME', data: { ...data, fulfilment: 'Collection' },
      });
      return _buildPickupTimeUI(business);
    }

    // â”€â”€ DELIVERY_ADDRESS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'DELIVERY_ADDRESS': {
      if (!raw || raw.length < 5) {
        return {
          type:    'buttons',
          body:    'ðŸ“ Please provide a valid delivery address.',
          buttons: [{ id: 'CANCEL', title: 'âŒ Cancel' }],
        };
      }
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'PICKUP_TIME', data: { ...data, deliveryAddress: raw },
      });
      return _buildPickupTimeUI(business);
    }

    // â”€â”€ PICKUP_TIME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'PICKUP_TIME': {
      const SLOT_MAP = {
        'SLOT_MORNING':   'Morning (8am â€“ 12pm)',
        'SLOT_AFTERNOON': 'Afternoon (12pm â€“ 4pm)',
        'SLOT_EVENING':   'Evening (4pm â€“ 7pm)',
        'SLOT_TOMORROW':  'Tomorrow (any time)',
      };

      let slot = SLOT_MAP[raw.toUpperCase()] || null;

      // Allow free-text time entry
      if (!slot && raw.length >= 3) {
        slot = raw;
      }

      if (!slot) {
        return _buildPickupTimeUI(business);
      }

      const item     = data.item;
      const qty      = data.quantity || 1;
      const cart     = Array.isArray(data.cart) ? data.cart : [];
      const isCart   = cart.length > 0;
      const total    = isCart ? cartTotal(cart) : data.totalPrice;
      const notes    = data.notes;
      const method   = data.fulfilment || 'Collection';
      const address  = data.deliveryAddress || null;

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM', data: { ...data, pickupTime: slot, totalPrice: total },
      });

      const notesLine   = notes   ? `\nðŸ“ *Notes:* ${notes}` : '';
      const addressLine = address ? `\nðŸ“ *Deliver to:* ${address}` : '';
      const currency    = business?.payment?.currency || 'D';
      const totalLine   = total  != null ? `\nðŸ’° *Total:* ${currency}${formatMoney(total)}` : '';
      const itemsBlock  = isCart ? `ðŸ§ ${formatCartSummary(cart, business).replace(/\n/g, '\nðŸ§ ')}` : `ðŸ§ *${qty}Ã— ${itemLabel(item, data.variant)}*`;

      return {
        type: 'buttons',
        body:
          `ðŸ§¾ *Order Summary*\n\n` +
          `${itemsBlock}\n` +
          `ðŸ“¦ *${method}*` +
          addressLine +
          `\nâ° *${method === 'Delivery' ? 'Delivery' : 'Collection'} Time:* ${slot}` +
          notesLine +
          totalLine +
          `\n\nReady to confirm?`,
        buttons: [
          { id: 'CONFIRM', title: 'âœ… Confirm Order' },
          { id: 'CANCEL',  title: 'âŒ Cancel'         },
        ],
      };
    }

    // â”€â”€ CONFIRM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // [FIX-DUALLAYER-CONFIRM] Was exact-match-only ('CONFIRM'/'YES' strings),
    // so a typed "yes please" / "sure, confirm it" / "go ahead" silently
    // failed and just re-showed this same prompt. resolveConfirmation() adds
    // regex + Groq AI understanding on top of the button-ID check, which
    // still wins outright when it's an actual button tap.
    case 'CONFIRM': {
      const { resolveConfirmation } = await import('../../../core/shared/confirmationMatcher.js');
      const verdict = await resolveConfirmation({ raw, business });
      if (verdict === 'no') return cancelFlow(session, business);
      if (verdict !== 'yes') {
        return {
          type:    'buttons',
          body:    'ðŸ§ Ready to place your bakery order?',
          buttons: [
            { id: 'CONFIRM', title: 'âœ… Confirm Order' },
            { id: 'CANCEL',  title: 'âŒ Cancel'         },
          ],
        };
      }

      const cart   = Array.isArray(data.cart) ? data.cart : [];
      const isCart = cart.length > 0;

      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          tenantId:      session.tenantId,
          customerPhone: session.customerPhone,
          customerName:  session.customerName,
          // [CART-AI] Multi-item cart â†’ items[]; orderService.resolveOrderFields()
          // mirrors items[0] into item/quantity/addOns for backward-compat readers.
          // Single-item order (no cart) â†’ exactly the pre-existing shape.
          ...(isCart
            ? { items: cartToOrderItems(cart), totalPrice: cartTotal(cart) }
            : {
                // [AUDIT-FIX-CATALOG-VARIANT-LOSS] data.variant is set by
                // waCatalogFlow.js when this item was chosen via WA Catalog; bakery
                // has no variant-specific step of its own and previously dropped it.
                item:       itemLabel(data.item, data.variant),
                quantity:   data.quantity || 1,
                totalPrice: data.totalPrice || 0,
              }),
          notes:         [
            data.notes         ? `Message: ${data.notes}`        : null,
            data.fulfilment    ? `Fulfilment: ${data.fulfilment}` : null,
            data.deliveryAddress ? `Address: ${data.deliveryAddress}` : null,
            data.pickupTime    ? `Time: ${data.pickupTime}`      : null,
          ].filter(Boolean).join(' | '),
          businessId:    business._id,
        });
      } catch (err) {
        logger.error('[BakeryOrder] saveOrder failed', { err: err.message });
        // [FIX-SAVE-ERR-BAKERY] If we couldn't persist the order, do NOT proceed to
        // payment instructions or AWAIT_ADMIN_CONFIRM â€” the customer would be told the
        // order was received when nothing was saved. Clear the flow and let them retry.
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

      // Payment flow
      const payment = business?.payment;
      if (payment?.enabled && data.totalPrice) {
        const { buildPaymentInstructionsUI } = await import('../../../services/paymentService.js');
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });
        // [FIX-PAYREF-BAKERY] Generate and persist paymentReference so the ref shown to
        // the customer never drifts between the initial instructions card and any follow-up
        // messages. Mirrors restaurant/electronics/retail/delivery pattern.
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

      // [FIX-BUG3-BAKERY] Upgrade admin alert from dispatchText (plain text, no buttons)
      // to dispatchMessage with APPROVE_/REJECT_ buttons so admin can confirm/cancel
      // with a single tap instead of typing commands. Also parks session at
      // AWAIT_ADMIN_CONFIRM so the customer cannot place a duplicate order before
      // the admin acts â€” mirrors the restaurant/electronics pattern.
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const currency    = business?.payment?.currency || 'D';
          const notesLine   = data.notes          ? `\nðŸ“ Notes: ${data.notes}`             : '';
          const addressLine = data.deliveryAddress ? `\nðŸ“ Address: ${data.deliveryAddress}` : '';
          const totalLine   = data.totalPrice      ? `\nðŸ’° Total: *${currency}${formatMoney(data.totalPrice)}*` : '';
          const itemsLine   = isCart
            ? `ðŸ§ ${formatCartSummary(cart, business).replace(/\n/g, '\nðŸ§ ')}\n`
            : `ðŸ§ *${data.quantity}Ã— ${itemLabel(data.item, data.variant)}*\n`;
          await dispatchMessage(adminPhone, {
            type: 'buttons',
            body:
              `ðŸ”” *New Bakery Order â€” ${business?.name || 'Bakery'}*\n\n` +
              `ðŸ“ž Customer: *${session.customerPhone}*\n` +
              itemsLine +
              `ðŸ“¦ Fulfilment: *${data.fulfilment || 'Collection'}*\n` +
              `â° Time: *${data.pickupTime || 'ASAP'}*` +
              addressLine + notesLine + totalLine +
              `\nðŸ”– Ref: \`${savedOrder?.shortId || 'N/A'}\``,
            buttons: [
              { id: `APPROVE_${savedOrder.shortId}`, title: 'âœ… Confirm Order' },
              { id: `REJECT_${savedOrder.shortId}`,  title: 'âŒ Cancel Order'  },
            ],
          }, tenant).catch(e => logger.warn('[BakeryOrder] admin notify failed', { err: e.message }));
        }
      } catch {}

      trackOrderAnalytics(
        isCart ? formatCartSummary(cart, business) : itemLabel(data.item, data.variant),
        null,
        isCart ? cart.reduce((n, l) => n + l.quantity, 0) : data.quantity,
        data.totalPrice || 0,
        session.tenantId,
      ).catch(() => {});
      // [AUDIT-FIX-4] recordRevenue() moved to adminCommandService.confirmPayment() â€”
      // recording it here at placement time counted unconfirmed/later-rejected orders
      // as revenue. See adminCommandService.js AUDIT-FIX-4 for full rationale.

      // Park session â€” customer waits for admin confirmation before placing another order
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER',
        data: { ...data },
      });

      return {
        type: 'text',
        body:
          `âœ… *Order Received!* ðŸ¥\n\n` +
          (isCart
            ? `${formatCartSummary(cart, business)}\n`
            : `ðŸ§ *${data.quantity}Ã— ${itemLabel(data.item, data.variant)}*\n`) +
          `ðŸ“¦ ${data.fulfilment || 'Collection'} â€” ${data.pickupTime || 'ASAP'}\n` +
          (data.notes ? `ðŸ“ ${data.notes}\n` : '') +
          `\nâ³ Our team will confirm your order shortly. Please wait for confirmation before placing a new one. ðŸ™`,
      };
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', data: {} });
      return handleBakeryOrderFlow({ session: { ...session, step: 'SELECT_ITEM', data: {} }, message: null, business, tenant, isInteractive });
  }
}

// â”€â”€ UI Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _buildBakeryCartSummaryUI(cart, business, note = '') {
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

function _getCategories(menu) {
  return [...new Set(menu.map(i => i.category).filter(Boolean))];
}

function _buildCategoryUI(categories, business) {
  const name = business?.businessName || business?.name || 'Bakery';
  // Single "Categories" section capped at 9 rows + one reserved "Browse All"
  // row â€” mirrors retail's _buildCategoryUI cap.
  const shown    = categories.slice(0, 9);
  const overflow = categories.length > 9;
  return {
    type:   'list',
    body:   `ðŸ¥ *${name}*\n\nWhat would you like today?`,
    button: 'Choose category',
    sections: [{
      title: 'Categories',
      rows: shown.map(c => ({
        id:    `CAT_${c.toUpperCase().replace(/\s+/g, '_')}`,
        title: c,
      })).concat([{ id: 'SHOW_MENU', title: 'ðŸ“‹ Browse All' }]),
    }],
    footer: overflow
      ? `Showing ${shown.length} of ${categories.length} categories â€” tap "Browse All" or type what you're looking for`
      : 'Tap a category or type what you\'re looking for',
  };
}

function _buildBakeryMenu(menu, business, category = null) {
  const name = business?.businessName || business?.name || 'Bakery';
  if (!menu.length) {
    return {
      type:    'buttons',
      body:    `ðŸ¥ *${name}*\n\nOur menu is being updated. Please check back soon!`,
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
  const rows = menu.map((item, i) => ({
    id:          String(i + 1),
    title:       item.name.slice(0, 24),
    description: [
      item.description?.slice(0, 40),
      item.price ? `${item.currency || 'D'}${formatMoney(item.price)}` : null,
    ].filter(Boolean).join(' â€” ').slice(0, 72) || undefined,
  }));
  return {
    type:   'list',
    header: category ? `ðŸ¥ ${category}` : `ðŸ¥ ${name}`,
    body:   'Fresh baked daily â€” what would you like?',
    button: 'View Menu',
    rows,
  };
}

function _buildPickupTimeUI(business) {
  return {
    type:   'list',
    body:   `â° *When would you like it?*`,
    button: 'Choose time',
    sections: [{
      title: 'Collection / Delivery Window',
      rows: [
        { id: 'SLOT_MORNING',   title: 'ðŸŒ… Morning',    description: '8:00 AM â€“ 12:00 PM'  },
        { id: 'SLOT_AFTERNOON', title: 'â˜€ï¸ Afternoon',  description: '12:00 PM â€“ 4:00 PM'  },
        { id: 'SLOT_EVENING',   title: 'ðŸŒ† Evening',    description: '4:00 PM â€“ 7:00 PM'   },
        { id: 'SLOT_TOMORROW',  title: 'ðŸ“… Tomorrow',   description: 'Any time tomorrow'    },
      ],
    }],
    footer: 'Or type a specific time e.g. "10am today"',
  };
}

