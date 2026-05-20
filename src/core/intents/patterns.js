/**
 * core/intents/patterns.js
 *
 * Single source of truth for all intent keywords, button IDs and emoji shortcuts.
 * Edit here to add new phrases — no other files need changing.
 */

// ── Button ID → Action map ────────────────────────────────────────────────────
// Every interactive button sent to customers must have its ID registered here.
export const BUTTON_ID_MAP = {
  // Primary actions
  'ORDER':              'START_ORDER',
  'BOOK':               'START_BOOKING',
  'QUESTION':           'ENQUIRY',
  'SUPPORT':            'SUPPORT',
  'SHOW_MENU':          'SHOW_MENU',
  'VIEW_MENU':          'SHOW_MENU',

  // Flow control
  'CONFIRM':            'CONFIRM',
  'CANCEL':             'CANCEL',
  'CANCEL_BOOKING':     'CANCEL',
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
  'NEW_ORDER':          'START_ORDER',

  // Payment
  'PAYMENT':            'PAYMENT',
  'DONE':               'DONE',

  // Date/time confirmation
  'CONFIRM_DATE':       'CONFIRM',
  'CONFIRM_TIME':       'CONFIRM',

  // Rejection handling
  'REJECTION_RESEND':   'REJECTION_RESEND',
  'REJECTION_SUPPORT':  'REJECTION_SUPPORT',
  'REJECTION_CANCEL':   'REJECTION_CANCEL',

  // Numeric shortcuts (welcome menu)
  '1':                  'START_ORDER',
  '2':                  'START_BOOKING',
  '3':                  'ENQUIRY',
  '0':                  'SHOW_MENU',
};

// ── Emoji → Intent map ────────────────────────────────────────────────────────
export const EMOJI_MAP = {
  '🍔': 'ORDER', '🛍': 'ORDER', '🛒': 'ORDER', '🍕': 'ORDER',
  '🛍️': 'ORDER', '🧁': 'ORDER', '💄': 'ORDER', '📱': 'ORDER',
  '📅': 'BOOKING', '📆': 'BOOKING', '🗓': 'BOOKING', '💇': 'BOOKING',
  '❓': 'QUESTION', '🤔': 'QUESTION', '💬': 'QUESTION',
  '💳': 'PAYMENT', '💰': 'PAYMENT',
  '🏠': 'SHOW_MENU', '🔄': 'REPEAT_ORDER',
};

// ── Keyword → Intent map ──────────────────────────────────────────────────────
// All values are normalised lowercase. Order within each array doesn't matter.
export const INTENT_PATTERNS = {

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
  ],

  PAYMENT: [
    'pay', 'payment', 'how to pay', 'wave', 'pay now', 'make payment',
    'send payment', 'transfer', 'checkout', 'how do i pay',
  ],

  SUPPORT: [
    'help', 'support', 'problem', 'issue', 'complaint', 'wrong order',
    'speak to human', 'speak to agent', 'speak to someone', 'real person',
    'live agent', 'manager', 'customer service', 'not happy', 'unhappy',
    'refund', 'cancel order', 'i have a problem', 'i have an issue',
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
