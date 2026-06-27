/**
 * core/intents/patterns.js
 *
 * Single source of truth for all intent keywords, button IDs and emoji shortcuts.
 * Edit here to add new phrases — no other files need changing.
 */

// ── Button ID → Action map ────────────────────────────────────────────────────
// Every interactive button sent to customers must have its ID registered here.
// [FIX-BTN-1] ABOUT and QUOTE_FOLLOW were missing — see inline comment below.
export const BUTTON_ID_MAP = {
  // Primary actions
  'ORDER':              'START_ORDER',
  'BOOK':               'START_BOOKING',
  // [FIX-BTN-Q] QUESTION must map to 'QUESTION' not 'ENQUIRY'. Previously this
  // caused the QUESTION button tap to become action='ENQUIRY' which was intercepted
  // by the webhookController inline handler before route() was ever called —
  // SERVICES and GENERAL mode's dedicated QUESTION flows (registered via ACTION_REGISTRY)
  // were therefore unreachable from any top-level QUESTION button tap.
  'QUESTION':           'QUESTION',
  'SUPPORT':            'SUPPORT',
  'SHOW_MENU':          'SHOW_MENU',
  'VIEW_MENU':          'SHOW_MENU',

  // Flow control
  'CONFIRM':            'CONFIRM',
  'CANCEL':             'CANCEL',
  // [FIX-1] CANCEL_ORDER was missing from this map. Without it, detectIntent() received
  // an unmapped interactive ID at step 1 and returned CONTINUE_FLOW — routing to the
  // welcome menu instead of the cancel handler. Same target as CANCEL_BOOKING.
  'CANCEL_ORDER':       'CANCEL',
  // [FIX-CANCEL-BOOKING] CANCEL_BOOKING must route to its own action so moduleRouter
  // can cancel the Booking DB record. Previously mapped to 'CANCEL' which only called
  // cancelFlow() — clearing session state without touching the Booking document.
  'CANCEL_BOOKING':     'CANCEL_BOOKING',
  // [FIX-CANCEL-ALL] CANCEL_ALL button ID for bulk-cancellation of multiple orders.
  // Shown in the MULTIPLE_ACTIVE_ORDERS context; routes to the CANCEL_ALL handler
  // in webhookController which cancels all pending/confirmed orders for the customer.
  'CANCEL_ALL':         'CANCEL_ALL',
  'DATE_BACK':          'DATE_BACK',
  'TIME_BACK':          'TIME_BACK',

  // Upsell
  'UPSELL_YES':         'UPSELL_YES',
  'UPSELL_NO':          'UPSELL_NO',

  // Switch flow
  'SWITCH_YES':         'SWITCH_YES',
  'SWITCH_NO':          'SWITCH_NO',

  // Post-flow
  'REPEAT_ORDER':       'REPEAT_ORDER',
  'TRACK_ORDER':        'TRACK_ORDER',
  'TRACK':              'TRACK_ORDER',
  // [FIX-BTN-1] ABOUT and QUOTE_FOLLOW are sent as button IDs to customers
  // (GENERAL module welcome screen; SERVICES module welcome screen). Without
  // entries here, detectIntent() receives an unmapped interactive ID at step 1
  // and returns CONTINUE_FLOW, which routes to the welcome menu — completely
  // ignoring the customer's tap. Now correctly mapped to their action names.
  'ABOUT':              'ABOUT',
  'QUOTE_FOLLOW':       'QUOTE_FOLLOW',
  'NEW_ORDER':          'START_ORDER',

  // Enquiry (Send an Enquiry button on GENERAL/SERVICES welcome screens)
  // [FIX-BTN-E] 'ENQUIRY' was missing — without it, detectIntent() returned CONTINUE_FLOW
  // for any tap on "📬 Send an Enquiry" / "📋 Get a Quote" buttons, routing the customer
  // to the welcome menu instead of the enquiry/quote flow. Now maps to 'ENQUIRY' so
  // moduleRouter's ENQUIRY case (which delegates to ACTION_REGISTRY → handleEnquiryFlow
  // for SERVICES/GENERAL modes) is reached correctly.
  'ENQUIRY':            'ENQUIRY',

  // Electronics top-level action buttons (on welcome / product-list screens, no active flow)
  // [FIX-BTN-ELEC] COMPARE/SPEC_REQUEST/WARRANTY appeared in BUTTON_ID_MAP but were
  // missing — tapping them outside an active flow returned CONTINUE_FLOW and showed the
  // welcome menu instead of starting the requested flow.
  // • COMPARE: "⚖️ Compare Products" on the ELECTRONICS welcome screen.
  // • SPEC_REQUEST: "❓ Ask a Question" in post-list / fallback contexts (no active flow).
  // • WARRANTY: "🛡 Warranty" in post-order / fallback contexts (no active flow).
  'COMPARE':            'COMPARE',
  'SPEC_REQUEST':       'SPEC_REQUEST',
  'WARRANTY':           'WARRANTY',

  // Salon/Barbershop walk-in queue
  'WALKIN':             'WALKIN',
  'JOIN_QUEUE':         'WALKIN',

  // Payment
  'PAYMENT':            'PAYMENT',
  'DONE':               'DONE',

  // Date/time confirmation
  'CONFIRM_DATE':       'CONFIRM',
  'CONFIRM_TIME':       'CONFIRM',

  // Rejection handling
  'REJECTION_RESEND':   'REJECTION_RESEND',
  // [FIX-BTN-RS] REJECTION_SUPPORT was mapping to 'REJECTION_SUPPORT' which has no
  // handler in moduleRouter — it fell through to the unknown-action fallback showing
  // a generic error menu. This button is shown on the payment rejection card and
  // should escalate to the human support flow, same as tapping the SUPPORT button.
  'REJECTION_SUPPORT':  'SUPPORT',
  'REJECTION_CANCEL':   'REJECTION_CANCEL',

  // Numeric shortcuts (welcome menu quick-tap)
  // Position 1 = Order/primary CTA, 2 = Book/secondary CTA, 3 = Question/tertiary CTA
  // [FIX-NUM-3] '3' was mapped to 'ENQUIRY' — but BUTTON_ID_MAP['QUESTION'] has been
  // fixed to map to 'QUESTION', and the 3rd button on most welcome menus (RESTAURANT,
  // RETAIL, SERVICES) is QUESTION. Changed to 'QUESTION' for consistency.
  '1':                  'START_ORDER',
  '2':                  'START_BOOKING',
  '3':                  'QUESTION',
  '0':                  'SHOW_MENU',

  // Quantity quick-pick buttons — [UX-1] route as CONTINUE_FLOW so active order
  // handlers receive the raw QTY_N value and resolve it via their shortcut map.
  'QTY_1':              'CONTINUE_FLOW',
  'QTY_2':              'CONTINUE_FLOW',
  'QTY_3':              'CONTINUE_FLOW',

  // Skincare advice skin-type buttons — [FIX-8] these were unmapped so tapping them
  // sent the raw button ID string ('SKIN_DRY') to AI as if it were a customer message.
  // Now correctly routed as CONTINUE_FLOW so the active SKINCARE_ADVICE handler receives them.
  'SKIN_DRY':           'CONTINUE_FLOW',
  'SKIN_OILY':          'CONTINUE_FLOW',
  'SKIN_COMBO':         'CONTINUE_FLOW',
  'SKIN_CUSTOM':        'CONTINUE_FLOW',

  // Fashion colour selection — [UX-4] COLOR_ prefixed IDs must route as CONTINUE_FLOW
  // so the active fashion ORDER handler's SELECT_COLOR case receives the raw value.
  // COLOR_SKIP is the "no preference" option.
  'COLOR_SKIP':         'CONTINUE_FLOW',

  // Delivery scheduled time slots — [UX-7]
  'SCHED_9AM':          'CONTINUE_FLOW',
  'SCHED_10AM':         'CONTINUE_FLOW',
  'SCHED_11AM':         'CONTINUE_FLOW',
  'SCHED_12PM':         'CONTINUE_FLOW',
  'SCHED_2PM':          'CONTINUE_FLOW',
  'SCHED_4PM':          'CONTINUE_FLOW',
  'SCHED_6PM':          'CONTINUE_FLOW',
  'SCHED_CUSTOM':       'CONTINUE_FLOW',

  // Booking party size buttons
  'PARTY_2':            'CONTINUE_FLOW',
  'PARTY_4':            'CONTINUE_FLOW',
  'PARTY_6':            'CONTINUE_FLOW',
};

// ── Emoji → Intent map ────────────────────────────────────────────────────────
export const EMOJI_MAP = {
  '🍔': 'ORDER', '🛍': 'ORDER', '🛒': 'ORDER', '🍕': 'ORDER',
  '🛍️': 'ORDER', '🧁': 'ORDER', '💄': 'ORDER', '📱': 'ORDER',
  '📅': 'BOOKING', '📆': 'BOOKING', '🗓': 'BOOKING', '💇': 'BOOKING',
  '❓': 'QUESTION', '🤔': 'QUESTION', '💬': 'QUESTION',
  '🚶': 'WALKIN', '🚶‍♂️': 'WALKIN', '💈': 'START_BOOKING',
  '💳': 'PAYMENT', '💰': 'PAYMENT',
  '🏠': 'SHOW_MENU', '🔄': 'SHOW_MENU',
  // [FIX-ACK-EMOJI] Acknowledgement emoji — normalise() strips these to '' so
  // they never reach the keyword matcher. Mapping them here in EMOJI_MAP
  // (step 2, before normalise runs) ensures 👍/🙏/😊/❤️ route to ACKNOWLEDGE
  // rather than falling through to AI classify or FALLBACK.
  '👍': 'ACKNOWLEDGEMENT', '🙏': 'ACKNOWLEDGEMENT', '😊': 'ACKNOWLEDGEMENT',
  '❤️': 'ACKNOWLEDGEMENT', '🥰': 'ACKNOWLEDGEMENT', '😍': 'ACKNOWLEDGEMENT',
};

// ── Keyword → Intent map ──────────────────────────────────────────────────────
// All values are normalised lowercase. Order within each array doesn't matter.
export const INTENT_PATTERNS = {

  // ── CANCEL_ALL — bulk cancellation of all active orders ──────────────────
  // Triggered when a customer wants to cancel every pending/confirmed order at once.
  // Handled by webhookController before the normal CANCEL flow.
  CANCEL_ALL: [
    'cancel all', 'cancel all orders', 'cancel all of them',
    'cancel everything', 'cancel all my orders', 'cancel them all',
    'cancel all order', 'cancel all of the orders',
    'cancel it all', 'cancel all my order',
  ],

  // ── CANCEL_ORDER — single-order cancellation typed as text ────────────────
  // [FIX-CANCEL-TYPED] 'cancel order' was in the SUPPORT array — a customer typing
  // "cancel order" triggered a human escalation instead of the cancel flow. Moved here
  // so text-typed cancel phrases reach the CANCEL handler, consistent with button taps.
  CANCEL_ORDER: [
    'cancel order', 'cancel my order', 'cancel this order', 'cancel it',
    'i want to cancel', 'stop my order', 'dont want it', "don't want it",
    'never mind my order', 'nevermind my order',
  ],

  // ── CANCEL_BOOKING — booking-specific cancellation typed as text ───────────
  // [FIX-CANCEL-BOOKING-INTENT] 'cancel booking' had no keyword entry — customers
  // typing these phrases hit AI classification which frequently returned SUPPORT,
  // triggering a full human escalation instead of the dedicated cancel-booking handler.
  // Now correctly routes to CANCEL_BOOKING action → moduleRouter cancels the Booking DB record.
  CANCEL_BOOKING: [
    'cancel booking', 'cancel my booking', 'cancel reservation', 'cancel my reservation',
    'cancel appointment', 'cancel my appointment', 'cancel table', 'cancel my table',
    'i want to cancel booking', 'cancel the booking', 'remove my booking',
    'delete my booking', 'cancel book', 'cancel my book',
  ],

  // ── [SPEC-PART7] ACKNOWLEDGEMENT classifier ──────────────────────────────
  // These words/phrases must NEVER trigger a greeting, menu reset, or FALLBACK.
  // They are reactions / filler sent mid-conversation (especially while an order
  // is being prepared). The intentEngine maps this to action 'ACKNOWLEDGE' which
  // moduleRouter handles with a context-aware micro-reply, not a welcome screen.
  ACKNOWLEDGEMENT: [
    'ok', 'okay', 'k', 'kk', 'alright', 'aight', 'sure',
    'got it', 'noted', 'understood', 'received',
    'cool', 'nice', 'great', 'perfect', 'awesome', 'brilliant', 'wonderful', 'lovely',
    'fine', 'good', 'sounds good',
    'ahhh', 'ahh', 'ah', 'ohh', 'oh', 'hmm', 'hmmm', 'wow', 'phew', 'yay',
    'np', 'no problem',
    // [FIX-ACK-THANKS] "thank you" and its variants were missing — they hit step 7
    // (AI classify) which returned SUPPORT, triggering an unintended human escalation.
    // These must be hard-coded keyword matches so they never reach AI classification.
    'thanks', 'thank you', 'thank u', 'thankyou', 'thank-you',
    'thx', 'ty', 'tq', 'cheers', 'appreciate it', 'appreciate',
    'many thanks', 'much appreciated', 'big thanks', 'thanks a lot',
    'thanks so much', 'thank you so much', 'thank you very much',
    '👍', '🙏', '😊', '❤️',
    // [FIX-ACK-AFFIRMATIVE] Conversational affirmative/agreeable phrases that AI tends
    // to classify as GREETING (triggering the booking/order gate). These are valid
    // acknowledgement responses to a farewell or follow-up message and must never
    // cause a GREET flow reset or show stale booking/order status cards.
    'sure i do', 'i sure do', 'i will', 'will do', 'definitely',
    'absolutely', 'of course', 'certainly', 'for sure', 'sure thing',
    'sounds great', 'sounds good to me', 'that sounds good', 'that works',
    'yeah', 'yep', 'yep yep', 'yes', 'yes please', 'indeed',
    'exactly', 'right', 'correct', 'true', 'fair enough', 'fair',
    'agreed', 'for real', 'totally', 'sure enough',
    'glad to hear', 'happy to hear', 'nice to know',
  ],

  GREETING: [
    'hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening',
    'start', 'begin', 'hiya', 'howdy', 'greetings', 'salaam', 'salam',
    'yo', 'sup', 'whatsup', 'what sup', 'assalamu alaikum',
  ],

  ORDER: [
    'order', 'order now', 'buy', 'purchase', 'shop', 'shop now',
    'i want to order', 'place order', 'i want to buy', 'i want food',
    'get food', 'order food', 'i want to eat', 'add to cart', 'buy now',
    'i want', 'i would like to order', 'can i order', 'let me order',
    'i need food', 'food please', 'give me food', 'bring food', 'order pls',
    'lemme order', 'i wan order', 'i wan buy', 'i wan food',
    'abeg let me order', 'pls let me order', 'i dey hungry',
    // Fashion
    'i want clothes', 'browse collection', 'see collection', 'view collection',
    'i want a dress', 'i want shoes', 'fashion', 'i want to shop fashion',
    // Cosmetics
    'i want beauty products', 'buy skincare', 'buy makeup', 'shop beauty',
    'i want skincare', 'i need makeup', 'i want cosmetics',
    // Bakery
    'i want a cake', 'order cake', 'buy bread', 'i want pastries',
    'pre-order', 'preorder', 'i want to pre-order',
    // Electronics
    'buy phone', 'buy laptop', 'buy electronics', 'i want a phone',
    'browse products', 'view products',
  ],

  BOOKING: [
    'book', 'book now', 'reserve', 'make a booking', 'book a table',
    'i want to book', 'schedule', 'appointment', 'make appointment',
    'book appointment', 'i need appointment', 'book a slot',
    'book a service', 'i want appointment',
    // Salon specific
    'haircut', 'hair cut', 'cut my hair', 'beard trim', 'trim beard',
    'i want a haircut', 'book haircut', 'i need a haircut',
    // Bakery / collection
    'schedule collection', 'collect my order', 'pickup',
    // Cosmetics
    'book consultation', 'beauty consultation',
  ],

  REPEAT_ORDER: [
    'repeat order', 'order again', 'same as last time', 'reorder',
    're-order', 'order the same', 'my usual', 'same order', 'my last order',
  ],

  TRACK_ORDER: [
    'track order', 'track my order', 'where is my order', 'order status',
    'when is my order', 'order update', 'my order', 'check order',
    'delivery status', 'where is my food', 'how long', 'where my order',
    // [FIX-TRACK-ORDER] Reference number queries — customer pastes their shortId to ask
    // about their order. Without this, "how about my order #2AC257" → START_ORDER (because
    // "order" keyword matches) → bot starts a new order flow instead of looking up the ref.
    'my order ref', 'my order number', 'order reference', 'ref number',
    'how about my order', 'what about my order', 'update on my order',
  ],

  PAYMENT: [
    'pay', 'payment', 'how to pay', 'wave', 'pay now', 'make payment',
    'send payment', 'transfer', 'checkout', 'how do i pay',
    // [FIX-PAY-INTENT] Payment-status queries — customers asking if their payment went
    // through after sending a screenshot or completing a transfer. Previously these fell
    // through to AI classification which returned QUESTION/SUPPORT, bypassing the
    // dedicated PAYMENT handler in moduleRouter that correctly looks up the order state
    // and returns a factual confirmed/pending/unpaid response.
    'did i pay', 'did i paid', 'have i paid', 'was my payment', 'is my payment',
    'did i make payment', 'did i send payment', 'i already paid', 'i paid already',
    'i paid', 'i have paid', 'i already pay', 'payment confirmed', 'payment done',
    'is my order paid', 'was my order paid', 'payment sent', 'i sent payment',
    'check my payment', 'confirm my payment', 'payment status',
  ],

  WALKIN: [
    'walk in', 'walk-in', 'walkin', 'walk in now', 'i want to walk in',
    'join queue', 'join the queue', 'add me to queue', 'queue',
    "i'm here", 'i am here', 'coming in now', 'be there now',
    'walk in today', 'no appointment', 'without appointment',
  ],

  SUPPORT: [ 'issue', 'complaint', 'wrong order',
    'speak to human', 'speak to agent', 'speak to someone', 'real person',
    'live agent', 'manager', 'customer service', 'not happy', 'unhappy',
    'refund', 'i have a problem', 'i have an issue',
    // [FIX-SUPPORT-NATURAL] Natural human-escalation phrases that customers use when
    // they need help mid-order. Previously these fell into isUnrelated → food-mode lock
    // with no escape. Now correctly classified as SUPPORT so moduleRouter routes them
    // to the human handoff flow, even when said during an active order context.
    'i need help', 'need help', 'help me', 'help please', 'please help',
    'i want to talk to the admin', 'talk to admin', 'talk to human',
    'i want to talk to human', 'talk to someone', 'i want to speak to someone',
    'talk to a person', 'i want to talk to a person', 'connect me to admin',
    'i want human', 'get me human', 'human please', 'contact support',
    'i need support', 'get support', 'reach support',
  ],

  SHOW_MENU: [
    'menu', 'show menu', 'view menu', 'see menu', 'main menu', 'home',
    'back to menu', 'back', 'restart', '0', 'start over',
  ],

  CAKE_CUSTOMIZATION: [
    'custom cake', 'customise cake', 'customize cake', 'special cake',
    'birthday cake', 'wedding cake', 'cake design', 'cake order',
    'i want a custom cake', 'design a cake',
  ],

  SPEC_REQUEST: [
    'specs', 'specifications', 'features', 'ram', 'storage', 'battery',
    'camera', 'processor', 'display', 'screen size', 'what are the specs',
    'tell me about', 'details about',
  ],

  WARRANTY_INFO: [
    'warranty', 'guarantee', 'returns', 'return policy', 'exchange',
    'how long warranty', 'what is warranty',
  ],

  AVAILABILITY_CHECK: [
    'available', 'in stock', 'do you have', 'is it available',
    'any available slots', 'when are you free', 'open today',
    'available tomorrow', 'can i come',
  ],

  SKINCARE_ADVICE: [
    'skin advice', 'skincare routine', 'what is good for', 'recommend skincare',
    'dry skin', 'oily skin', 'acne', 'dark spots', 'moisturiser recommendation',
    'best product for',
  ],

  QUESTION: [
    'question', 'ask', 'enquiry', 'inquiry', 'info', 'information',
    'tell me', 'what is', 'what are', 'how much', 'do you', 'can you',
    'when', 'where', 'opening hours', 'hours', 'location', 'address',
    'price', 'prices', 'cost', 'how much does', 'what time', 'contact',
    'faq',
  ],
};
