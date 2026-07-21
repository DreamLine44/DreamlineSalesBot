/**
 * modules/restaurant/flows/orderFlow.js
 *
 * Handles the full ORDER flow for restaurants (and all ORDER-capable modules).
 * Registered with flowEngine for RESTAURANT:ORDER and as the generic ORDER handler.
 *
 * Steps: SELECT_ITEM → QUANTITY → [UPSELL?] → CONFIRM → [PAYMENT?] → DONE
 *
 * FIXES:
 * [FIX-1] norm() regex was missing the 'g' flag — only the FIRST whitespace run was
 *         collapsed. "jollof  rice  combo" → "jollof rice  combo" (double-space survives).
 *         Fuzzy matching then failed against the normalised item name. Fixed: /\s+/g.
 *
 * [FIX-2] WORD_NUMS was 1-based (one:1, two:2 …) but numIndex feeds directly into
 *         menu[numIndex]. "one" gave menu[1] (the SECOND item). Fixed: now 0-indexed.
 *
 * [FIX-3] After order confirm with no payment configured, the admin was never notified.
 *         Cash/no-payment restaurants had silent orders — admin had no idea.
 *         Fixed: dispatchText() to adminPhone after every successful order save.
 *
 * [FIX-4] Payment step was reusing session data without re-fetching — race condition
 *         on slow connections. Now reads totalPrice from confirmed data object.
 */

import { updateSession }    from '../../../core/sessions/sessionService.js';
import { completeFlow }     from '../../../core/conversations/flowEngine.js';
import { getAIReply }       from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }    from '../../../utils/matchEngine.js';
import { buildMenuUI, buildOrderSummary, buildOrderSuccess } from '../handlers/uiBuilders.js';
import { parseQuantity }    from '../../../utils/parseQuantity.js';
import { saveOrder }        from '../../../services/orderService.js';
import { trackOrderAnalytics } from '../../../core/analytics/analyticsService.js';
import { dispatchText }     from '../../../core/whatsapp/dispatcher.js';
import { buildPaymentInstructionsUI } from '../../../services/paymentService.js';
import { buildWhatsAppImageUrl }       from '../../../config/cloudinary.js';
import logger               from '../../../config/logger.js';

// ── Normalise — [FIX-1] /\s+/ was missing the 'g' flag ──────────────────────
const norm = (s = '') => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

// ── Word-number map — 0-indexed — [FIX-2] was 1-based causing off-by-1 errors ─
// "one" → menu[0], "two" → menu[1], etc. (parseInt path already does -1)
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

  // ── No menu configured ────────────────────────────────────────────────────
  // [FIX-FLOW-STUCK] Clear currentFlow BEFORE returning so the session is not
  // permanently stuck in ORDER state. Without this, every subsequent message from
  // the customer re-enters handleOrderFlow (currentFlow='ORDER'), hits this guard
  // again, and returns the same error indefinitely — the bot becomes unresponsive.
  if (!menu.length) {
    await updateSession(session.customerPhone, session.tenantId, {
      currentFlow: null, step: null, data: {},
    });
    const cfg = (await import('../../../config/modes.js')).getModeConfig(business);
    return {
      type:    'buttons',
      body:    '⚠️ Our menu is being updated. Please contact us directly.',
      buttons: [
        { id: 'SUPPORT',   title: '💬 Contact Us'  },
        { id: 'SHOW_MENU', title: '🔄 Start Over'  },
      ],
    };
  }

  // ── INIT (message = null — start of flow) ─────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_ITEM', data: {}, menuViewed: false, upsellSent: false,
    });
    return buildMenuUI(business);
  }

  switch (step) {

    // ────────────────────────────────────────────────────────────────────────
    case 'SELECT_ITEM': {
      // [FIX-2] 0-indexed WORD_NUMS: WORD_NUMS['one']=0 → menu[0] ✓
      // [AUDIT-FIX-PARSEINT-6] parseInt("2 red shirts", 10) === 2, not NaN — a bare
      // leading digit used to silently hijack the menu index for ANY mixed
      // alphanumeric reply once menuViewed was true. The WORD_NUMS lookup is
      // exact-match-only and safe; only the parseInt fallback needed gating so
      // it never fires on mixed alphanumeric input.
      const isPureNumeric = /^\d+$/.test(raw.trim());
      const numIndex = WORD_NUMS[clean] ?? (isPureNumeric ? parseInt(raw, 10) - 1 : NaN);
      const isNum    = !isNaN(numIndex) && numIndex >= 0;

      if (isNum) {
        const trustedPick = isInteractive || session.menuViewed;
        if (!trustedPick) {
          // Typed a number before seeing menu — show menu first
          await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
          return buildMenuUI(business);
        }
        const item = menu[numIndex];
        if (!item) return buildMenuUI(business);
        return await _selectItem(item, session, business, data);
      }

      // Cancel / escape keywords — let the flow engine handle them
      if (/^(cancel|stop|exit|back|menu|home)$/i.test(clean)) {
        return buildMenuUI(business);
      }

      // Too short — show a gentle nudge instead of just dumping the menu again
      // [FIX-NUDGE-BTN-MISMATCH] This text told the customer to tap "View Menu",
      // but the button was labeled "🔄 Start Over" with id SHOW_MENU — which
      // resets the session and shows the generic top-level welcome list, not
      // the actual food menu. Fixed to a VIEW_MENU button so the button matches
      // the instruction and actually renders the menu (see moduleRouter.js's
      // VIEW_MENU case → startFlow('ORDER') → buildMenuUI()).
      if (clean.length < 3) {
        return {
          type:    'buttons',
          body:    `Please type the name of what you'd like to order, or tap *View Menu* to see all options:`,
          buttons: [{ id: 'VIEW_MENU', title: '📋 View Menu' }],
        };
      }

      // ── Casual / gibberish / off-topic detection ─────────────────────────────
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
          body:    `Hi there! 😊 You're in the ordering flow for *${business.name || 'our restaurant'}*.\n\nPlease type the *name of a dish* you'd like to order, or tap below to browse the full menu:`,
          buttons: [
            { id: 'VIEW_MENU', title: '📋 View Menu' }, // [AUDIT-FIX-VIEWMENU] was SHOW_MENU
            { id: 'CANCEL',    title: '❌ Cancel'    },
          ],
        };
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
          body:    `🤔 Did you mean *${item.name}*?`,
          buttons: [
            { id: 'CONFIRM', title: `✅ Yes, ${item.name.slice(0,15)}` },
            { id: 'SHOW_MENU', title: '🔄 Start Over' },
          ],
        };
      }

      // No match — show helpful nudge, not just a raw menu dump
      return {
        type:    'buttons',
        body:    `I couldn't find "*${raw.slice(0,30)}*" on our menu.\n\nTap below to browse all items:`,
        buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
      };
    }

    // ────────────────────────────────────────────────────────────────────────
    case 'SUGGESTION_CONFIRM': {
      if (/^(yes|y|yep|yeah|confirm|ok|okay)$/i.test(clean) || clean === 'confirm') {
        const suggestedName = data.suggestion;
        const item = menu.find(i => norm(i.name) === norm(suggestedName));
        if (item) return await _selectItem(item, session, business, data);
      }
      return buildMenuUI(business);
    }

    // ────────────────────────────────────────────────────────────────────────
    case 'QUANTITY': {
      // Customers type any number (digit or word) — parseQuantity handles both.
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
          body: `⚠️ Maximum order quantity is *${MAX_QTY}*. Please type a number between *1* and *${MAX_QTY}*.`,
        };
      }
      const item   = data.item;
      const price  = item?.price || 0;
      const total  = price * qty;
      const addOns = business?.addOns || [];

      // Upsell — if configured and not yet shown
      if (addOns.length && !session.upsellSent) {
        // [FIX-14] Pin the add-on at first selection — re-use the stored one if we
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
          body:    `You've chosen *${qty}× ${item.name}*${total ? ` — ${currency}${total}` : ''}.\n\nWould you like to add *${addOn.name}* for ${currency}${addOn.price}? 🥤`,
          buttons: [
            { id: 'UPSELL_YES', title: '✅ Yes, add it' },
            { id: 'UPSELL_NO',  title: '❌ No thanks'   },
          ],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM', data: { ...data, quantity: qty, totalPrice: total },
      });
      return buildOrderSummary({ item, qty, total, business });
    }

    // ────────────────────────────────────────────────────────────────────────
    case 'UPSELL': {
      const addOn    = data.pendingAddOn;
      const accepted = /^(yes|y|yep|yeah|ok|okay|sure|add|upsell_yes)$/i.test(clean) || clean === 'upsell_yes';

      let finalTotal = data.totalPrice || 0;
      let addOnsList = data.addOns || [];

      if (accepted && addOn) {
        finalTotal += addOn.price;
        addOnsList  = [...addOnsList, addOn.name];
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM', data: { ...data, totalPrice: finalTotal, addOns: addOnsList },
      });
      return buildOrderSummary({ item: data.item, qty: data.quantity, total: finalTotal, addOns: addOnsList, business });
    }

    // ────────────────────────────────────────────────────────────────────────
    case 'CONFIRM': {
      // [AUDIT-FIX-CONFIRM-1] Was missing "yeah"/"yep" — every other confirm
      // step in this file (SUGGESTION_CONFIRM, UPSELL) already accepts them.
      // This is the step that actually SAVES the order, so a customer typing
      // "yeah" here got the summary silently re-displayed instead of their
      // order being placed.
      const isConfirm = /^(yes|y|yep|yeah|confirm|ok|okay|sure|place|confirmed)$/i.test(clean);
      if (!isConfirm) {
        return buildOrderSummary({ item: data.item, qty: data.quantity, total: data.totalPrice, business });
      }

      // Save order
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          item:          data.item?.name,
          quantity:      data.quantity,
          totalPrice:    data.totalPrice,
          addOns:        data.addOns,
          // [FIX-SAVE-2] customerName was not passed — silently dropped by Mongoose
          // strict mode because it was present in the schema (added in FIX-SAVE-1)
          // but missing from every saveOrder() call in this module. The Order document
          // was saved with customerName=null even when the customer had introduced
          // themselves, making the dashboard order list show no customer names.
          customerName:  session.customerName || null,
          customerPhone: session.customerPhone,
          tenantId:      session.tenantId,
          businessId:    business._id,
        });

        // Track analytics
        trackOrderAnalytics(
          data.item?.name,
          business.phoneNumberId || null,
          data.quantity,
          data.totalPrice || 0,
          session.tenantId
        ).catch(() => {});
        // [AUDIT-FIX-4] recordRevenue() moved to adminCommandService.confirmPayment() —
        // recording it here at placement time counted unconfirmed/later-rejected orders
        // as revenue. See adminCommandService.js AUDIT-FIX-4 for full rationale.
      } catch (err) {
        logger.error('[OrderFlow] saveOrder failed', { err: err.message });
        // [FIX-SAVE-ERR] If we couldn't persist the order, do NOT proceed to payment
        // instructions or AWAIT_ADMIN_CONFIRM — the customer would be stuck (no order
        // in DB to approve, or payment instructions for a ghost order). Clear the flow
        // and show a retry prompt so the customer can try again immediately.
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

      // Payment configured?
      const payment = business?.payment;
      if (payment?.enabled && data.totalPrice) {
        const shortId = savedOrder?.shortId || '';
        // [FIX-INLINE] Generate reference centrally (MMDD format) and store it.
        // Previously orderFlow had its own inline builder duplicating buildPaymentInstructionsUI
        // with an inconsistent date format. Now one source of truth.
        const now  = new Date();
        const mm   = String(now.getMonth() + 1).padStart(2, '0');
        const dd   = String(now.getDate()).padStart(2, '0');
        const ref  = `DSB-${mm}${dd}-${shortId}`;

        // Store the reference on the order
        if (savedOrder?._id) {
          const { default: Order } = await import('../../../models/Order.js');
          Order.updateOne({ _id: savedOrder._id }, { $set: { paymentReference: ref } }).catch(() => {});
        }

        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });

        // Notify admin that a new order is pending payment
        try {
          const adminPhone = business?.adminPhone || tenant?.adminPhone;
          if (adminPhone && tenant && savedOrder) {
            const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
            const currency = payment.currency || 'D';
            await dispatchMessage(adminPhone, {
              type: 'text',
              body:
                `🔔 *New Order — ${business.name || 'Restaurant'}*\n\n` +
                `👤 Customer: *${session.customerPhone}*\n` +
                `🛒 Items: *${data.quantity}× ${data.item?.name}*\n` +
                `💰 Total: *${currency}${data.totalPrice}*\n` +
                `📝 Ref: *${ref}*\n\n` +
                `⏳ Status: *Pending* — awaiting payment screenshot.`,
            }, tenant).catch(() => {});
          }
        } catch { /* non-fatal */ }

        // [FIX-INLINE] Use shared buildPaymentInstructionsUI — no more inline duplication
        return buildPaymentInstructionsUI(business, data.totalPrice, shortId, ref);
      }

      // [FIX-3] Payment not enabled by tenant — show default cash/delivery instructions,
      // then notify admin. We NEVER silently skip the payment step; the customer must
      // always see how to pay (even if the answer is "cash on delivery").
      if (!payment?.enabled || !data.totalPrice) {
        const currency   = payment?.currency || 'D';
        // [FIX-CASH-MODE] Only show channel instructions when payment IS enabled.
        // When payment.enabled=false (cash mode), payment.channels may still be populated
        // from a previous config — must NOT be shown. Cash-mode restaurants must always
        // show the cash-on-delivery message regardless of what channels array contains.
        const hasChannels = payment?.enabled && Array.isArray(payment?.channels) && payment.channels.length > 0;
        const cashBody =
          `💳 *Payment*\n\n` +
          `🛒 Total: *${currency}${data.totalPrice || 0}*\n\n` +
          (hasChannels
            ? (() => {
                const lines = payment.channels.map((ch, i) =>
                  `${i + 1}. *${ch.provider}* → \`${ch.accountNo}\`${ch.label ? ` (${ch.label})` : ''}${ch.isDefault ? ' ⭐' : ''}`
                ).join('\n');
                return `📲 Please complete payment to any of the following:\n\n${lines}\n\nThen send your payment screenshot in this chat.`;
              })()
            : `💵 *Payment mode:* Cash on delivery\n\nPlease have *${currency}${data.totalPrice || 0}* ready when your order arrives.`
          );

        // [FIX-3] No payment — notify admin with interactive buttons
        try {
          const adminPhone = business?.adminPhone || tenant?.adminPhone;
          if (adminPhone && tenant && savedOrder) {
            const { buildAdminOrderAlertBody } = await import('../handlers/uiBuilders.js');
            const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
            const alertBody = buildAdminOrderAlertBody({
              customerPhone: session.customerPhone,
              item:          data.item?.name,
              quantity:      data.quantity,
              totalPrice:    data.totalPrice,
              addOns:        data.addOns,
              shortId:       savedOrder.shortId,
              business,
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
          logger.warn('[OrderFlow] Admin notification failed (non-fatal)', { err: err.message });
        }

        // [FIX-AWAIT] Keep the session alive in AWAIT_ADMIN_CONFIRM so stale buttons
        // from earlier steps cannot restart the flow and the customer knows to wait.
        // Do NOT call completeFlow() here — that clears the session and makes the
        // "Place New Order / Start Over" buttons actionable before admin confirms.
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER',
          data: { ...data },
        });
        return {
          type: 'text',
          body: cashBody + '\n\n' +
                '⏳ Your order has been received. Please wait for our team to confirm it before placing a new one.',
        };
      }

      const _lcR = await completeFlow(session, 'ORDER', business, tenant);
      if (_lcR) return _lcR;
      return buildOrderSuccess({ item: data.item, qty: data.quantity, business });
    }

    default:
      return buildMenuUI(business);
  }
}

// ── Select item helper ────────────────────────────────────────────────────────
async function _selectItem(item, session, business, data) {
  const addOns = business?.addOns || [];
  // [FIX-SELECTITEM-ADDON-1] Previously the teaser text always hardcoded
  // addOns[0], while the later QUANTITY-step upsell prompt picks a RANDOM
  // add-on (data.pendingAddOn || addOns[Math.floor(Math.random() * ...)]) —
  // so a customer could be teased "Coke pairs well with this" and then get
  // offered "Fries" moments later. Fix: pin the choice ONCE here and persist
  // it as pendingAddOn so both the teaser and the actual upsell prompt (which
  // already prefers data.pendingAddOn when present) reference the same item.
  const pendingAddOn = addOns.length ? addOns[Math.floor(Math.random() * addOns.length)] : null;

  await updateSession(session.customerPhone, session.tenantId, {
    step: 'QUANTITY', data: { ...data, item, pendingAddOn }, menuViewed: true,
  });

  const addOnText = pendingAddOn
    ? `\n\n💡 *${pendingAddOn.name}* pairs well with this — we'll ask at checkout!`
    : '';

  // ── Send item image if available and showImageOnSelect is not disabled ────
  // The image message is dispatched separately BEFORE the quantity-prompt reply.
  // We return an array of UI payloads; flowEngine dispatches them in sequence.
  const imageUrl = item?.image?.url;
  const showImage = item?.showImageOnSelect !== false; // default true

  const MAX_QTY_DISPLAY = business?.settings?.maxOrderQuantity || 20;
  const quantityPrompt = {
    type: 'text',
    body: `You've chosen *${item.name}* 👌${addOnText}\n\nHow many would you like? Please type a number (e.g. *2*) or a word (e.g. *five*). Maximum: *${MAX_QTY_DISPLAY}*.`,
  };

  if (imageUrl && showImage) {
    // Return array — flowEngine will dispatch both in order: image first, then buttons.
    // [FIX-IMG-URL] Apply WhatsApp delivery optimization (q_auto, f_auto, max w_1600)
    // before sending. The stored URL may have no transformation segment; this adds one.
    const whatsappImageUrl = buildWhatsAppImageUrl(imageUrl);
    return [
      {
        type:    'image',
        url:     whatsappImageUrl,
        caption: item.description
          ? `*${item.name}*\n${item.description}${item.price ? `\n💰 ${business?.payment?.currency || 'D'}${item.price}` : ''}`
          : `*${item.name}*${item.price ? ` — ${business?.payment?.currency || 'D'}${item.price}` : ''}`,
      },
      quantityPrompt,
    ];
  }

  return quantityPrompt;
}

// ── Restaurant Question Handler ───────────────────────────────────────────────
/**
 * handleRestaurantQuestion
 * Handles the QUESTION button and keyword-triggered FAQ intent for restaurant mode.
 * Uses AI to answer menu, hours, allergen, or general queries.
 */
export async function handleRestaurantQuestion({ session, message, business, tenant }) {
  const raw = String(message || '').trim();

  if (!raw || raw.length < 2) {
    return {
      type: 'buttons',
      body: '❓ What would you like to know? Ask about our menu, hours, allergens, or anything else!',
      buttons: [
        { id: 'ORDER',     title: '🍔 Order Food'  },
        { id: 'VIEW_MENU', title: '📋 View Menu'   }, // [AUDIT-FIX-VIEWMENU] was SHOW_MENU
      ],
    };
  }

  const aiReply = await getAIReply({
    customerMessage: raw,
    business,
    session,
    intent: 'FAQ',
  });

  // [FIX-Q-COMPLETE] completeFlow() clears the session. Previously it was called BEFORE
  // building the return value and `if (_lcRrq) return _lcRrq` meant a lead-capture response
  // REPLACED the AI answer. Fix: call completeFlow AFTER assembling the response and discard
  // its return — the AI answer is the complete response for the QUESTION flow.
  await completeFlow(session, 'QUESTION', business, tenant).catch(() => {});

  return {
    type: 'buttons',
    body: aiReply || "Great question! Please contact us directly and we'll be happy to help.",
    buttons: [
      { id: 'ORDER',    title: '🍔 Order Food'   },
      { id: 'BOOK',     title: '📅 Book a Table' },
      { id: 'QUESTION', title: '❓ Ask Another'  },
    ],
  };
}
