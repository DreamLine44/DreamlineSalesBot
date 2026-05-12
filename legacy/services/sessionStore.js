'use strict';

/**
 * SessionStore — in-memory store with TTL, recovery, and safe mutation helpers.
 * Drop-in replace with Redis adapter for production clustering.
 */

const { logger } = require('../utils/logger');

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle expiry
const PAYMENT_HOLD_MS = 24 * 60 * 60 * 1000; // 24 hours — payment context must survive

class SessionStore {
  constructor() {
    this._store = new Map();
    this._timers = new Map();
    // Cleanup sweep every 5 minutes
    setInterval(() => this._sweep(), 5 * 60 * 1000);
  }

  /** Get session; returns null if not found */
  get(userId) {
    return this._store.get(userId) ?? null;
  }

  /** Get or create a fresh session */
  getOrCreate(userId, contactName) {
    if (!this._store.has(userId)) {
      this._store.set(userId, this._fresh(userId, contactName));
      logger.debug(`Session created: ${userId}`);
    }
    const session = this._store.get(userId);
    session.lastActivity = Date.now();
    this._resetTimer(userId, session);
    return session;
  }

  /** Save (upsert) a mutated session object */
  save(session) {
    if (!session?.userId) throw new Error('SessionStore.save: session.userId required');
    session.lastActivity = Date.now();
    this._store.set(session.userId, session);
    this._resetTimer(session.userId, session);
    return session;
  }

  /** Hard-delete a session */
  delete(userId) {
    this._clearTimer(userId);
    this._store.delete(userId);
    logger.debug(`Session deleted: ${userId}`);
  }

  /** Count of active sessions */
  size() {
    return this._store.size;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  _fresh(userId, contactName) {
    return {
      userId,
      contactName: contactName || 'Friend',
      state: 'IDLE',
      // Ordering context
      currentOrder: [],           // Array of { itemId, name, qty, price, addons }
      pendingItem: null,          // Item waiting for quantity confirmation
      orderType: null,            // 'delivery' | 'pickup' | 'dine-in'
      deliveryAddress: null,
      tableBooking: null,
      // Payment context — never cleared until verified or explicitly cancelled
      payment: {
        status: null,             // null | 'pending' | 'uploaded' | 'verified' | 'rejected'
        orderId: null,
        screenshotReceived: false,
        uploadedAt: null,
        verifiedAt: null,
        retryCount: 0,
      },
      // Navigation
      lastMenu: null,
      lastMessageId: null,
      // Conversation intelligence
      lastIntent: null,
      awaitingConfirmation: null, // { type, data }
      messageHistory: [],         // Rolling last 10 message intents
      // Meta
      createdAt: Date.now(),
      lastActivity: Date.now(),
      interactionCount: 0,
    };
  }

  _resetTimer(userId, session) {
    this._clearTimer(userId);
    // Payment sessions get a much longer TTL
    const ttl = session.payment?.status === 'pending' || session.payment?.status === 'uploaded'
      ? PAYMENT_HOLD_MS
      : SESSION_TTL_MS;
    const timer = setTimeout(() => {
      logger.info(`Session expired (TTL): ${userId}`);
      this._store.delete(userId);
      this._timers.delete(userId);
    }, ttl);
    this._timers.set(userId, timer);
  }

  _clearTimer(userId) {
    const t = this._timers.get(userId);
    if (t) { clearTimeout(t); this._timers.delete(userId); }
  }

  _sweep() {
    const now = Date.now();
    for (const [userId, session] of this._store) {
      const isPaymentActive = ['pending', 'uploaded'].includes(session.payment?.status);
      const ttl = isPaymentActive ? PAYMENT_HOLD_MS : SESSION_TTL_MS;
      if (now - session.lastActivity > ttl) {
        logger.info(`Session swept: ${userId}`);
        this._clearTimer(userId);
        this._store.delete(userId);
      }
    }
  }
}

const sessionStore = new SessionStore();
module.exports = { sessionStore };
