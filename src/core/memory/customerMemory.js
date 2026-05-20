/**
 * core/memory/customerMemory.js — WhatSalesAgent2
 *
 * Persistent customer memory across sessions.
 * Tracks preferences, order history, and repeat behavior
 * to power personalised greetings and recommendations.
 */

import UserProfile from '../../models/UserProfile.js';
import Order       from '../../models/Order.js';
import logger      from '../../config/logger.js';

/**
 * getOrCreate(phone, tenantId)
 * Fetches or initialises a UserProfile.
 */
export async function getOrCreate(phone, tenantId) {
  try {
    return await UserProfile.findOneAndUpdate(
      { phone, tenantId },
      { $setOnInsert: { phone, tenantId, createdAt: new Date() } },
      { upsert: true, new: true }
    ).lean();
  } catch (err) {
    logger.debug('[Memory] getOrCreate failed', { err: err.message });
    return null;
  }
}

/**
 * recordOrderItem(phone, tenantId, itemName)
 * Increments the item count in favoriteItems list.
 */
export async function recordOrderItem(phone, tenantId, itemName) {
  if (!itemName) return;
  try {
    // Try to increment existing item
    const updated = await UserProfile.findOneAndUpdate(
      { phone, tenantId, 'preferences.favoriteItems.name': itemName },
      { $inc: { 'preferences.favoriteItems.$.count': 1 } },
      { new: true }
    );
    if (!updated) {
      // Item not in list yet — push new entry
      await UserProfile.findOneAndUpdate(
        { phone, tenantId },
        { $push: { 'preferences.favoriteItems': { name: itemName, count: 1 } } },
        { upsert: true }
      );
    }
  } catch (err) {
    logger.debug('[Memory] recordOrderItem failed', { err: err.message });
  }
}

/**
 * getTopItem(phone, tenantId)
 * Returns the customer's most ordered item name, or null.
 */
export async function getTopItem(phone, tenantId) {
  try {
    const profile = await UserProfile.findOne({ phone, tenantId })
      .select('preferences.favoriteItems').lean();
    const items = profile?.preferences?.favoriteItems || [];
    if (!items.length) {
      // Fallback: query Order collection directly
      const last = await Order.findOne({ customerPhone: phone, tenantId })
        .sort({ createdAt: -1 }).select('item').lean();
      return last?.item || null;
    }
    return items.sort((a, b) => b.count - a.count)[0]?.name || null;
  } catch (err) {
    logger.debug('[Memory] getTopItem failed', { err: err.message });
    return null;
  }
}

/**
 * updateName(phone, tenantId, name)
 * Stores the customer's name from any source.
 */
export async function updateName(phone, tenantId, name) {
  if (!name) return;
  try {
    await UserProfile.findOneAndUpdate(
      { phone, tenantId },
      { $set: { 'lead.name': name } },
      { upsert: true }
    );
  } catch (err) {
    logger.debug('[Memory] updateName failed', { err: err.message });
  }
}

/**
 * isReturningCustomer(phone, tenantId)
 * True if customer has placed at least one previous order.
 */
export async function isReturningCustomer(phone, tenantId) {
  try {
    const count = await Order.countDocuments({ customerPhone: phone, tenantId });
    return count > 0;
  } catch {
    return false;
  }
}

/**
 * getCustomerContext(phone, tenantId)
 * Returns a rich context object for personalised AI responses.
 */
export async function getCustomerContext(phone, tenantId) {
  try {
    const [profile, lastOrder] = await Promise.all([
      UserProfile.findOne({ phone, tenantId }).lean(),
      Order.findOne({ customerPhone: phone, tenantId }).sort({ createdAt: -1 }).lean(),
    ]);
    return {
      name:        profile?.lead?.name || null,
      topItem:     (profile?.preferences?.favoriteItems || []).sort((a, b) => b.count - a.count)[0]?.name || null,
      lastItem:    lastOrder?.item || null,
      orderCount:  profile?.preferences?.favoriteItems?.reduce((s, i) => s + (i.count || 0), 0) || 0,
      isReturning: !!lastOrder,
    };
  } catch (err) {
    logger.debug('[Memory] getCustomerContext failed', { err: err.message });
    return { name: null, topItem: null, lastItem: null, orderCount: 0, isReturning: false };
  }
}
