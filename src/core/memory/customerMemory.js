/**
 * core/memory/customerMemory.js — WhatSalesAgent
 *
 * Persistent customer memory across sessions.
 * Tracks preferences, order history, and repeat behavior
 * to power personalised greetings and recommendations.
 *
 * [FIX-BUG5] recordOrderItem() and updateName() are now actually called:
 *   - recordOrderItem() called by orderService.saveOrder() after every successful order
 *   - updateName() called by webhookController when a name is extracted
 *   Previously this entire module was defined but never used, making personalisation
 *   and repeat-customer features completely inert.
 */

import UserProfile from '../../models/UserProfile.js';
import Order       from '../../models/Order.js';
import logger      from '../../config/logger.js';

export async function getOrCreate(phone, tenantId) {
  try {
    return await UserProfile.findOneAndUpdate(
      { phone, tenantId },
      { $setOnInsert: { phone, tenantId, 'activity.firstSeen': new Date(), 'activity.lastSeen': new Date() } },
      { upsert: true, new: true }
    ).lean();
  } catch (err) {
    logger.debug('[Memory] getOrCreate failed', { err: err.message });
    return null;
  }
}

export async function recordOrderItem(phone, tenantId, itemName) {
  if (!phone || !tenantId || !itemName) return;
  try {
    const updated = await UserProfile.findOneAndUpdate(
      { phone, tenantId, 'preferences.favoriteItems.name': itemName },
      {
        $inc: { 'preferences.favoriteItems.$.count': 1, 'stats.totalOrders': 1 },
        $set: { 'activity.lastSeen': new Date() },
      },
      { new: true }
    );
    if (!updated) {
      await UserProfile.findOneAndUpdate(
        { phone, tenantId },
        {
          $push: { 'preferences.favoriteItems': { name: itemName, count: 1 } },
          $inc:  { 'stats.totalOrders': 1 },
          $set:  { 'activity.lastSeen': new Date() },
        },
        { upsert: true }
      );
    }
  } catch (err) {
    logger.debug('[Memory] recordOrderItem failed', { err: err.message });
  }
}

export async function recordBooking(phone, tenantId) {
  if (!phone || !tenantId) return;
  try {
    await UserProfile.findOneAndUpdate(
      { phone, tenantId },
      { $inc: { 'stats.totalBookings': 1 }, $set: { 'activity.lastSeen': new Date() } },
      { upsert: true }
    );
  } catch (err) {
    logger.debug('[Memory] recordBooking failed', { err: err.message });
  }
}

export async function updateName(phone, tenantId, name) {
  if (!phone || !tenantId || !name) return;
  try {
    await UserProfile.findOneAndUpdate(
      { phone, tenantId },
      { $set: { 'lead.name': name, 'activity.lastSeen': new Date() } },
      { upsert: true }
    );
  } catch (err) {
    logger.debug('[Memory] updateName failed', { err: err.message });
  }
}

export async function getTopItem(phone, tenantId) {
  try {
    const profile = await UserProfile.findOne({ phone, tenantId }).select('preferences.favoriteItems').lean();
    const items = profile?.preferences?.favoriteItems || [];
    if (items.length) {
      return items.sort((a, b) => b.count - a.count)[0]?.name || null;
    }
    const last = await Order.findOne({ customerPhone: phone, tenantId }).sort({ createdAt: -1 }).select('item').lean();
    return last?.item || null;
  } catch (err) {
    logger.debug('[Memory] getTopItem failed', { err: err.message });
    return null;
  }
}

export async function isReturningCustomer(phone, tenantId) {
  try {
    const count = await Order.countDocuments({ customerPhone: phone, tenantId });
    return count > 0;
  } catch {
    return false;
  }
}

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
      orderCount:  profile?.stats?.totalOrders || 0,
      isReturning: !!lastOrder,
    };
  } catch (err) {
    logger.debug('[Memory] getCustomerContext failed', { err: err.message });
    return { name: null, topItem: null, lastItem: null, orderCount: 0, isReturning: false };
  }
}
