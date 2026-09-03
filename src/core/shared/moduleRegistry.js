/**
 * core/shared/moduleRegistry.js
 *
 * Called once at app startup. Registers every business module's
 * flows and action handlers with flowEngine and moduleRouter.
 *
 * Adding a new module = import + call registerModule() here. Nothing else.
 */

import { registerFlow, registerGenericFlow } from '../conversations/flowEngine.js';
import { registerAction }                    from '../conversations/moduleRouter.js';
import logger                                from '../../config/logger.js';
// [FIX-CATALOG-GATE] Static import — these are two pure, synchronous,
// zero-I/O boolean checks (see waCatalogConfig.js) with no dependencies of
// their own. Importing them statically means the START_ORDER handler below
// can decide "does WA Catalog even apply to this tenant?" without touching
// import() at all for the common case, so there is no dynamic-import
// indirection anywhere on the path a non-catalog tenant's "Order Food" tap
// takes — that path is now the exact same shape it was before WA Catalog
// existed: one direct call to startFlow('ORDER').
import { isCatalogEnabled, hasSellableProducts } from '../../modules/catalog/waCatalogConfig.js';

// [FIX-QSTART-MSG] Shared QUESTION-action logic, factored out so any other
// action can delegate to it as a fallback (see startFlowOrAnswerQuestion
// below) instead of duplicating this same mode-check + typed-message-
// forwarding + generic-AI-fallback logic at every call site.
async function handleQuestionAction({ session, message, business, tenant, isInteractive }) {
  const { startFlow }  = await import('../conversations/flowEngine.js');
  const { updateSession } = await import('../sessions/sessionService.js');
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  // Modes with dedicated QUESTION flows registered in this registry
  const QUESTION_FLOW_MODES = new Set([
    'RESTAURANT', 'SALON', 'BARBERSHOP', 'ELECTRONICS', 'SERVICES', 'GENERAL',
  ]);
  // A fresh tap (button/list reply) has no real question yet — its `message`
  // is just the button id ('QUESTION') itself. Anything else reaching this
  // action is the customer's own typed words and should be forwarded.
  const isFreshTap = isInteractive || String(message || '').trim().toUpperCase() === 'QUESTION';
  const typedQuestion = isFreshTap ? null : message;
  if (QUESTION_FLOW_MODES.has(mode)) {
    return startFlow({ flowName: 'QUESTION', session, business, tenant, message: typedQuestion });
  }
  // No mode-specific QUESTION flow — use the generic AI question handler.
  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'ENQUIRY', step: 'AWAITING_QUESTION',
  });
  if (typedQuestion) {
    // Answer the real question right now instead of waiting for the next
    // message — mirrors the AWAITING_QUESTION handling webhookController
    // runs for the *following* message, so the first one isn't wasted.
    const { processQuestionMessage, persistQuestionSession } = await import('../../services/question/questionAnswerService.js');
    const reply = await processQuestionMessage({ session, message: typedQuestion, business, tenant, intent: 'FAQ' });
    await persistQuestionSession(session, tenant, reply.context || { lastMessage: typedQuestion });
    return { type: reply.type, body: reply.body };
  }
  return {
    type: 'text',
    body: '❓ What would you like to know? Type your question below.',
  };
}

// [FIX-STARTFLOW-FALLBACK] Root cause: several flows are only registered for
// the specific business mode(s) they make sense for (WARRANTY/SPEC_REQUEST
// → ELECTRONICS, CAKE_CUSTOMIZATION → BAKERY, SKINCARE_ADVICE → COSMETICS,
// WALKIN → SALON/BARBERSHOP, ENQUIRY → SERVICES/GENERAL) — but the intents
// that trigger their actions are NOT mode-gated. intentEngine.js's
// deterministic exact-keyword-match step (and its Levenshtein fuzzy-match
// step) run the same global INTENT_PATTERNS list regardless of the tenant's
// businessMode, and RECOMMENDATION/SIZE_GUIDE/PRODUCT_INQUIRY/
// COMPATIBILITY_CHECK all map to the ENQUIRY action for every mode too. So a
// RETAIL customer typing "birthday cake", or an ELECTRONICS customer asking
// "does this work with my phone" (COMPATIBILITY_CHECK → ENQUIRY, only
// registered for SERVICES/GENERAL), previously hit startFlow()'s "no
// handler" branch and got a flat "⚠️ This option is not available" dead end
// instead of any answer — for words that look exactly like an ordinary
// question to the customer.
//
// Fix: check hasFlow() before starting; if this mode has no handler for the
// requested flow, fall back to the same Q&A path the QUESTION action itself
// uses (mode's own QUESTION flow, or the generic AI answer), forwarding the
// customer's real words so they still get answered instead of stonewalled.
async function startFlowOrAnswerQuestion({ flowName, session, message, business, tenant, isInteractive }) {
  const { startFlow, hasFlow } = await import('../conversations/flowEngine.js');
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  if (hasFlow(mode, flowName)) {
    return startFlow({ flowName, session, business, tenant });
  }
  logger.warn(`[ModuleRegistry] ${mode} has no ${flowName} flow — falling back to Q&A`, { flowName, mode });
  return handleQuestionAction({ session, message, business, tenant, isInteractive });
}

// [FEAT-NLU-BOOKING-PREFILL] Rewritten for PARTIAL, multi-entity extraction —
// previously this required party size, date, AND time to all resolve or it
// discarded the entire message (`return null` on any single miss), and party
// size only recognised digits ("table for 3"), not word numbers ("table for
// three people") even though the flow's own PARTY_SIZE step already accepts
// word numbers via parseQuantity(). Concretely, "hello I want to book a table
// for three people on the first of next month at 3 pm" used to extract
// NOTHING (party size: "three" isn't a digit; date: "the first of next
// month" didn't match the old date regex either) even though every field is
// unambiguously stated — the customer was asked all three questions again
// from scratch.
//
// Now returns whatever subset of {partySize, date, parsedDate, dateRaw, time}
// it can confidently resolve, independently per field, instead of all-or-
// nothing — callers (see the START_BOOKING action registration below and
// bookingFlow.js's INIT branch) pre-fill whatever was found and only ask for
// what's still missing.
// Exported (in addition to being used internally by the START_BOOKING action
// below) so it can be unit-tested directly with real inputs/outputs rather
// than only via source-text pattern matching — it has no DB dependency of its
// own (both dynamic imports inside it — parseQuantity.js, bookingDateParser.js
// — are pure, no-mongoose modules), so it's safe and cheap to call in tests.
export async function parseDirectBookingRequest(message, business) {
  const raw = String(message || '').trim();
  if (raw.length < 4) return null;

  const result = {};

  // ── Party size — digit OR word number, near "table/party/booking for" or
  // trailing "N people/guests/persons/pax/of us". Isolating the numeric token
  // first, then handing ONLY that token to parseQuantity(), is what lets word
  // numbers work here — parseQuantity("three people") itself returns null
  // (it has no digit to fall back on), but parseQuantity("three") is 3.
  //
  // [AUDIT-FIX-BOOKING-ARTICLE-1] "a"/"an" are ALSO plain grammatical articles
  // ("a table for a friend's birthday", "a reservation for an anniversary
  // dinner", "a table for a party of six"), so they must never resolve to a
  // bare party size of 1 unless a qualifier word unambiguously marks them as
  // a quantity. NUM_WORD_STRICT (no a/an) is used for the general pattern,
  // which has an OPTIONAL trailing qualifier — matching "a"/"an" there let
  // any unrelated noun phrase right after "for a"/"for an" silently produce
  // partySize:1, and (worse) let the regex stop at "a" instead of continuing
  // on to a real number later in the same sentence ("a party of six" matched
  // "a", never reaching "six"). "a"/"an" are only trusted when IMMEDIATELY
  // followed by an explicit singular/plural quantity qualifier (handled by
  // partyMatch2 below, whose qualifier list is mandatory, not optional).
  const NUM_WORD_STRICT = '(?:\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|couple|few|several)';
  const NUM_WORD = `(?:${NUM_WORD_STRICT}|a|an)`;
  const partyMatch =
    raw.match(new RegExp(`\\b(?:table|party|booking|reservation)\\s*(?:for|of)?\\s*(${NUM_WORD_STRICT})\\s*(?:people|persons|guests|pax)?\\b`, 'i')) ||
    raw.match(new RegExp(`\\bfor\\s+(${NUM_WORD})\\s+(?:people|persons|guests|pax|person|guest|of\\s+us)\\b`, 'i'));
  if (partyMatch) {
    const { parseQuantity } = await import('../nlu/resolution/parseQuantity.js');
    const partySize = parseQuantity(partyMatch[1]);
    // Sanity cap matches bookingFlow.js's own PARTY_SIZE step limit — an
    // implausible extraction (party of 90 from a garbled match) is dropped
    // rather than silently pre-filled, so the customer gets asked normally.
    if (partySize && partySize >= 1 && partySize <= 50) result.partySize = partySize;
  }

  // ── Date — try several candidate substrings against the SAME deterministic
  // resolver the DATE step itself uses (resolveBookingDateInput), instead of
  // a narrow whitelist regex that only recognised "today/tomorrow/next
  // <weekday>" or a full "<ordinal> of <month name>". This reuses one source
  // of truth for "what counts as a valid date" rather than maintaining a
  // second, weaker copy of it here.
  const dateCandidates = [
    // today / tomorrow / next <weekday>
    raw.match(/\btoday\b/i)?.[0],
    raw.match(/\btomorrow\b/i)?.[0],
    raw.match(/\bnext\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[0],
    raw.match(/\bthis\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[0],
    // "<ordinal> (day) of next/this month" — word "first" or digit ordinal
    raw.match(/\b(?:the\s+)?(?:first|1st|\d{1,2}(?:st|nd|rd|th)?)\s+(?:day\s+)?of\s+(?:next|this)\s+month\b/i)?.[0],
    // "<ordinal> of <month name>" / "<month name> <ordinal>", optional year
    raw.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?\b/i)?.[0],
    raw.match(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+\d{4})?\b/i)?.[0],
    // numeric date formats (dd/mm, dd-mm-yyyy, etc.)
    raw.match(/\b\d{1,2}[\/\-.]\d{1,2}(?:[\/\-.]\d{2,4})?\b/)?.[0],
  ].filter(Boolean);

  if (dateCandidates.length) {
    const { resolveBookingDateInput } = await import('../nlu/resolution/bookingDateParser.js');
    const tz = business?.hours?.timezone || 'UTC';
    for (const candidate of dateCandidates) {
      const resolved = await resolveBookingDateInput(candidate, tz).catch(() => null);
      if (resolved?.ok) {
        result.date = resolved.label;
        result.parsedDate = resolved.parsed;
        result.dateRaw = resolved.raw;
        break;
      }
    }
  }

  // ── Time — "3pm", "3:30 pm", "15:00".
  const timeMatch = raw.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i) || raw.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (timeMatch) result.time = timeMatch[0].replace(/\s+/g, ' ').trim();

  return Object.keys(result).length ? result : null;
}

function directOrderHandoff(mode, lines) {
  const cartModes = new Set(['RESTAURANT', 'BAKERY', 'COSMETICS', 'SALON', 'BARBERSHOP']);
  if (cartModes.has(mode)) {
    return { step: mode === 'RESTAURANT' ? 'CONFIRM' : 'CART_REVIEW', cart: lines };
  }

  const first = lines[0];
  const hasVariants = Array.isArray(first?.item?.variants) && first.item.variants.length > 0;
  switch (mode) {
    case 'RETAIL':
      return { step: hasVariants ? 'SELECT_VARIANT' : 'FULFILMENT', item: first.item, variant: first.variant || null, quantity: first.quantity };
    case 'DELIVERY':
      return { step: 'DELIVERY_ADDRESS', item: first.item, variant: first.variant || null, quantity: first.quantity };
    case 'ELECTRONICS':
      return { step: 'ITEM_DETAIL', item: first.item, variant: first.variant || null, quantity: first.quantity };
    case 'FASHION':
      return { step: hasVariants ? 'SELECT_SIZE' : 'QUANTITY', item: first.item, variant: first.variant || null, quantity: first.quantity };
    default:
      return null;
  }
}

export async function registerAllModules() {
  // ── Shared booking flow (all modules that book) ───────────────────────────
  const { handleBookingFlow } = await import('../conversations/bookingFlow.js');
  ['RESTAURANT','SALON','BARBERSHOP','BAKERY','COSMETICS','DELIVERY','SERVICES','GENERAL'].forEach(mode => {
    registerFlow(mode, 'BOOKING', handleBookingFlow);
  });
  registerGenericFlow('BOOKING', handleBookingFlow);

  // ── Restaurant ─────────────────────────────────────────────────────────────
  const { handleOrderFlow, handleRestaurantQuestion } = await import('../../modules/restaurant/flows/orderFlow.js');
  registerFlow('RESTAURANT', 'ORDER',     handleOrderFlow);
  registerFlow('RESTAURANT', 'QUESTION',  handleRestaurantQuestion);
  registerGenericFlow('ORDER', handleOrderFlow);

  // ── Retail (dedicated) ─────────────────────────────────────────────────────
  const { handleRetailOrder, handleProductQuery } = await import('../../modules/retail/flows/index.js');
  registerFlow('RETAIL', 'ORDER',         handleRetailOrder);
  registerFlow('RETAIL', 'PRODUCT_QUERY', handleProductQuery);

  // ── Delivery (dedicated) ───────────────────────────────────────────────────
  const { handleDeliveryOrder } = await import('../../modules/delivery/flows/index.js');
  registerFlow('DELIVERY', 'ORDER', handleDeliveryOrder);

  // ── Bakery ─────────────────────────────────────────────────────────────────
  const { handleBakeryOrder, handleBakeryBooking, handleCakeCustomization } = await import('../../modules/bakery/flows/index.js');
  registerFlow('BAKERY', 'ORDER',               handleBakeryOrder);
  registerFlow('BAKERY', 'BOOKING',             handleBakeryBooking);
  registerFlow('BAKERY', 'CAKE_CUSTOMIZATION',  handleCakeCustomization);

  // ── Salon / Barbershop (dedicated flows — not generic wrappers) ───────────
  const {
    handleSalonBooking,
    handleSalonWalkIn,
    handleSalonProductOrder,
    handleSalonQuestion,
  } = await import('../../modules/salon/flows/index.js');

  // Appointment booking (with stylist selection pre-step)
  registerFlow('SALON',      'BOOKING', handleSalonBooking);
  registerFlow('BARBERSHOP', 'BOOKING', handleSalonBooking);

  // Walk-in queue (salon/barbershop only — no date/time needed)
  registerFlow('SALON',      'WALKIN', handleSalonWalkIn);
  registerFlow('BARBERSHOP', 'WALKIN', handleSalonWalkIn);

  // Retail product sales
  registerFlow('SALON',      'ORDER', handleSalonProductOrder);
  registerFlow('BARBERSHOP', 'ORDER', handleSalonProductOrder);

  // AI question handler (aftercare, pricing, product advice)
  registerFlow('SALON',      'QUESTION', handleSalonQuestion);
  registerFlow('BARBERSHOP', 'QUESTION', handleSalonQuestion);

  // ── Fashion ────────────────────────────────────────────────────────────────
  const { handleFashionOrder } = await import('../../modules/fashion/flows/index.js');
  registerFlow('FASHION', 'ORDER', handleFashionOrder);

  // ── Cosmetics ──────────────────────────────────────────────────────────────
  const { handleCosmeticsOrder, handleCosmeticsBooking, handleSkincareAdvice } = await import('../../modules/cosmetics/flows/index.js');
  registerFlow('COSMETICS', 'ORDER',           handleCosmeticsOrder);
  registerFlow('COSMETICS', 'BOOKING',         handleCosmeticsBooking);
  registerFlow('COSMETICS', 'SKINCARE_ADVICE', handleSkincareAdvice);

  // ── Electronics ────────────────────────────────────────────────────────────
  const {
    handleElectronicsOrder,
    handleSpecRequest,
    handleCompare,
    handleWarranty,
  } = await import('../../modules/electronics/flows/index.js');

  registerFlow('ELECTRONICS', 'ORDER',        handleElectronicsOrder);
  registerFlow('ELECTRONICS', 'SPEC_REQUEST', handleSpecRequest);
  registerFlow('ELECTRONICS', 'COMPARE',      handleCompare);
  registerFlow('ELECTRONICS', 'WARRANTY',     handleWarranty);
  // [FIX-3] QUESTION taps in ELECTRONICS mode must reach handleSpecRequest.
  // Without this, the generic QUESTION action handler calls startFlow('QUESTION'),
  // finds no ELECTRONICS:QUESTION registration, and returns an error UI.
  // Electronics customers asking "❓ Ask a Question" should land in tech Q&A.
  registerFlow('ELECTRONICS', 'QUESTION',     handleSpecRequest);

  // ── Services (dedicated) ───────────────────────────────────────────────────
  const { handleEnquiryFlow, handleServicesBooking, handleQuoteFollowUp, handleServicesQuestion } = await import('../../modules/services/flows/index.js');
  registerFlow('SERVICES', 'ENQUIRY',      handleEnquiryFlow);
  registerFlow('SERVICES', 'BOOKING',      handleServicesBooking);
  registerFlow('SERVICES', 'QUOTE_FOLLOW', handleQuoteFollowUp);
  registerFlow('SERVICES', 'QUESTION',     handleServicesQuestion);

  // ── General (dedicated) ────────────────────────────────────────────────────
  const { handleGeneralQuestion, handleGeneralEnquiry, handleGeneralBooking, handleAbout } = await import('../../modules/general/flows/index.js');
  registerFlow('GENERAL', 'QUESTION', handleGeneralQuestion);
  registerFlow('GENERAL', 'ENQUIRY',  handleGeneralEnquiry);
  registerFlow('GENERAL', 'BOOKING',  handleGeneralBooking);
  registerFlow('GENERAL', 'ABOUT',    handleAbout);

  // ── Action handlers (module-registered) ───────────────────────────────────
  // [AUDIT-FIX-CATALOG-STARTORDER] modules/catalog/waCatalogFlow.js's
  // offerCatalogOnStartOrder() was fully implemented and its own header comment
  // documents it as "Called from the moduleRegistry.js START_ORDER action
  // override (see [CATALOG-REG-1] there)" — but no such override existed here.
  // Same "implemented but unwired" bug class as withCatalogWelcomeOption()
  // (see [AUDIT-FIX-CATALOG-WELCOME] in moduleRouter.js): WA-Catalog-enabled
  // tenants in AI_DECIDES/ALWAYS_OFFER mode could never actually have their
  // "🍔 Order Food" tap open with WA Catalog — it always silently went straight
  // to the module's own text/list menu, no matter how the tenant was configured.
  //
  // Immediate-display guarantee: shouldOfferCatalog() (called first, inside
  // offerCatalogOnStartOrder) short-circuits on `isCatalogEnabled(business) &&
  // hasSellableProducts(business)` — two synchronous field/array checks, zero
  // I/O, zero network calls. For any tenant without WA Catalog enabled (the
  // default for every tenant that hasn't explicitly opted in), this resolves
  // instantly and falls straight through to the exact same
  // startFlow({ flowName: 'ORDER' }) call that ran here before — View Menu
  // still displays immediately, with no added delay and no risk of silence.
  // Only WA-Catalog-enabled tenants take the (documented, already-guarded)
  // sendAndArmCatalog() network path, and any failure there still falls back
  // to startFlow('ORDER') below rather than leaving the customer with no reply.
  // [FIX-CATALOG-GATE] Two explicit, separately-readable paths, exactly as
  // requested — not one path with a conditional buried inside it:
  //
  //   PATH A — tenant has no WA Catalog configured (the default, and every
  //   tenant that existed before this integration): checked synchronously,
  //   with the two pure functions imported at the top of this file, zero
  //   dynamic import, zero await, zero network call, zero dependency on
  //   waCatalogFlow.js loading correctly. Goes STRAIGHT to
  //   startFlow({ flowName: 'ORDER' }) — the identical single call this
  //   codebase made before WA Catalog existed. "View Menu" cannot be
  //   silently eaten by anything catalog-related on this path, because
  //   nothing catalog-related runs on this path at all.
  //
  //   PATH B — tenant HAS WA Catalog enabled and configured with sellable
  //   products: only then do we load waCatalogFlow.js and run the
  //   AI/mode-based offer decision. Any failure there (bad catalogId, Graph
  //   API error, thrown exception) still falls back to the exact same
  //   startFlow('ORDER') call PATH A uses — WA Catalog can never become a
  //   dead end for a customer, even for tenants who opted into it.
  registerAction('START_ORDER', async ({ session, message, business, tenant, intent }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    const { advance } = await import('../conversations/flowEngine.js');
    const { updateSession } = await import('../sessions/sessionService.js');
    const normalizedIntent = intent === 'START_ORDER' ? 'ORDER' : (intent || 'ORDER');
    const msgUpper = String(message || '').trim().toUpperCase();
    const explicitOrderTap = msgUpper === 'ORDER' || msgUpper === 'NEW_ORDER';

    // [CATALOG-FIRST] A generic browsing-intent message — "I want to order",
    // "I want food", "I want to see your menu", "show me the menu", etc. —
    // carries no actual product name, only navigational filler. Previously
    // this was only detected AFTER running it through the fuzzy product
    // parser below (parseMultiItemMessage / parseNaturalOrderMessage), which
    // matches on substrings — a generic word like "food" can accidentally
    // substring-match a real menu item name (e.g. "Seafood Platter") and get
    // treated as a specific product request (single match → silently added
    // to cart, or multiple matches → "which one would you like?"), so the
    // catalog would never even be considered for that message. Detecting a
    // pure generic-intent message FIRST, before any NLU/fuzzy matching runs,
    // guarantees these phrases always go straight to the catalog/menu
    // decision below — nothing else can ever come first for them.
    const directOrderTextEarly = String(message || '').trim();
    const directProductTextEarly = directOrderTextEarly
      .replace(/^(?:hi|hello|hey)[,\s]+/i, '')
      .replace(/^(?:i\s+)?(?:want|need|would\s+like|like\s+to\s+order)\s+(?:to\s+order\s+)?/i, '')
      .replace(/^(?:can\s+i\s+)?(?:give|get|have|order|buy|purchase)\s+(?:me\s+)?/i, '')
      .replace(/^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:plates?\s+of\s+)?/i, '')
      .replace(/[?!.]+$/, '')
      .trim();
    const FILLER_ONLY_RE = /^(?:to|the|your|our|see|view|show|browse|order|get|find|for|a|an|of|me|please|food|menu|menus|catalog|catalogue|catalogs|products?|options?|item|items)(?:\s+(?:to|the|your|our|see|view|show|browse|order|get|find|for|a|an|of|me|please|food|menu|menus|catalog|catalogue|catalogs|products?|options?|item|items))*$/i;
    const isGenericBrowseIntent = !session?.data?._nluPending?.products?.length
      && (directProductTextEarly.length === 0 || FILLER_ONLY_RE.test(directProductTextEarly));

    if (isGenericBrowseIntent) {
      const catalogReadyEarly = isCatalogEnabled(business) && hasSellableProducts(business);
      if (!catalogReadyEarly) {
        return startFlow({ flowName: 'ORDER', session: { ...session, orderChannel: 'menu' }, business, tenant });
      }
      const { browseCatalogExplicit, offerCatalogOnStartOrder } = await import('../../modules/catalog/waCatalogFlow.js');
      if (session?.orderChannel === 'catalog' || explicitOrderTap) {
        return browseCatalogExplicit({ session, business, tenant });
      }
      const { offered } = await offerCatalogOnStartOrder({ session, business, tenant, intent: normalizedIntent }).catch(() => ({ offered: false }));
      if (offered) return null; // WA Catalog message already dispatched directly — nothing further to send
      return startFlow({ flowName: 'ORDER', session: { ...session, orderChannel: 'menu' }, business, tenant });
    }

    // [ENHANCED-NLU] Pre-seed cart when AI extracted matched products (HIGH-confidence only).
    // A complete product request must bypass the catalog/menu and go directly
    // to the existing cart review step (e.g. "two plates of Benachin").
    // The catalog remains the path for an incomplete request such as "I want
    // to order".
    let orderSession = session;
    const nluProducts = session?.data?._nluPending?.products;
    const { mergeCartLines, applyCartModification } = await import('../shared/cartEngine.js');
    const { parseMultiItemMessage, parseNaturalOrderMessage, parseCartModification } = await import('../nlu/resolution/cartMessageParser.js');
    const menu = (business?.menuItems || []).filter(item => item.available !== false);
    const existingCart = Array.isArray(session?.data?.cart) ? session.data.cart : [];
    const cartModification = existingCart.length
      ? parseCartModification(existingCart, message)
      : null;
    if (cartModification) {
      const updatedCart = applyCartModification(existingCart, cartModification);
      const updatedData = { ...(session.data || {}), cart: updatedCart, _nluPending: null };
      const updated = await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER', step: 'CONFIRM', data: updatedData, orderChannel: 'menu', menuViewed: true,
      });
      return advance({
        session: { ...session, ...updated, currentFlow: 'ORDER', step: 'CONFIRM', data: updatedData, orderChannel: 'menu' },
        message: null, business, tenant,
      });
    }
    const parsedDirect = parseMultiItemMessage(menu, message) || parseNaturalOrderMessage(menu, message);
    if (parsedDirect?.ambiguous && parsedDirect.candidates?.length) {
      const pendingData = {
        ...(session.data || {}),
        pendingNaturalQuantity: parsedDirect.quantity,
        _nluPending: null,
      };
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER', step: 'SELECT_ITEM', data: pendingData, menuViewed: true,
      });
      return {
        type: 'buttons',
        body: `Which one would you like?\n\n${parsedDirect.candidates.map(item => `• *${item.name}*`).join('\n')}`,
        buttons: parsedDirect.candidates.slice(0, 3).map(item => ({ id: item.name, title: item.name.slice(0, 20) })),
      };
    }
    const lines = Array.isArray(nluProducts) && nluProducts.length > 0
      ? nluProducts
        .filter(p => p?.item)
        .map(p => ({ item: p.item, quantity: p.quantity || 1, variant: p.variant || null }))
      : (parsedDirect?.lines || []);
    if (lines.length > 0) {
      const mode = (business?.businessMode || 'RETAIL').toUpperCase();
      const handoff = directOrderHandoff(mode, lines);
      if (!handoff) {
        // [AUDIT-FIX-CATALOG-DIRECTORDER-GAP] This fallback used to call
        // startFlow('ORDER') unconditionally — the one order-start path in
        // this file that never checked catalog readiness first, unlike PATH
        // A/B below and every other case. A catalog-ready tenant whose
        // handoff shape wasn't recognised for this businessMode (handoff
        // null) would silently see the internal text/list menu instead of
        // WA Catalog, with no catalog offer at all. Now mirrors the same
        // catalogReady gate used everywhere else in this handler.
        const catalogReadyDirect = isCatalogEnabled(business) && hasSellableProducts(business);
        if (catalogReadyDirect) {
          const { browseCatalogExplicit } = await import('../../modules/catalog/waCatalogFlow.js');
          return browseCatalogExplicit({ session: orderSession, business, tenant });
        }
        return startFlow({ flowName: 'ORDER', session: { ...orderSession, orderChannel: 'menu' }, business, tenant });
      }
      const cart = mergeCartLines(existingCart, lines);
      const newData = handoff.cart
        ? { ...(session.data || {}), cart, _nluPending: null }
        : { ...(session.data || {}), ...handoff, _nluPending: null };
      const updated = await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER',
        step: handoff.step,
        data: newData,
        orderChannel: 'menu',
        menuViewed: true,
      });
      orderSession = { ...session, ...updated, data: newData, currentFlow: 'ORDER', step: handoff.step, orderChannel: 'menu' };
      return advance({ flowReply: null, session: orderSession, message: null, business, tenant });
    }

    // A product-bearing order request must never be converted into a browse
    // offer just because live resolution missed. Keep the browse path for an
    // incomplete request such as "I want to order", but explain a genuine miss
    // and let the customer correct the product name or explicitly browse.
    const directOrderText = String(message || '').trim();
    const directProductText = directOrderText
      .replace(/^(?:hi|hello|hey)[,\s]+/i, '')
      .replace(/^(?:i\s+)?(?:want|need|would\s+like|like\s+to\s+order)\s+(?:to\s+order\s+)?/i, '')
      .replace(/^(?:can\s+i\s+)?(?:give|get|have|order|buy|purchase)\s+(?:me\s+)?/i, '')
      .replace(/^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:plates?\s+of\s+)?/i, '')
      .replace(/[?!.]+$/, '')
      .trim();
    // [FIX-GENERIC-LEFTOVER] The strip-regex above only removes ONE lead-in
    // phrase, so a message like "I want to order" (no trailing product) or
    // "I want to see the menu" leaves navigational filler ("to order", "to
    // see the menu", "food", "menu") behind as if it were the product name
    // the customer typed — and this block would then tell them "I couldn't
    // find *to order*", which is nonsensical and was exactly what images
    // 2-4 showed. A leftover made up ENTIRELY of filler words (no real
    // content word survives) means the request was genuinely incomplete —
    // that's the case this whole block's own comment already says should
    // fall through to the catalog/menu, not report a fake miss.
    const isFillerOnlyLeftover = /^(?:to|the|your|our|see|view|show|browse|order|get|find|for|a|an|of|me|please|food|menu|menus|catalog|catalogue|catalogs|products?|options?|item|items)(?:\s+(?:to|the|your|our|see|view|show|browse|order|get|find|for|a|an|of|me|please|food|menu|menus|catalog|catalogue|catalogs|products?|options?|item|items))*$/i
      .test(directProductText);
    // PATH A — no WA Catalog for this tenant. Old-version behavior, verbatim.
    const catalogReady = isCatalogEnabled(business) && hasSellableProducts(business);

    if (directProductText.length >= 3 && !explicitOrderTap && !isFillerOnlyLeftover) {
      // [CATALOG-FIRST-ON-MISS] A named-but-unmatched product ("Domoda",
      // "denachin") used to show ONLY this text with a "Browse Catalog"
      // BUTTON — the catalog itself never appeared until the customer spent
      // a second tap on that button (this is exactly what images 1-3 showed:
      // the catalog only shows up after "Browse Catalog" is tapped, not on
      // the original order-intent message). Per the same "must always
      // trigger, not optional" requirement already applied to generic browse
      // phrases, a product-name miss is still an order-intent message, so
      // the catalog must be sent immediately here too — the explanatory text
      // stays (it's still useful: it tells the customer their spelling/name
      // didn't match), but the customer no longer has to tap anything to see
      // products. Catalog is sent FIRST, exactly as with the generic-intent
      // case, then this text follows as a second message.
      if (catalogReady) {
        const { browseCatalogExplicit } = await import('../../modules/catalog/waCatalogFlow.js');
        const fallback = await browseCatalogExplicit({ session: orderSession, business, tenant }).catch(() => null);
        if (fallback) {
          // Every retry failed and browseCatalogExplicit already fell back to
          // the real text/list ORDER menu — that IS the "here's what we have"
          // answer, so send it instead of a redundant "couldn't find" notice.
          return fallback;
        }
        // Catalog was dispatched successfully as its own message — follow up
        // with the explanation, minus the now-redundant "Browse Catalog"
        // button (the catalog is already on-screen above this message).
        return {
          type: 'buttons',
          body: `I couldn't find *${directProductText.slice(0, 50)}* in our current products — take a look at the catalog above, or check the spelling and try again.`,
          buttons: [
            { id: 'CANCEL', title: '❌ Cancel' },
          ],
        };
      }
      return {
        type: 'buttons',
        body: `I couldn't find *${directProductText.slice(0, 50)}* in our current products. Please check the name and try again, or browse the catalog.`,
        buttons: [
          { id: 'BROWSE_CATALOG', title: '🛍 Browse Catalog' },
          { id: 'CANCEL', title: '❌ Cancel' },
        ],
      };
    }

    if (!catalogReady) {
      return startFlow({ flowName: 'ORDER', session: { ...orderSession, orderChannel: 'menu' }, business, tenant });
    }

    // [ORDER-CHANNEL] Customer chose Browse Catalog earlier — keep them on catalog
    // for every subsequent "New Order" / ORDER tap (including MANUAL_ONLY tenants).
    if (orderSession?.orderChannel === 'catalog' || explicitOrderTap) {
      const { browseCatalogExplicit } = await import('../../modules/catalog/waCatalogFlow.js');
      return browseCatalogExplicit({ session: orderSession, business, tenant });
    }

    // PATH B — WA Catalog is actually configured for this tenant.
    const { offerCatalogOnStartOrder } = await import('../../modules/catalog/waCatalogFlow.js');
    const { offered } = await offerCatalogOnStartOrder({ session: orderSession, business, tenant, intent: normalizedIntent }).catch(() => ({ offered: false }));
    if (offered) return null; // WA Catalog message already dispatched directly — nothing further to send
    return startFlow({ flowName: 'ORDER', session: { ...orderSession, orderChannel: 'menu' }, business, tenant });
  });

  registerAction('START_BOOKING', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    const { advance } = await import('../conversations/flowEngine.js');
    // [AUDIT-FIX-BOOKING-UPDATESESSION] updateSession was called here but never
    // imported in this action handler's closure (it's imported inside the
    // separate START_ORDER handler above, which doesn't help this one) —
    // every direct-booking request for a service-less business threw
    // "updateSession is not defined" instead of confirming the booking.
    const { updateSession } = await import('../sessions/sessionService.js');
    // [FEAT-NLU-BOOKING-PREFILL] parseDirectBookingRequest() now returns
    // PARTIAL matches (whatever of partySize/date/time it could resolve, not
    // all-or-nothing — see that function's comment). We can no longer jump
    // straight to the all-fields-confirmed step just because `directBooking`
    // is truthy, since it might only contain one field. Instead: merge
    // whatever was found into `data` and hand off to the flow with step:null
    // so its own INIT branch (message === null) — which now checks for pre-filled
    // data via _resumeFromPrefill() — decides where to actually land: skips
    // any step whose answer is already known, and only asks for what's
    // genuinely still missing. startFlow() can't be reused here because it
    // unconditionally resets `data` to {} on every call, which would wipe out
    // the very fields we just extracted.
    // [AUDIT-FIX-BOOKING-SERVICES-PREFILL] This used to be gated behind
    // `!(business?.services || []).length` — i.e. prefill only ever applied
    // to booking-capable businesses with NO services list configured
    // (plain restaurants). Any SALON/BARBERSHOP/SERVICES/GENERAL tenant that
    // configures a services list (the common case for those modes) fell
    // straight to the plain startFlow() call below, which unconditionally
    // resets `data` to {} — so a message like "book a haircut on the 15th
    // at 3pm" silently discarded the date and time it had just extracted,
    // for the majority of booking-capable business types. bookingFlow.js's
    // SELECT_SERVICE case now itself checks for pre-filled date/time once a
    // service is chosen (see its [AUDIT-FIX-BOOKING-SERVICES-PREFILL] note),
    // so merging here is safe regardless of whether services are configured
    // — the flow's own INIT/SELECT_SERVICE branches decide what's still
    // missing either way.
    const directBooking = await parseDirectBookingRequest(message, business).catch(() => null);
    if (directBooking) {
      const mergedData = { ...(session.data || {}), ...directBooking };
      const updated = await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'BOOKING',
        step: null,
        data: mergedData,
      });
      return advance({
        session: { ...session, ...updated, currentFlow: 'BOOKING', step: null, data: mergedData },
        message: null,
        business,
        tenant,
      });
    }
    return startFlow({ flowName: 'BOOKING', session, business, tenant });
  });

  // WALKIN action — salon/barbershop walk-in queue (no date/time needed).
  // [FIX-STARTFLOW-FALLBACK] 'walk in' / 'queue' / "i'm here" etc. are exact
  // INTENT_PATTERNS keywords with no mode gating (see intentEngine.js step 4),
  // so any tenant's customer can type one of these — not just SALON/
  // BARBERSHOP, the only modes WALKIN is actually registered for. Route
  // through the shared fallback so an unrelated mode gets a real Q&A answer
  // instead of "⚠️ This option is not available".
  registerAction('WALKIN', ({ session, message, business, tenant, isInteractive }) =>
    startFlowOrAnswerQuestion({ flowName: 'WALKIN', session, message, business, tenant, isInteractive }));

  // [FIX-STARTFLOW-FALLBACK] Same gap: CAKE_CUSTOMIZATION is BAKERY-only, but
  // its keywords ('birthday cake', 'custom cake', ...) match for any mode.
  registerAction('CAKE_CUSTOMIZATION', ({ session, message, business, tenant, isInteractive }) =>
    startFlowOrAnswerQuestion({ flowName: 'CAKE_CUSTOMIZATION', session, message, business, tenant, isInteractive }));

  // [FIX-STARTFLOW-FALLBACK] Same gap: SKINCARE_ADVICE is COSMETICS-only, but
  // its keywords ('dry skin', 'oily skin', 'acne', ...) match for any mode.
  registerAction('SKINCARE_ADVICE', ({ session, message, business, tenant, isInteractive }) =>
    startFlowOrAnswerQuestion({ flowName: 'SKINCARE_ADVICE', session, message, business, tenant, isInteractive }));

  // [FIX-F] SPEC_REQUEST action was never registered — unknown action fell through to
  // a generic fallback. Now starts the SPEC_REQUEST flow registered on ELECTRONICS.
  // [FIX-STARTFLOW-FALLBACK] The comment above previously claimed non-electronics
  // modes "fall back gracefully" — they didn't; startFlow() had no such fallback
  // and returned the flat "not available" dead end. SPEC_REQUEST's keywords
  // ('specs', 'features', 'battery', 'tell me about', ...) aren't mode-gated
  // either, so this now genuinely falls back via the shared helper.
  registerAction('SPEC_REQUEST', ({ session, message, business, tenant, isInteractive }) =>
    startFlowOrAnswerQuestion({ flowName: 'SPEC_REQUEST', session, message, business, tenant, isInteractive }));

  // COMPARE — side-by-side product comparison (Electronics only).
  // Button id: 'COMPARE' on welcome screen and fallback buttons — unlike the
  // actions above, COMPARE has no free-text keyword trigger (see patterns.js),
  // so it's only ever reachable from the ELECTRONICS-only button that shows
  // it. No cross-mode fallback needed.
  registerAction('COMPARE', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'COMPARE', session, business, tenant });
  });

  // WARRANTY — warranty + after-sales enquiry (Electronics only).
  // Can be triggered by typing "warranty", "repair", "return" etc., or future button.
  // [FIX-STARTFLOW-FALLBACK] Those same keywords aren't mode-gated — falls back
  // via the shared helper for any non-ELECTRONICS tenant.
  registerAction('WARRANTY', ({ session, message, business, tenant, isInteractive }) =>
    startFlowOrAnswerQuestion({ flowName: 'WARRANTY', session, message, business, tenant, isInteractive }));

  // [FIX-STARTFLOW-FALLBACK] ENQUIRY is only registered for SERVICES/GENERAL,
  // but RECOMMENDATION (RESTAURANT/COSMETICS), SIZE_GUIDE/PRODUCT_INQUIRY
  // (FASHION), and COMPATIBILITY_CHECK (ELECTRONICS) all map to the ENQUIRY
  // action too (see intentEngine.js intentToAction map) — so a customer in
  // any of those modes asking a perfectly ordinary question ("what would you
  // recommend", "does this work with my phone") previously hit the flat
  // "not available" dead end instead of an answer.
  registerAction('ENQUIRY', ({ session, message, business, tenant, isInteractive }) =>
    startFlowOrAnswerQuestion({ flowName: 'ENQUIRY', session, message, business, tenant, isInteractive }));

  // [FIX-3] QUESTION action — routes the QUESTION button tap to the mode-specific
  // QUESTION flow (SERVICES: handleServicesQuestion, GENERAL: handleGeneralQuestion,
  // RESTAURANT: handleRestaurantQuestion, SALON/BARBERSHOP: handleSalonQuestion,
  // ELECTRONICS: handleSpecRequest).
  // Previously QUESTION intent mapped to ENQUIRY action which was intercepted by the
  // webhookController inline shortcut, bypassing ACTION_REGISTRY entirely. QUESTION
  // is now in FLOW_PASSTHROUGH_IDS so it reaches route() → ACTION_REGISTRY → here.
  // [FIX-QUESTION-FALLBACK] For modes without a dedicated QUESTION flow registered
  // (BAKERY, COSMETICS, RETAIL, DELIVERY, FASHION), startFlow('QUESTION') previously
  // returned "⚠️ This option is not available right now." — a broken UX for any
  // customer tapping "❓ Ask a Question" in those modes. The fix: check whether a
  // mode-specific QUESTION flow exists FIRST; if not, fall back to the generic ENQUIRY
  // flow (sets currentFlow=ENQUIRY / step=AWAITING_QUESTION → AI answers the question).
  // [FIX-QSTART-MSG] Root cause of the "still going in circles" bug: startFlow()
  // used to unconditionally call the flow handler with message: null. That's
  // correct for a genuine "❓ Ask a Question" / "❓ Ask Another" BUTTON tap —
  // there's no real question yet, so the handler should show its first-step
  // "what would you like to know?" prompt. But intent detection also routes
  // typed free text like "i want to know the prices of your food items" to this
  // same QUESTION action (see intentEngine.js QUESTION → 'QUESTION' mapping) —
  // and that real, already-asked question was being thrown away and replaced
  // with the canned prompt every single time, so the customer just got the
  // same "What would you like to know?" reply back and looped forever.
  // Fix: use `isInteractive` (true only for an actual button/list tap) to tell
  // the two cases apart, and forward the customer's real text through so it
  // gets answered on this very turn instead of discarded.
  registerAction('QUESTION', handleQuestionAction);

  registerAction('QUOTE_FOLLOW', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'QUOTE_FOLLOW', session, business, tenant });
  });

  // [FIX-8] ABOUT action — delegates directly to the mode handler via route()'s
  // ACTION_REGISTRY. moduleRouter's ABOUT case already checks ACTION_REGISTRY first,
  // so registering here is correct. We call startFlow only for GENERAL (which has a
  // registered GENERAL:ABOUT flow). For all other modes the moduleRouter fallback
  // inline ABOUT response runs. Removed the blanket startFlow('ABOUT') wrapper that
  // created a spurious currentFlow write-then-immediate-clear on every ABOUT view.
  registerAction('ABOUT', async ({ session, message, business, tenant, intent, isInteractive, suggestion }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    const mode = (business?.businessMode || 'RETAIL').toUpperCase();
    if (mode === 'GENERAL') {
      return startFlow({ flowName: 'ABOUT', session, business, tenant });
    }
    // For non-GENERAL modes, return null so moduleRouter's inline ABOUT handler runs.
    return null;
  });

  registerAction('PRODUCT_QUERY', async ({ session, message, business, tenant }) => {
    const { startFlow } = await import('../conversations/flowEngine.js');
    return startFlow({ flowName: 'PRODUCT_QUERY', session, business, tenant });
  });

  registerAction('REPEAT_ORDER', async ({ session, message, business, tenant }) => {
    const { getLastOrderItem } = await import('../../services/order/orderService.js');
    const { startFlow }        = await import('../conversations/flowEngine.js');
    const { updateSession }    = await import('../sessions/sessionService.js');

    const lastItem = await getLastOrderItem(session.customerPhone, session.tenantId).catch(() => null);
    if (lastItem) {
      // [AUDIT-FIX-REPEAT-1] getLastOrderItem() only ever returns the stored item
      // NAME (Order.item is a plain string) — writing that straight into session
      // data as { name: lastItem } gave the QUANTITY step no price to work with,
      // silently totalling D0 and, since totalPrice:0 also skips the payment
      // step, quietly treated every repeat order as a free cash order with no
      // admin payment-verification prompt. Re-resolve the full menu item (with
      // price/image/etc.) from the current menu by name, falling back to the
      // name-only stub — with an explicit price-uncertainty notice — only when
      // the item can no longer be found (e.g. it was removed from the menu).
      const fullItem = (business?.menuItems || []).find(
        mi => (mi.name || '').toLowerCase() === lastItem.toLowerCase()
      ) || null;

      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER', step: 'QUANTITY',
        data: { item: fullItem || { name: lastItem } }, menuViewed: true,
      });
      const priceNotice = !fullItem
        ? `\n\n⚠️ We couldn't confirm the current price for this item — we'll follow up with the exact total before your order is finalised.`
        : '';
      return {
        type: 'buttons',
        body: `🔁 *Repeat your last order*\n\nYou previously ordered *${lastItem}*.${priceNotice}\n\nHow many would you like this time?\n\n_(Enter a number or word — e.g. *1*, *2*, *three*)_`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }
    return startFlow({ flowName: 'ORDER', session, business, tenant });
  });

  registerAction('TRACK_ORDER', async ({ session, business, message }) => {
    const { buildStatusReply } = await import('../../services/activity/activityStatusService.js');
    return buildStatusReply({ session, business, message });
  });

  logger.info('[Registry] All modules registered ✓');
}

