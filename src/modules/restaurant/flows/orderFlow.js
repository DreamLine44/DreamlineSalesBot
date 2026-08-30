/**
 * modules/restaurant/flows/orderFlow.js
 *
 * Handles the full ORDER flow for restaurants (and all ORDER-capable modules).
 * Registered with flowEngine for RESTAURANT:ORDER and as the generic ORDER handler.
 *
 * Steps: SELECT_ITEM â†’ QUANTITY â†’ [UPSELL?] â†’ CONFIRM â†’ [PAYMENT?] â†’ DONE
 *
 * FIXES:
 * [FIX-1] norm() regex was missing the 'g' flag â€” only the FIRST whitespace run was
 *         collapsed. "jollof  rice  combo" â†’ "jollof rice  combo" (double-space survives).
 *         Fuzzy matching then failed against the normalised item name. Fixed: /\s+/g.
 *
 * [FIX-2] WORD_NUMS was 1-based (one:1, two:2 â€¦) but numIndex feeds directly into
 *         menu[numIndex]. "one" gave menu[1] (the SECOND item). Fixed: now 0-indexed.
 *
 * [FIX-3] After order confirm with no payment configured, the admin was never notified.
 *         Cash/no-payment restaurants had silent orders â€” admin had no idea.
 *         Fixed: dispatchText() to adminPhone after every successful order save.
 *
 * [FIX-4] Payment step was reusing session data without re-fetching â€” race condition
 *         on slow connections. Now reads totalPrice from confirmed data object.
 *
 * [MULTICART-v39-PHASE2] Added real multi-item cart support â€” see
 *         core/shared/cartEngine.js module header for the full rationale.
 *         Two new entry points into a cart, both purely additive (a normal
 *         single-item order never touches either):
 *           (a) SELECT_ITEM now tries parseMultiItemMessage() FIRST. A
 *               message like "2 burgers and a coke" resolves to a cart with
 *               2 distinct lines and jumps straight to ITEM_ADDED. A normal
 *               single-item message ("jollof rice") never resolves 2+ lines,
 *               so it falls through to the exact pre-existing single-item
 *               fuzzy-match path unchanged.
 *           (b) The CONFIRM step's order summary now offers an "Add Another
 *               Item" button. Tapping it pushes the current item into
 *               data.cart and loops back to SELECT_ITEM instead of saving â€”
 *               so a customer who picks items one at a time (browsing the
 *               menu) can also build a multi-item order, not just one who
 *               types everything in a single message.
 *         Either path converges on ITEM_ADDED/CONFIRM's items[] save via
 *         saveOrder({ items: cartToOrderItems(cart) }) â€” orderService.js's
 *         resolveOrderFields() already normalizes that exactly like a WA
 *         Catalog multi-item cart order does.
 */

import { updateSession }    from '../../../core/sessions/sessionService.js';
import { completeFlow, cancelFlow } from '../../../core/conversations/flowEngine.js';
import { getAIReply }       from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }    from '../../../utils/matchEngine.js';
import {
  buildMenuUI,
  buildItemAddedUI, buildItemsAddedUI, buildCartReviewUI, buildEditCartMenuUI, buildEditCartPickerUI,
} from '../handlers/uiBuilders.js';
import { parseQuantity }    from '../../../utils/parseQuantity.js';
import { saveOrder }        from '../../../services/order/orderService.js';
import { trackOrderAnalytics } from '../../../core/analytics/analyticsService.js';
import { dispatchText }     from '../../../core/whatsapp/dispatcher.js';
import { buildPaymentInstructionsUI } from '../../../services/payment/paymentFeature.js';
import { buildWhatsAppImageUrl }       from '../../../config/cloudinary.js';
import { itemLabel }        from '../../../utils/itemLabel.js';
// [AUDIT-FIX-XZ-REMOVE] isCatalogEnabled â€” see the two call sites below for
// the rationale. The legacy text/list menu (buildMenuUI, the "Choose an
// option â–¼" flow) is being retired for any tenant with a live WA Catalog.
import { isCatalogEnabled } from '../../catalog/waCatalogConfig.js';
import { formatMoney }      from '../../../utils/formatCurrency.js';
import { formatPhoneDisplay } from '../../../utils/formatPhone.js';
import {
  parseMultiItemMessage, parseNaturalOrderMessage, mergeCartLines, enforceCartLimit,
  cartTotal, cartToOrderItems, formatCartSummary, buildUnmatchedNote,
  removeCartLine, incrementCartLine, decrementCartLine, clearCart,
  cartItemCount, formatNumberedCartSummary,
  parseCartModification, applyCartModification,
} from '../../../core/shared/cartEngine.js';
import logger               from '../../../config/logger.js';

// â”€â”€ Normalise â€” [FIX-1] /\s+/ was missing the 'g' flag â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const norm = (s = '') => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

// â”€â”€ Word-number map â€” 0-indexed â€” [FIX-2] was 1-based causing off-by-1 errors â”€
// "one" â†’ menu[0], "two" â†’ menu[1], etc. (parseInt path already does -1)
const WORD_NUMS = {
  one:0, two:1, three:2, four:3, five:4, six:5, seven:6, eight:7, nine:8, ten:9,
  a:0, an:0,
};

/**
 * handleOrderFlow({ session, message, business, tenant, isInteractive })
 */
export async function handleOrderFlow({ session, message, business, tenant, isInteractive = false }) {
  const raw   = String(message || '').trim();
  const clean = norm(raw);
  const step  = session.step || 'SELECT_ITEM';
  const menu  = (business?.menuItems || []).filter(i => i.available !== false);
  const data  = session.data || {};

  // â”€â”€ No menu configured â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // [FIX-FLOW-STUCK] Clear currentFlow BEFORE returning so the session is not
  // permanently stuck in ORDER state. Without this, every subsequent message from
  // the customer re-enters handleOrderFlow (currentFlow='ORDER'), hits this guard
  // again, and returns the same error indefinitely â€” the bot becomes unresponsive.
  if (!menu.length) {
    await updateSession(session.customerPhone, session.tenantId, {
      currentFlow: null, step: null, data: {},
    });
    const cfg = (await import('../../../config/modes.js')).getModeConfig(business);
    return {
      type:    'buttons',
      body:    'âš ï¸ Our menu is being updated. Please contact us directly.',
      buttons: [
        { id: 'SUPPORT',   title: 'ðŸ’¬ Contact Us'  },
        { id: 'SHOW_MENU', title: 'ðŸ”„ Start Over'  },
      ],
    };
  }

  // â”€â”€ INIT (message = null â€” start of flow) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // [FIX-INIT-HIJACK] This block used to run on EVERY message===null call,
  // regardless of `step`. But message===null isn't only used to start a
  // fresh flow â€” moduleRegistry.js's direct-order handoff ("two plates of
  // Yassa Chicken"), its cart-modification handoff, and
  // webhookController.js's ambiguity-resolution handoff all deliberately
  // set step:'CONFIRM' with a pre-populated cart, then call advance() with
  // message:null specifically so the customer lands straight on the Order
  // Summary â€” skipping catalog/menu/quantity/upsell entirely, as intended.
  // Because this block ran unconditionally, it fired FIRST on every one of
  // those calls, silently overwrote step back to 'SELECT_ITEM', and showed
  // the catalog or (if data.orderViaCatalog wasn't set) the legacy
  // buildMenuUI() text list instead of the summary â€” even for a tenant with
  // a fully live, synced WA Catalog.
  // Fix: only treat message===null as a fresh-flow INIT when the step is
  // actually the default starting step. A genuine startFlow() call always
  // passes step:null (see flowEngine.js), which falls back to 'SELECT_ITEM'
  // via the `step` const above â€” so this still fires exactly as before for
  // every real "Order Food" tap / catalog offer / plain "I want to order".
  // Any handoff that deliberately set a further-along step (CONFIRM, etc.)
  // now correctly falls through to the switch below instead of being reset.
  if (message === null && step === 'SELECT_ITEM') {
    const existingCart = Array.isArray(data.cart) ? data.cart : [];
    // [AUDIT-FIX-XZ-REMOVE] Previously this only trusted data.orderViaCatalog,
    // a session-level flag stamped once at START_ORDER. If a tenant enabled/
    // synced WA Catalog AFTER a customer's session began â€” or the flag was
    // ever lost/never set on a particular session for any other reason â€” this
    // fell straight to buildMenuUI() below: the legacy "Choose an option â–¼"
    // list. That path has a real, separate defect (selecting an item from it
    // can dead-end in the QUESTION/FAQ fallback instead of continuing the
    // order) and is being removed outright for any tenant with a live,
    // catalog. isCatalogEnabled(business) is now checked directly, so a
    // catalog-ready tenant NEVER sees the legacy list again, regardless of
    // what this one session's flag happened to record.
    const viaCatalog   = data.orderViaCatalog === true || isCatalogEnabled(business);
    const freshData    = existingCart.length
      ? { cart: existingCart, ...(viaCatalog ? { orderViaCatalog: true } : {}) }
      : (viaCatalog ? { orderViaCatalog: true } : {});
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_ITEM',
      data: freshData,
      menuViewed: false,
      upsellSent: false,
    });
    if (viaCatalog) {
      const count = cartItemCount(existingCart);
      const note  = existingCart.length
        ? `ðŸ›’ You still have *${count} item${count > 1 ? 's' : ''}* in your cart.\n\n`
        : '';
      return await _browseForMoreItems(session, business, tenant, freshData, { note });
    }
    const menuUI = buildMenuUI(business);
    if (existingCart.length) {
      const count = cartItemCount(existingCart);
      const cartNote = `ðŸ›’ You still have *${count} item${count > 1 ? 's' : ''}* in your cart.\n\n`;
      if (typeof menuUI.body === 'string') menuUI.body = cartNote + menuUI.body;
    }
    return menuUI;
  }

  switch (step) {

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'SELECT_ITEM': {
      const cartAtSelect = Array.isArray(data.cart) ? data.cart : [];

      // [DIRECT-ORDER-CONFIRM-SHORTCUT] Keep the shortcut at the owning flow
      // boundary as well as the webhook boundary. This prevents a catalog-backed
      // session from falling into _browseForMoreItems when a resolvable order
      // sentence reaches SELECT_ITEM through a stale/deployed controller path.
      const directProductText = raw
        .replace(/^(?:hi|hello|hey)[,\s]+/i, '')
        .replace(/^(?:i\s+)?(?:want|need|would\s+like|like\s+to\s+order)\s+(?:to\s+order\s+)?/i, '')
        .replace(/^(?:can\s+i\s+)?(?:give|get|have|order|buy|purchase)\s+(?:me\s+)?/i, '')
        .replace(/^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:plates?\s+of\s+)?/i, '')
        .replace(/[?!.]+$/, '')
        .trim();
      // [FIX-GENERIC-LEFTOVER] Mirrors the same fix in moduleRegistry.js â€”
      // see that file for the full rationale. A leftover made entirely of
      // filler/navigational words ("to order", "to see the menu", "food")
      // is not a product-lookup attempt.
      const isFillerOnlyLeftover = /^(?:to|the|your|our|see|view|show|browse|order|get|find|for|a|an|of|me|please|food|menu|menus|catalog|catalogue|catalogs|products?|options?|item|items)(?:\s+(?:to|the|your|our|see|view|show|browse|order|get|find|for|a|an|of|me|please|food|menu|menus|catalog|catalogue|catalogs|products?|options?|item|items))*$/i
        .test(directProductText);
      const isDirectOrderText = directProductText.length >= 3 && !isFillerOnlyLeftover &&
        /\b(?:order|want|need|give|get|buy|purchase|would like)\b/i.test(raw);
      if (isDirectOrderText) {
        const directOrder = parseMultiItemMessage(menu, raw) || parseNaturalOrderMessage(menu, raw);
        if (directOrder?.lines?.length) {
          const mergedCart = mergeCartLines(cartAtSelect, directOrder.lines);
          const { cart: cappedCart, overflowCount } = enforceCartLimit(mergedCart, business);
          await updateSession(session.customerPhone, session.tenantId, {
            step: 'CONFIRM',
            data: { ...data, cart: cappedCart, orderViaCatalog: false },
            orderChannel: 'menu',
            menuViewed: true,
          });
          return buildCartReviewUI({
            summaryText: formatCartSummary(cappedCart, business),
            total: cartTotal(cappedCart),
            itemCount: cartItemCount(cappedCart),
            business,
            note: overflowCount > 0
              ? `\n\n_(Your cart can hold up to ${business?.multiItemCart?.maxItems || 10} items â€” ${overflowCount} extra item${overflowCount > 1 ? 's were' : ' was'} left out.)_`
              : '',
          });
        }
        // [FIX-SILENT-ORDER-MISS] isDirectOrderText is true and the filler-only
        // guard above already confirmed directProductText has real content
        // (e.g. "Yassa Chicken"), yet neither parser could match it against
        // the live menu. Previously this fell through with no explicit
        // return, silently landing in _browseForMoreItems/buildMenuUI below â€”
        // which just re-shows the same "still have N items in cart" note the
        // customer already saw, with no explanation of why their order
        // didn't go through. That produced the exact repeat-message loop in
        // image 1: the customer retries the identical text and gets the
        // identical non-answer forever. Now we tell them plainly what
        // happened and offer a way forward instead of silence.
        return {
          type: 'buttons',
          body: `I couldn't match *${directProductText.slice(0, 50)}* to an item on our menu. Please check the name and try again, or browse the menu below.`,
          buttons: [
            { id: 'SHOW_MENU', title: 'ðŸ“‹ Browse Menu' },
            { id: 'CANCEL', title: 'âŒ Cancel' },
          ],
        };
      }

      if (raw === 'REVIEW_CART' && cartAtSelect.length) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'CONFIRM' });
        return buildCartReviewUI({
          summaryText: formatCartSummary(cartAtSelect, business),
          total:       cartTotal(cartAtSelect),
          itemCount:   cartItemCount(cartAtSelect),
          business,
        });
      }

      // [FIX-2] 0-indexed WORD_NUMS: WORD_NUMS['one']=0 â†’ menu[0] âœ“
      // [AUDIT-FIX-PARSEINT-6] parseInt("2 red pizzas", 10) === 2, NOT NaN â€” so
      // any message merely STARTING with a digit silently hijacked the menu
      // index. The WORD_NUMS lookup is exact-match-only and safe; only the
      // parseInt fallback needed gating so it never fires on mixed alphanumeric
      // input â€” it now only fires for a bare number.
      const isPureNumeric = /^\d+$/.test(raw.trim());
      const numIndex = WORD_NUMS[clean] ?? (isPureNumeric ? parseInt(raw, 10) - 1 : NaN);
      const isNum    = !isNaN(numIndex) && numIndex >= 0;

      if (isNum) {
        const trustedPick = isInteractive || session.menuViewed;
        if (!trustedPick) {
          await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
          return await _browseForMoreItems(session, business, tenant, data);
        }
        const item = menu[numIndex];
        if (!item) return await _browseForMoreItems(session, business, tenant, data);
        return await _selectItem(item, session, business, data);
      }

      // Cancel â€” exit the flow entirely (matches global CANCEL button behaviour).
      if (/^(cancel|stop|exit)$/i.test(clean)) {
        return cancelFlow(session, business);
      }
      // Menu/home â€” stay in ORDER flow, just re-show the browse menu.
      if (/^(back|menu|home)$/i.test(clean)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', menuViewed: true });
        return await _browseForMoreItems(session, business, tenant, data);
      }

      // Too short â€” show a gentle nudge instead of just dumping the menu again
      if (clean.length < 3) {
        return {
          type:    'buttons',
          body:    `Please type the name of what you'd like to order, or tap *Browse Catalog* to see all options:`,
          buttons: [{ id: 'BROWSE_CATALOG', title: 'ðŸ› Browse Catalog' }],
        };
      }

      // â”€â”€ Casual / gibberish / off-topic detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Catches greetings, random characters, keyboard spam, short nonsense strings,
      // and anything that clearly isn't a food item name.
      const CASUAL_RE = /^(hello+|hi+h*|h+i+|hey+|helo|howdy|yo+|sup|good\s*(morning|afternoon|evening|night)|gm|ok+a?y?|k+|yes+|no+pe?|yep|yeah|yh|sure|thanks?|thank\s*u|thx|ty|tq|lol+|haha+|why|what|how|who|huh+|hmm+|test|ping|help|bye|good\s*bye|later)$/i;

      // Gibberish: repetitive character runs like "hihihih", "hehehehe", "aaaa", "lololol"
      const GIBBERISH_RE = /^([a-z]{1,3})\1{2,}$/i;

      // Too many consonants in a row with no vowel = likely keyboard spam
      const SPAM_RE = /^[^aeiou\s]{5,}$/i;

      const isOffTopic = CASUAL_RE.test(clean) || GIBBERISH_RE.test(clean) || SPAM_RE.test(clean);

      if (isOffTopic) {
        return {
          type:    'buttons',
          body:    `Hi there! ðŸ˜Š You're in the ordering flow for *${business.name || 'our restaurant'}*.\n\nPlease type the *name of a dish* you'd like to order, or tap below to browse the full menu:`,
          buttons: [
            { id: 'BROWSE_CATALOG', title: 'ðŸ› Browse Catalog' },
            { id: 'CANCEL',    title: 'âŒ Cancel'    },
          ],
        };
      }

      // [Q&A-PRECEDENCE-1] Natural language menu questions such as "are these the only
      // ones you have?" or "is there any food today?" are not item-selection intents.
      // Route them to the existing DB-first Q&A layer before falling into the
      // "not found on our menu" item-lookup response. This preserves the order flow for
      // legitimate product-selection messages while keeping the ask-a-question flow helpful.
      const questionAnswerService = await import('../../../services/question/questionAnswerService.js');
      const qAnswer = await questionAnswerService.tryDatabaseAnswer({ message: raw, business, session });
      if (qAnswer?.handled && qAnswer.body) {
        // [AUDIT-FIX-QMODE-2] This is an INLINE aside inside an active ORDER flow â€” the
        // customer is still browsing/building a cart and just asked a quick menu
        // question. persistQuestionSession() unconditionally writes currentFlow:
        // 'QUESTION', step: 'AWAITING_QUESTION', which silently ended their ORDER flow
        // right here even though the comment above this block explicitly says the goal
        // is to "preserve the order flow". Worse: if they then tapped the "â“ Ask
        // Another" button this reply shows, ACTION_REGISTRY's QUESTION handler calls
        // startFlow('QUESTION', ...) â€” and startFlow() only preserves data.cart when
        // the flow being started is 'ORDER', so their in-progress cart was wiped.
        // Fix: keep currentFlow/step exactly as they are (still mid-ORDER) and only
        // stash the Q&A context, mirroring what persistQuestionSession does internally
        // minus the flow/step overwrite.
        const { mergeQuestionContext } = await import('../../../services/question/questionModeHelper.js');
        await updateSession(session.customerPhone, session.tenantId, {
          data: {
            ...(session.data || {}),
            _questionCtx: mergeQuestionContext(session, qAnswer.context || { lastMessage: raw, lastTopic: qAnswer.routingDecision || 'QUESTION' }),
          },
        });
        return {
          type: 'buttons',
          body: qAnswer.body,
          buttons: qAnswer.stayOnTopic
            ? [{ id: 'QUESTION', title: 'â“ Ask Another' }, { id: 'SUPPORT', title: 'ðŸ’¬ Contact Support' }]
            : [{ id: 'QUESTION', title: 'â“ Ask Another' }, { id: 'BROWSE_CATALOG', title: 'ðŸ› Browse Catalog' }, { id: 'SUPPORT', title: 'ðŸ’¬ Contact Support' }],
        };
      }

      // [MULTICART-v39-PHASE2] Try multi-item parsing FIRST. A message like
      // "2 burgers and a coke" resolves to 2+ distinct menu lines here and
      // jumps straight to ITEM_ADDED. A normal single-item message never
      // resolves 2+ lines (parseMultiItemMessage returns null), so this is a
      // pure no-op for the overwhelming majority of messages â€” the exact
      // pre-existing single-item fuzzy match below still runs for those.
      const multi = parseMultiItemMessage(menu, raw);
      if (multi) {
        const merged = mergeCartLines(Array.isArray(data.cart) ? data.cart : [], multi.lines);
        const { cart: cappedCart, overflowCount } = enforceCartLimit(merged, business);

        await updateSession(session.customerPhone, session.tenantId, {
          step: 'ITEM_ADDED',
          data: { ...data, cart: cappedCart, ...(data.orderViaCatalog ? { orderViaCatalog: true } : {}) },
          menuViewed: true,
        });

        let note = buildUnmatchedNote(multi.unmatchedSegments);
        if (overflowCount > 0) {
          note += `\n\n_(Your cart can hold up to ${business?.multiItemCart?.maxItems || 10} items â€” ${overflowCount} extra item${overflowCount > 1 ? 's were' : ' was'} left out.)_`;
        }

        // [MULTICART-v40-EDIT] No per-item confirmation â€” fold straight into
        // the cart and ask once whether they want to keep shopping or check
        // out, same as a single browsed item (buildItemAddedUI below).
        return buildItemsAddedUI({
          addedSummary: formatCartSummary(multi.lines, business),
          business,
          cartCount: cartItemCount(cappedCart),
          note,
        });
      }

      // Fuzzy name match
      const { item, confidenceLevel } = findBestMatch(menu, clean);

      if (confidenceLevel === 'HIGH') {
        return await _selectItem(item, session, business, data);
      }
      if (confidenceLevel === 'LOW') {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'SUGGESTION_CONFIRM',
          data: { ...data, suggestion: item.name },
        });
        return {
          type:    'buttons',
          body:    `ðŸ¤” Did you mean *${item.name}*?`,
          buttons: [
            { id: 'CONFIRM', title: `âœ… Yes, ${item.name.slice(0,15)}` },
            { id: 'BROWSE_CATALOG', title: 'ðŸ› Browse Catalog' },
          ],
        };
      }

      // No match â€” show helpful nudge, not just a raw menu dump
      if (isDirectOrderText) {
        return {
          type: 'buttons',
          body: `I couldn't find *${raw.slice(0, 50)}* in our current menu. Please check the dish name and try again, or browse the catalog.`,
          buttons: [
            { id: 'BROWSE_CATALOG', title: 'ðŸ› Browse Catalog' },
            { id: 'CANCEL', title: 'âŒ Cancel' },
          ],
        };
      }
      return {
        type:    'buttons',
        body:    `I couldn't find "*${raw.slice(0,30)}*" on our menu.\n\nTap below to browse all items:`,
        buttons: [{ id: 'BROWSE_CATALOG', title: 'ðŸ› Browse Catalog' }],
      };
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'SUGGESTION_CONFIRM': {
      if (/^(yes|y|yep|yeah|confirm|ok|okay)$/i.test(clean) || clean === 'confirm') {
        const suggestedName = data.suggestion;
        const item = menu.find(i => norm(i.name) === norm(suggestedName));
        if (item) return await _selectItem(item, session, business, data);
      }
      return await _browseForMoreItems(session, business, tenant, data);
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // [MULTICART-v40-EDIT] Reached right after ANY item (or batch of items)
    // is added to the cart â€” replaces the old per-item "Confirm Order?"
    // prompt. Only two things are asked here: keep shopping, or move to the
    // one final consolidated review (CONFIRM case below).
    case 'ITEM_ADDED': {
      const cart = Array.isArray(data.cart) ? data.cart : [];
      if (!cart.length) return await _browseForMoreItems(session, business, tenant, data);

      const wantsReview = raw === 'REVIEW_CART' ||
        /^(review|checkout|view cart|finish order|done|finish|finished|no|nope|that's all|thats all|i'?m done)$/i.test(clean);
      if (wantsReview) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'CONFIRM' });
        return buildCartReviewUI({
          summaryText: formatCartSummary(cart, business),
          total:       cartTotal(cart),
          itemCount:   cartItemCount(cart),
          business,
        });
      }

      const wantsMore = raw === 'ADD_ANOTHER_ITEM' ||
        /^(yes|y|yeah|yep|add more|add another|add another item|another item|add item|more items?)$/i.test(clean);
      if (wantsMore) {
        return await _browseForMoreItems(session, business, tenant, data);
      }

      // [CART-AI-MODIFY] "remove the coke" / "make it 3 fries" â€” resolved
      // against the items ALREADY in the cart. Checked BEFORE the "treat as
      // more items to add" fallback below so a removal/resize request can
      // never be misread as an attempt to add a brand-new line.
      const modResult = await _resolveCartModification(session, business, data, cart, raw);
      if (modResult) {
        if (!modResult.updatedCart.length) {
          return await _browseForMoreItems(session, business, tenant, { ...data, cart: [] });
        }
        const newCount = cartItemCount(modResult.updatedCart);
        return {
          type: 'buttons',
          body: `${modResult.mod.type === 'remove' ? 'ðŸ—‘ï¸ Removed from your cart.' : 'âœ… Updated the quantity.'}\n\nðŸ›’ *${newCount} item${newCount > 1 ? 's' : ''}* in your cart.\n\nWould you like to add another item?`,
          buttons: [
            { id: 'ADD_ANOTHER_ITEM', title: 'âž• Add Another Item'  },
            { id: 'REVIEW_CART',      title: 'ðŸ§¾ Review & Checkout' },
          ],
        };
      }

      // Treat the message itself as more items to add to the existing cart â€”
      // typing "also 2 fries" works without needing to tap a button first.
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
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...data, cart: cappedCart, ...(data.orderViaCatalog ? { orderViaCatalog: true } : {}) },
        });
        let note = multiAdd ? buildUnmatchedNote(multiAdd.unmatchedSegments) : '';
        if (overflowCount > 0) {
          note += `\n\n_(Your cart can hold up to ${business?.multiItemCart?.maxItems || 10} items â€” ${overflowCount} extra item${overflowCount > 1 ? 's were' : ' was'} left out.)_`;
        }
        return buildItemsAddedUI({
          addedSummary: formatCartSummary(newLines, business),
          business,
          cartCount: cartItemCount(cappedCart),
          note,
        });
      }

      // Couldn't resolve anything new â€” re-show the prompt with a gentle nudge.
      return {
        type: 'buttons',
        body: `I didn't catch an item in that â€” try naming a dish, or choose an option below:`,
        buttons: [
          { id: 'ADD_ANOTHER_ITEM', title: 'âž• Add Another Item'  },
          { id: 'REVIEW_CART',      title: 'ðŸ§¾ Review & Checkout' },
        ],
      };
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'QUANTITY': {
      // Customers type any number (digit or word) â€” parseQuantity handles both.
      // No button shortcuts here; WhatsApp button labels are capped at 20 chars
      // and numbered buttons "1 / 2 / 3" are visually unprofessional and limiting.
      const qty = parseQuantity(raw);
      // MAX_QTY is per-business configurable; default 20 for restaurants.
      // Read from business.settings.maxOrderQuantity if set, otherwise 20.
      const MAX_QTY = business?.settings?.maxOrderQuantity || 20;
      // [FIX-CURR-1] Read currency once at the top of QUANTITY case for consistency.
      const currency = business?.payment?.currency || 'D';

      // Can't parse at all (e.g. "any", "yes", blank, or unrecognised words)
      if (!qty || qty < 1) {
        return {
          type: 'text',
          body: `Please type the quantity you'd like for *${data.item?.name}*.\n\nYou can write a number (e.g. *5*) or a word (e.g. *three*). Maximum: *${MAX_QTY}*.`,
        };
      }
      // Parsed fine but exceeds the business max
      if (qty > MAX_QTY) {
        return {
          type: 'text',
          body: `âš ï¸ Maximum order quantity is *${MAX_QTY}*. Please type a number between *1* and *${MAX_QTY}*.`,
        };
      }
      const item   = data.item;
      const price  = item?.price || 0;
      const total  = price * qty;
      const addOns = business?.addOns || [];

      // Upsell â€” if configured and not yet shown
      if (addOns.length && !session.upsellSent) {
        // [FIX-14] Pin the add-on at first selection â€” re-use the stored one if we
        // somehow reach this branch again (e.g. after a session update race) so the
        // customer never sees different add-on offers across retries.
        const addOn = data.pendingAddOn || addOns[Math.floor(Math.random() * addOns.length)];
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'UPSELL',
          upsellSent: true,
          data: { ...data, quantity: qty, totalPrice: total, pendingAddOn: addOn },
        });
        return {
          type:    'buttons',
          body:    `You've chosen *${qty}Ã— ${item.name}*${total ? ` â€” ${currency}${formatMoney(total)}` : ''}.\n\nWould you like to add *${addOn.name}* for ${currency}${formatMoney(addOn.price)}? ðŸ¥¤`,
          buttons: [
            { id: 'UPSELL_YES', title: 'âœ… Yes, add it' },
            { id: 'UPSELL_NO',  title: 'âŒ No thanks'   },
          ],
        };
      }

      // [MULTICART-v40-EDIT] No upsell to show â€” fold straight into the cart
      // and ask once whether to keep shopping or check out. No per-item
      // "Confirm Order?" screen anymore; that's reserved for the one final
      // consolidated review (CONFIRM case).
      return await _addItemAndPrompt(session, business, data, {
        item, quantity: qty, variant: data.variant || null, addOns: [],
      });
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'UPSELL': {
      const addOn    = data.pendingAddOn;
      const accepted = /^(yes|y|yep|yeah|ok|okay|sure|add|upsell_yes)$/i.test(clean) || clean === 'upsell_yes';

      let finalTotal = data.totalPrice || 0;
      let addOnsList = data.addOns || [];

      if (accepted && addOn) {
        finalTotal += addOn.price;
        addOnsList  = [...addOnsList, addOn.name];
      }

      // [MULTICART-v40-EDIT] Fold straight into the cart â€” same as the
      // no-upsell QUANTITY path above.
      return await _addItemAndPrompt(session, business, data, {
        item: data.item, quantity: data.quantity, variant: data.variant || null, addOns: addOnsList,
      });
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // [MULTICART-v40-EDIT] The single, final order review. Every item â€”
    // whether picked one at a time via the menu/list or typed as a
    // multi-item message â€” has already been folded into data.cart by this
    // point (see _addItemAndPrompt / ITEM_ADDED above). This step never asks
    // the customer to confirm an individual line; it shows the whole cart
    // once and offers exactly 3 actions: Confirm / Edit / Cancel.
    case 'CONFIRM': {
      const cart = Array.isArray(data.cart) ? data.cart : [];
      if (!cart.length) return await _browseForMoreItems(session, business, tenant, data);

      // [FIX-CONFIRM-1] "yeah"/"yep" were missing here even though every other
      // confirm-style step in this file (SUGGESTION_CONFIRM, UPSELL) accepts them.
      // [FIX-DUALLAYER-CONFIRM] Widened further via the shared regex guard
      // (core/shared/confirmationMatcher.js / negationGuard.js) so phrases
      // like "yes please", "sounds good", "go ahead" also register â€” the
      // original list only matched a SINGLE bare word exactly. Kept as a
      // sync (non-AI) check here, deliberately BEFORE the cart-modification
      // parser below, so a message like "remove the coke" is never at risk
      // of being swept up as a confirm/decline guess.
      const { isAffirmative: _isAffirmativeConfirm } = await import('../../../core/shared/confirmationMatcher.js');
      const isConfirm = /^(yes|y|yeah|yep|confirm|ok|okay|sure|place|confirmed)$/i.test(clean) ||
        _isAffirmativeConfirm(raw);
      if (isConfirm) {
        // [MULTICART-v40-EDIT] One consolidated save â€” _checkoutCart already
        // handles items[] persistence, payment-vs-cash branching, and admin
        // notification for a cart of any size (1 line or many).
        return await _checkoutCart(cart, session, business, tenant);
      }

      // [SIMPLE-CART-CONFIRM] Primary action on the final review screen â€”
      // matches the requested button set (Confirm / Add More Items / Cancel)
      // exactly. Goes straight back to the catalog; the cart is untouched.
      const wantsAddMore = raw === 'ADD_MORE_ITEMS' || raw === 'ADD_ANOTHER_ITEM' ||
        /^(add more items?|add more|add another item?|continue shopping|keep shopping|browse|menu)$/i.test(clean);
      if (wantsAddMore) {
        return await _browseForMoreItems(session, business, tenant, data);
      }

      // Typed "edit" still opens the fuller Remove/Increase/Decrease/Clear
      // menu for anyone who wants it â€” not exposed as a button (keeps the
      // 3-button screen simple) but the capability isn't removed.
      const wantsEdit = raw === 'EDIT_CART' || /^(edit|edit order|edit cart|change)$/i.test(clean);
      if (wantsEdit) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'EDIT_CART_MENU' });
        return buildEditCartMenuUI();
      }

      // [FIX-DUALLAYER-CONFIRM] Same widening for the decline side â€” "no
      // thanks", "cancel it please", "nah I changed my mind" now register.
      const { isNegative: _isNegativeConfirm } = await import('../../../core/shared/confirmationMatcher.js');
      const wantsCancel = raw === 'CANCEL' || /^(cancel|cancel order|no|nope|stop)$/i.test(clean) ||
        _isNegativeConfirm(raw);
      if (wantsCancel) {
        return cancelFlow(session, business);
      }

      // [CART-AI-MODIFY] Let the customer type a fix directly at the review
      // screen ("remove the coke", "make it 3 fries") instead of having to
      // tap Edit Order first. Extracted to _resolveCartModification() â€”
      // never overlaps isConfirm's exact yes/yeah/etc. match set above.
      const modResult = await _resolveCartModification(session, business, data, cart, raw);
      if (modResult) {
        if (!modResult.updatedCart.length) {
          return await _browseForMoreItems(session, business, tenant, { ...data, cart: [] });
        }
        return buildCartReviewUI({
          summaryText: formatCartSummary(modResult.updatedCart, business),
          total:       cartTotal(modResult.updatedCart),
          itemCount:   cartItemCount(modResult.updatedCart),
          business,
          note: modResult.mod.type === 'remove' ? '\n\n_(Removed from your cart.)_' : '\n\n_(Updated the quantity.)_',
        });
      }

      // Unrecognised â€” re-show the summary unchanged.
      return buildCartReviewUI({
        summaryText: formatCartSummary(cart, business),
        total:       cartTotal(cart),
        itemCount:   cartItemCount(cart),
        business,
      });
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // [MULTICART-v40-EDIT] Edit Order top-level menu: Add / Remove / Increase
    // / Decrease / Clear / Back to Summary.
    case 'EDIT_CART_MENU': {
      const cart = Array.isArray(data.cart) ? data.cart : [];

      const action = raw; // list-reply row id, e.g. 'EDIT_ADD'
      const isBack = action === 'EDIT_BACK' || /^(back|back to summary|summary)$/i.test(clean);
      if (isBack) {
        if (!cart.length) return await _browseForMoreItems(session, business, tenant, data);
        await updateSession(session.customerPhone, session.tenantId, { step: 'CONFIRM' });
        return buildCartReviewUI({
          summaryText: formatCartSummary(cart, business),
          total:       cartTotal(cart),
          itemCount:   cartItemCount(cart),
          business,
        });
      }

      if (action === 'EDIT_ADD' || /^(add|add item)$/i.test(clean)) {
        return await _browseForMoreItems(session, business, tenant, data);
      }

      if (action === 'EDIT_CLEAR' || /^(clear|clear cart|empty cart)$/i.test(clean)) {
        const clearedData = {
          ...data,
          cart: clearCart(),
          ...(data.orderViaCatalog ? { orderViaCatalog: true } : {}),
        };
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'SELECT_ITEM', data: clearedData,
        });
        return await _browseForMoreItems(session, business, tenant, clearedData, {
          note: 'ðŸ—‘ï¸ Your cart has been cleared.\n\n',
        });
      }

      if (!cart.length) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM' });
        return await _browseForMoreItems(session, business, tenant, data);
      }

      const editAction = { EDIT_REMOVE: 'remove', EDIT_INCREASE: 'increase', EDIT_DECREASE: 'decrease' }[action]
        || (/^(remove|delete)$/i.test(clean) && 'remove')
        || (/^(increase|more)$/i.test(clean) && 'increase')
        || (/^(decrease|less|fewer)$/i.test(clean) && 'decrease');

      if (editAction) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'EDIT_CART_PICK', data: { ...data, pendingEditAction: editAction },
        });
        return buildEditCartPickerUI({
          numberedSummary: formatNumberedCartSummary(cart, business),
          actionLabel: editAction,
        });
      }

      // Unrecognised â€” re-show the edit menu.
      return buildEditCartMenuUI();
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // [MULTICART-v40-EDIT] Customer replies with a line number to remove/
    // increase/decrease, chosen from EDIT_CART_MENU.
    case 'EDIT_CART_PICK': {
      let cart = Array.isArray(data.cart) ? data.cart : [];
      const action = data.pendingEditAction;

      if (/^(back|cancel)$/i.test(clean)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'EDIT_CART_MENU' });
        return buildEditCartMenuUI();
      }

      const num = parseInt(raw.trim(), 10);
      const index = num - 1;
      if (!Number.isInteger(num) || index < 0 || index >= cart.length) {
        return buildEditCartPickerUI({
          numberedSummary: formatNumberedCartSummary(cart, business),
          actionLabel: action,
        });
      }

      if (action === 'remove') {
        cart = removeCartLine(cart, index);
      } else if (action === 'increase') {
        cart = incrementCartLine(cart, index, 1);
      } else if (action === 'decrease') {
        cart = decrementCartLine(cart, index, 1);
      }
      const { cart: cappedCart } = enforceCartLimit(cart, business);

      await updateSession(session.customerPhone, session.tenantId, {
        data: {
          ...data,
          cart: cappedCart,
          pendingEditAction: null,
          ...(data.orderViaCatalog ? { orderViaCatalog: true } : {}),
        },
      });

      if (!cappedCart.length) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM' });
        return await _browseForMoreItems(session, business, tenant, {
          ...data,
          cart: [],
          ...(data.orderViaCatalog ? { orderViaCatalog: true } : {}),
        }, { note: 'Your cart is now empty.\n\n' });
      }

      await updateSession(session.customerPhone, session.tenantId, { step: 'CONFIRM' });
      return buildCartReviewUI({
        summaryText: formatCartSummary(cappedCart, business),
        total:       cartTotal(cappedCart),
        itemCount:   cartItemCount(cappedCart),
        business,
        note: `\n\n_(Cart updated.)_`,
      });
    }

    // â”€â”€ Payment / wait steps â€” normally handled in webhookController.js;
    // these cases prevent a direct advance() call from silently dumping the menu.
    case 'PAYMENT_PROOF':
      return {
        type: 'text',
        body: 'Please send your *payment screenshot* here, or tap *Done* once you\'ve paid.',
      };

    case 'AWAIT_ADMIN_CONFIRM':
      return {
        type:    'buttons',
        body:    'Your order is with our team â€” we\'ll confirm it shortly. ðŸ™',
        buttons: [{ id: 'CANCEL', title: 'âŒ Cancel Order' }],
      };

    default: {
      logger.warn('[RestaurantOrderFlow] Unhandled step â€” recovering to SELECT_ITEM', {
        step, tenantId: session.tenantId, phone: session.customerPhone,
      });
      const existingCart = Array.isArray(data.cart) ? data.cart : [];
      const viaCatalog   = data.orderViaCatalog === true;
      const recoveryData = existingCart.length
        ? { cart: existingCart, ...(viaCatalog ? { orderViaCatalog: true } : {}) }
        : (viaCatalog ? { orderViaCatalog: true } : {});
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'SELECT_ITEM',
        data: recoveryData,
      });
      const count = cartItemCount(existingCart);
      return {
        type:    'buttons',
        body:    existingCart.length
          ? `Something went wrong with your order step (*${step}*). Your cart is still saved (${count} item${count > 1 ? 's' : ''}). Tap below to continue or cancel.`
          : `Something went wrong with your order step (*${step}*). Tap below to browse the menu or cancel.`,
        buttons: [
          { id: 'BROWSE_CATALOG', title: 'ðŸ› Browse Catalog' },
          ...(existingCart.length ? [{ id: 'REVIEW_CART', title: 'ðŸ§¾ Review Cart' }] : []),
          { id: 'CANCEL', title: 'âŒ Cancel' },
        ],
      };
    }
  }
}

// â”€â”€ Cart-modification helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * _resolveCartModification(session, business, data, cart, raw)
 * [CART-AI-MODIFY] Shared by ITEM_ADDED and CONFIRM â€” tries to read `raw` as
 * a free-text edit against the items already in the cart ("remove the
 * coke", "make it 3 fries"). Persists the updated cart itself (moving to
 * SELECT_ITEM if it emptied out) so callers only need to build the
 * follow-up UI. Returns null when `raw` doesn't read as a modification at
 * all, so callers fall through to their normal handling unchanged.
 */
async function _resolveCartModification(session, business, data, cart, raw) {
  const mod = parseCartModification(cart, raw);
  if (!mod) return null;
  const updatedCart = applyCartModification(cart, mod);
  if (!updatedCart.length) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_ITEM',
      data: { ...data, cart: [], ...(data.orderViaCatalog ? { orderViaCatalog: true } : {}) },
    });
  } else {
    await updateSession(session.customerPhone, session.tenantId, { data: { ...data, cart: updatedCart } });
  }
  return { mod, updatedCart };
}

// â”€â”€ Catalog-aware browse (add-more / empty-cart / recovery) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * _browseForMoreItems(session, business, tenant, data, { note })
 * [FIX-CATALOG-ADD-MORE] Catalog-sourced orders re-open WA Catalog; typed-menu
 * orders fall back to buildMenuUI(). Returns null when the catalog was sent
 * directly (no further UIResponse needed).
 *
 * [AUDIT-FIX-XZ-REMOVE] The catalog branch below used to key ONLY off
 * data.orderViaCatalog. tryResumeCatalogShopping() itself returns `false`
 * whenever that one flag is missing â€” even for a tenant whose WA Catalog is
 * fully live â€” and this function then fell straight through to buildMenuUI()
 * (the legacy "Choose an option â–¼" list) with no further catalog attempt.
 * That is the exact X-flow regression: a catalog-ready tenant landing back
 * on the broken legacy list because of a stale/missing session flag rather
 * than because catalog genuinely isn't available. isCatalogEnabled(business)
 * is now the deciding check, matching browseCatalogExplicit()'s existing
 * [CATALOG-ONLY-1] rule ("no text-menu fallback for catalog-enabled
 * tenants"). When catalog is enabled but tryResumeCatalogShopping declines
 * purely because the flag was unset, browseCatalogExplicit() is used
 * instead â€” it sends the same catalog message without requiring the flag.
 */
async function _browseForMoreItems(session, business, tenant, data, { note = '' } = {}) {
  const cart = Array.isArray(data?.cart) ? data.cart : [];
  const catalogReady = isCatalogEnabled(business);
  if (data?.orderViaCatalog || catalogReady) {
    const { tryResumeCatalogShopping, browseCatalogExplicit } = await import('../../catalog/waCatalogFlow.js');
    let catalogResult = await tryResumeCatalogShopping({ session, business, tenant });
    if (catalogResult === false && catalogReady) {
      // Flag was missing but catalog is genuinely live â€” send it directly
      // instead of dropping into the legacy list.
      catalogResult = await browseCatalogExplicit({ session, business, tenant });
    }
    if (catalogResult === null) return null;
    if (catalogResult !== false) {
      if (note && typeof catalogResult.body === 'string') catalogResult.body = note + catalogResult.body;
      return catalogResult;
    }
  }
  await updateSession(session.customerPhone, session.tenantId, {
    step: 'SELECT_ITEM',
    data: { ...data, cart },
  });
  const menuUI = buildMenuUI(business);
  if (note && typeof menuUI.body === 'string') menuUI.body = note + menuUI.body;
  return menuUI;
}

// â”€â”€ Add-item-to-cart helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * _addItemAndPrompt(session, business, data, { item, quantity, variant, addOns })
 * [MULTICART-v40-EDIT] Folds a single resolved item (from QUANTITY or UPSELL)
 * into data.cart and moves to ITEM_ADDED â€” the only prompt shown right after
 * an item is added ("add another item?" / "review & checkout"). Replaces the
 * old per-item "Confirm Order?" screen (buildOrderSummary/_addAnotherItem).
 * Extracted to a helper for the same reason _addAnotherItem was before it â€”
 * keeps the QUANTITY/UPSELL case bodies short.
 */
async function _addItemAndPrompt(session, business, data, { item, quantity, variant, addOns }) {
  const priorCart = Array.isArray(data.cart) ? data.cart : [];
  const merged = mergeCartLines(priorCart, [{ item, quantity, variant: variant || null, addOns: addOns || [] }]);
  const { cart: cappedCart, overflowCount } = enforceCartLimit(merged, business);

  await updateSession(session.customerPhone, session.tenantId, {
    step: 'ITEM_ADDED',
    data: { cart: cappedCart, ...(data.orderViaCatalog ? { orderViaCatalog: true } : {}) },
    upsellSent: false,
  });

  const overflowNote = overflowCount > 0
    ? `\n\n_(Your cart can hold up to ${business?.multiItemCart?.maxItems || 10} items â€” ${overflowCount} extra item${overflowCount > 1 ? 's were' : ' was'} left out.)_`
    : '';
  // [AUDIT-FIX-CATALOG-VARIANT-LOSS] fold variant into the display name here too,
  // not just at final cart review (cartEngine's formatCartSummary already does this).
  const ui = buildItemAddedUI({ item: itemLabel(item, variant), qty: quantity, business, cartCount: cartItemCount(cappedCart) });
  if (overflowNote) ui.body += overflowNote;
  return ui;
}

// â”€â”€ Cart checkout helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * _checkoutCart(cart, session, business, tenant)
 * [MULTICART-v39-PHASE2] Multi-item counterpart to the CONFIRM step's
 * single-item save logic above. Mirrors modules/catalog/waCatalogFlow.js's
 * handleMultiItemCatalogOrder() â€” same saveOrder({items}) call, same
 * payment-vs-cash branching, same admin alert shape â€” so a text-typed
 * multi-item order and a WA-Catalog multi-item order behave identically
 * from here on. Reached from CONFIRM once items have been accumulated via
 * "Add Another Item" or a WA Catalog / typed multi-item handoff.
 */
async function _checkoutCart(cart, session, business, tenant) {
  const data = session.data || {};

  let savedOrder = null;
  try {
    savedOrder = await saveOrder({
      items:         cartToOrderItems(cart),
      customerName:  session.customerName || null,
      customerPhone: session.customerPhone,
      tenantId:      session.tenantId,
      businessId:    business._id,
    });

    trackOrderAnalytics(
      cart.map(l => l.item?.name).filter(Boolean).join(', '),
      business.phoneNumberId || null,
      cart.reduce((sum, l) => sum + (l.quantity || 0), 0),
      savedOrder.totalPrice || 0,
      session.tenantId
    ).catch(() => {});
  } catch (err) {
    logger.error('[OrderFlow] _checkoutCart: saveOrder failed', { err: err.message });
    await updateSession(session.customerPhone, session.tenantId, {
      currentFlow: null, step: null, data: {},
    });
    return {
      type:    'buttons',
      body:    `âš ï¸ *Something went wrong saving your order.*\n\nPlease try again â€” tap below to start over.`,
      buttons: [
        { id: 'ORDER',   title: 'ðŸ›’ Try Again'  },
        { id: 'SUPPORT', title: 'ðŸ’¬ Contact Us' },
      ],
    };
  }

  const totalPrice  = savedOrder.totalPrice;
  const payment     = business?.payment;
  const currency    = payment?.currency || 'D';
  const cartSummary = formatCartSummary(cart, business);
  const itemCount   = cartItemCount(cart);
  const usePayment  = payment?.enabled && totalPrice != null;

  // [AUDIT-FIX-ORDER-POLISH-9] "Order Time" â€” the one item from the review's
  // suggested admin-alert additions that's always available with no new data
  // capture required. "Delivery/Pickup" and "Customer Note" are intentionally
  // NOT added here: this flow doesn't currently ask the customer for either,
  // so fabricating a line for data that doesn't exist would be worse than
  // omitting it. Capturing them is a real feature addition (a new flow step),
  // not a formatting fix â€” flagged separately rather than guessed at here.
  const orderTimeStr = new Date().toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });

  if (usePayment) {
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
      step: 'PAYMENT_PROOF', currentFlow: 'ORDER', data: {},
    });

    try {
      const adminPhone = business?.adminPhone || tenant?.adminPhone;
      if (adminPhone && tenant) {
        const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
        await dispatchMessage(adminPhone, {
          type: 'text',
          body:
            `ðŸ”” *New Order â€” ${business.name || 'Restaurant'}*\n\n` +
            `${formatPhoneDisplay(session.customerPhone)}\n` +
            `ðŸ• Order Time: ${orderTimeStr}\n\n` +
            `ðŸ›’ Items (${itemCount}):\n${cartSummary}\n` +
            `ðŸ’° Total: *${currency}${formatMoney(totalPrice)}*\n` +
            `ðŸ“ Ref: *${ref}*\n\n` +
            `â³ Status: *Pending* â€” awaiting payment screenshot.`,
        }, tenant).catch(() => {});
      }
    } catch { /* non-fatal */ }

    return buildPaymentInstructionsUI(business, totalPrice, shortId, ref);
  }

  // Cash / no-payment branch â€” mirrors CONFIRM's own cash branch: always
  // park at AWAIT_ADMIN_CONFIRM with tap-to-confirm admin buttons, never a
  // silent flow reset (see waCatalogFlow.js [FIX-CATALOG-CART-3] for why
  // this matters â€” a cash order with no AWAIT_ADMIN_CONFIRM lock lets the
  // customer immediately start a second order while the first is unconfirmed).
  try {
    const adminPhone = business?.adminPhone || tenant?.adminPhone;
    if (adminPhone && tenant && savedOrder) {
      const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
      await dispatchMessage(adminPhone, {
        type:    'buttons',
        body:
          `ðŸ”” *New Order â€” ${business.name || 'Restaurant'}*\n\n` +
          `${formatPhoneDisplay(session.customerPhone)}\n` +
          `ðŸ• Order Time: ${orderTimeStr}\n\n` +
          `ðŸ›’ Items (${itemCount}):\n${cartSummary}\n` +
          (totalPrice != null ? `ðŸ’° Total: *${currency}${formatMoney(totalPrice)}*\n` : '') +
          `ðŸ”– Ref: \`#${savedOrder.shortId}\`\n\n` +
          `â³ Status: *Pending* â€” please confirm.`,
        buttons: [
          { id: `APPROVE_${savedOrder.shortId}`, title: 'âœ… Confirm Received' },
          { id: `REJECT_${savedOrder.shortId}`,  title: 'âŒ Cancel Order'     },
        ],
      }, tenant).catch(() => {});
    }
  } catch { /* non-fatal */ }

  await updateSession(session.customerPhone, session.tenantId, {
    step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER', data: {},
  });

  // [AUDIT-FIX-ORDER-POLISH-8] Previously this confirmation never showed the
  // customer their own reference number (only the admin alert got one) and
  // never stated a "Status" â€” just a soft "please wait" line. A customer
  // with no order number has nothing to quote if they follow up.
  return {
    type: 'text',
    body:
      `âœ… *Order Confirmed*\n\n` +
      `Your order has been received successfully.\n\n` +
      `ðŸ§¾ Items (${itemCount}):\n${cartSummary}\n` +
      (totalPrice != null ? `ðŸ’° Total: *${currency}${formatMoney(totalPrice)}*\n\n` : '\n') +
      `ðŸ”– Reference: *#${savedOrder.shortId}*\n` +
      `â³ Status: *Pending*\n\n` +
      `We'll notify you once the restaurant confirms your order.`,
  };
}

// â”€â”€ Select item helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function _selectItem(item, session, business, data) {
  if (data?.pendingNaturalQuantity) {
    const quantity = data.pendingNaturalQuantity;
    const nextData = { ...data, item, pendingNaturalQuantity: null };
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'ITEM_ADDED', data: nextData, menuViewed: true,
    });
    return _addItemAndPrompt(session, business, nextData, {
      item, quantity, variant: null, addOns: [],
    });
  }

  // [AUDIT-FIX-ADDON-1] Previously the teaser here always advertised addOns[0],
  // but the QUANTITY step's upsell prompt picked a DIFFERENT, RANDOM add-on from
  // the same list â€” a customer could be told "*Soft Drink* pairs well with this"
  // and then be asked "Would you like to add *Dessert*?" one message later. The
  // add-on is now chosen ONCE here, pinned as data.pendingAddOn, and QUANTITY
  // (which already prefers data.pendingAddOn over re-rolling) reuses that same
  // pinned choice â€” so the teaser and the actual checkout offer always match.
  const addOns       = business?.addOns || [];
  const pendingAddOn = addOns.length ? addOns[Math.floor(Math.random() * addOns.length)] : null;

  await updateSession(session.customerPhone, session.tenantId, {
    step: 'QUANTITY', data: { ...data, item, pendingAddOn }, menuViewed: true,
  });

  const addOnText = pendingAddOn
    ? `\n\nðŸ’¡ *${pendingAddOn.name}* pairs well with this â€” we'll ask at checkout!`
    : '';

  // â”€â”€ Send item image if available and showImageOnSelect is not disabled â”€â”€â”€â”€
  // The image message is dispatched separately BEFORE the quantity-prompt reply.
  // We return an array of UI payloads; flowEngine dispatches them in sequence.
  const imageUrl = item?.image?.url;
  const showImage = item?.showImageOnSelect !== false; // default true

  const MAX_QTY_DISPLAY = business?.settings?.maxOrderQuantity || 20;
  const quantityPrompt = {
    type: 'text',
    body: `You've chosen *${item.name}* ðŸ‘Œ${addOnText}\n\nHow many would you like? Please type a number (e.g. *2*) or a word (e.g. *five*). Maximum: *${MAX_QTY_DISPLAY}*.`,
  };

  if (imageUrl && showImage) {
    // Return array â€” flowEngine will dispatch both in order: image first, then buttons.
    // [FIX-IMG-URL] Apply WhatsApp delivery optimization (q_auto, f_auto, max w_1600)
    // before sending. The stored URL may have no transformation segment; this adds one.
    const whatsappImageUrl = buildWhatsAppImageUrl(imageUrl);
    return [
      {
        type:    'image',
        url:     whatsappImageUrl,
        caption: item.description
          ? `*${item.name}*\n${item.description}${item.price ? `\nðŸ’° ${business?.payment?.currency || 'D'}${formatMoney(item.price)}` : ''}`
          : `*${item.name}*${item.price ? ` â€” ${business?.payment?.currency || 'D'}${formatMoney(item.price)}` : ''}`,
      },
      quantityPrompt,
    ];
  }

  return quantityPrompt;
}

// â”€â”€ Restaurant Question Handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * handleRestaurantQuestion
 * Handles the QUESTION button and keyword-triggered FAQ intent for restaurant mode.
 * Question Mode stays active until the customer explicitly switches activity.
 */
export async function handleRestaurantQuestion({ session, message, business, tenant }) {
  const raw = String(message || '').trim();

  if (!raw || raw.length < 2) {
    return {
      type: 'text',
      body: 'â“ What would you like to know? Ask about our menu, hours, allergens, or anything else!',
    };
  }

  const { processQuestionMessage, persistQuestionSession } = await import('../../../services/question/questionAnswerService.js');
  const { detectIntent } = await import('../../../core/intents/intentEngine.js');
  const { buildStatusReply } = await import('../../../services/activity/activityStatusService.js');

  try {
    const intentResult = await detectIntent({
      message: raw, isInteractive: false,
      session: { ...session, currentFlow: null },
      business,
    });
    if (intentResult.action === 'TRACK_ORDER' && intentResult.confidence === 'HIGH') {
      const statusReply = await buildStatusReply({ session, business, message: raw });
      await persistQuestionSession(session, tenant, { lastMessage: raw, lastTopic: 'ORDER_TRACKING' });
      return statusReply;
    }
  } catch (_) { /* fall through */ }

  // Answer-only: stay in QUESTION mode and wait for the next message. Switching
  // to another activity is handled upstream (webhookController's mid-flow switch
  // detector) from the customer's own words, not from buttons on this reply.
  const reply = await processQuestionMessage({ session, message: raw, business, tenant, intent: 'FAQ' });
  await persistQuestionSession(session, tenant, reply.context || { lastMessage: raw });
  return { type: reply.type, body: reply.body };
}

