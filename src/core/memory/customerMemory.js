/**
 * core/memory/customerMemory.js — WhatSalesAgent
 *
 * Persistent customer memory across sessions.
 * Tracks preferences, order history, and repeat behavior
 * to power personalised greetings and recommendations.
 *
 * [FIX-BUG5]    recordOrderItem() and updateName() are now actually called.
 * [MEM-OPT-1]   getCustomerContext: added .select() projection on both queries.
 *               Previously fetched entire UserProfile + Order documents on every
 *               greeting. Now fetches only the fields required for personalisation,
 *               cutting DB payload by ~80%.
 * [MEM-OPT-2]   getCustomerContext: added lastOrderAt field so callers can apply
 *               a greeting cooldown (skip Groq API call for recently-seen customers).
 * [MEM-FIX-1]   recordOrderItem: moved totalOrders increment here only — callers
 *               that want confirmed-order-only counting should call recordConfirmedOrder().
 *
 * [NO-MEMORY-1] PERMANENT PROJECT RULE — the GREET case in
 *               core/conversations/moduleRouter.js deliberately does NOT call into
 *               this file (getCustomerContext / generateGreeting) to personalise the
 *               welcome message. The welcome greeting must never reference order or
 *               booking history and must not use the customer's name, for now. Do
 *               not re-wire GREET to this module without confirming that rule has
 *               changed — see the NO-MEMORY-1 block in moduleRouter.js for details.
 *               This file's other consumers (order/booking flows, VIP tagging, etc.)
 *               are unaffected by this rule.
 */

import { UserProfile, Order, Booking } from '../../models/index.js';
import mongoose    from 'mongoose';
import logger      from '../../config/logger.js';

function toOid(id) {
  if (!id) return id;
  if (id instanceof mongoose.Types.ObjectId) return id;
  try { return new mongoose.Types.ObjectId(String(id)); } catch { return id; }
}

export async function getOrCreate(phone, tenantId) {
  try {
    return await UserProfile.findOneAndUpdate(
      { phone, tenantId: toOid(tenantId) },
      { $setOnInsert: { phone, tenantId: toOid(tenantId), 'activity.firstSeen': new Date(), 'activity.lastSeen': new Date() } },
      { upsert: true, new: true }
    ).lean();
  } catch (err) {
    logger.debug('[Memory] getOrCreate failed', { err: err.message });
    return null;
  }
}

export async function recordOrderItem(phone, tenantId, itemName, { countOrder = true } = {}) {
  if (!phone || !tenantId || !itemName) return;
  try {
    const updated = await UserProfile.findOneAndUpdate(
      { phone, tenantId: toOid(tenantId), 'preferences.favoriteItems.name': itemName },
      {
        // [FIX-MEM-DOUBLECOUNT] countOrder lets callers track the favourite-item tag
        // without also bumping stats.totalOrders. orderService.saveOrder() needs the
        // former (so recommendations work immediately) but NOT the latter — totalOrders
        // is the dedicated responsibility of recordConfirmedOrder(), called only on actual
        // admin payment confirmation (see adminCommandService.confirmPayment / MEM-FIX-1).
        $inc: countOrder
          ? { 'preferences.favoriteItems.$.count': 1, 'stats.totalOrders': 1 }
          : { 'preferences.favoriteItems.$.count': 1 },
        $set: { 'activity.lastSeen': new Date() },
      },
      { new: true }
    );
    if (!updated) {
      await UserProfile.findOneAndUpdate(
        { phone, tenantId: toOid(tenantId) },
        {
          $push: { 'preferences.favoriteItems': { name: itemName, count: 1 } },
          $inc:  countOrder ? { 'stats.totalOrders': 1 } : {},
          $set:  { 'activity.lastSeen': new Date() },
        },
        { upsert: true }
      );
    }
  } catch (err) {
    logger.debug('[Memory] recordOrderItem failed', { err: err.message });
  }
}

/**
 * recordConfirmedOrder — called ONLY when admin confirms payment.
 * Increments totalOrders so memory reflects real completed orders, not abandoned attempts.
 * Call this from adminCommandService.confirmPayment instead of orderService.saveOrder.
 */
export async function recordConfirmedOrder(phone, tenantId, itemName) {
  if (!phone || !tenantId) return;
  try {
    if (itemName) {
      await recordOrderItem(phone, tenantId, itemName);
    } else {
      // No item name — just bump the counter and lastSeen
      await UserProfile.findOneAndUpdate(
        { phone, tenantId: toOid(tenantId) },
        { $inc: { 'stats.totalOrders': 1 }, $set: { 'activity.lastSeen': new Date() } },
        { upsert: true }
      );
    }
  } catch (err) {
    logger.debug('[Memory] recordConfirmedOrder failed', { err: err.message });
  }
}

export async function recordBooking(phone, tenantId) {
  if (!phone || !tenantId) return;
  try {
    await UserProfile.findOneAndUpdate(
      { phone, tenantId: toOid(tenantId) },
      { $inc: { 'stats.totalBookings': 1 }, $set: { 'activity.lastSeen': new Date() } },
      { upsert: true }
    );
  } catch (err) {
    logger.debug('[Memory] recordBooking failed', { err: err.message });
  }
}

export async function updateName(phone, tenantId, name) {
  if (!phone || !tenantId) return;
  try {
    if (name) {
      await UserProfile.findOneAndUpdate(
        { phone, tenantId: toOid(tenantId) },
        { $set: { 'lead.name': name, 'activity.lastSeen': new Date() } },
        { upsert: true }
      );
    } else {
      // [FIX-NAME-9] Clear a bad name stored by older code.
      await UserProfile.findOneAndUpdate(
        { phone, tenantId: toOid(tenantId) },
        { $unset: { 'lead.name': '' } }
      );
    }
  } catch (err) {
    logger.debug('[Memory] updateName failed', { err: err.message });
  }
}

export async function getTopItem(phone, tenantId) {
  try {
    const profile = await UserProfile.findOne({ phone, tenantId: toOid(tenantId) })
      .select('preferences.favoriteItems')
      .lean();
    const items = profile?.preferences?.favoriteItems || [];
    if (items.length) {
      return items.sort((a, b) => b.count - a.count)[0]?.name || null;
    }
    const last = await Order.findOne({ customerPhone: phone, tenantId })
      .sort({ createdAt: -1 })
      .select('item')
      .lean();
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

/**
 * getCustomerContext — used on every greeting and postFlowAck.
 *
 * [MEM-OPT-1] Both queries now use .select() projection — fetches only the
 *             fields needed for personalisation. Previously returned entire
 *             documents including unbounded favoriteItems arrays and all order fields.
 * [MEM-OPT-2] Returns lastOrderAt so callers can apply greeting cooldowns.
 */
export async function getCustomerContext(phone, tenantId) {
  try {
    const [profile, lastOrder, lastBooking] = await Promise.all([
      UserProfile.findOne({ phone, tenantId: toOid(tenantId) })
        .select('lead.name preferences.favoriteItems stats.totalOrders stats.totalBookings activity.lastSeen')
        .lean(),
      Order.findOne({ customerPhone: phone, tenantId, status: { $nin: ['cancelled', 'rejected'] } })
        .sort({ createdAt: -1 })
        .select('item createdAt')
        .lean(),
      // [MEM-SALON-1] Fetch last non-cancelled booking so salon returning customers
      // get a personalised greeting referencing their last appointment and stylist,
      // even if they've never placed a product order. Without this, all salon customers
      // were treated as new customers in the greeting flow.
      Booking.findOne({
        customerPhone: phone,
        tenantId,
        status: { $nin: ['cancelled'] },
        bookingType: { $ne: 'walkin' },
      })
        .sort({ createdAt: -1 })
        .select('service staff date createdAt')
        .lean(),
    ]);

    const favoriteItems = profile?.preferences?.favoriteItems || [];
    const topItem = favoriteItems.length
      ? favoriteItems.sort((a, b) => b.count - a.count)[0]?.name || null
      : null;

    return {
      name:           profile?.lead?.name || null,
      topItem,
      lastItem:        lastOrder?.item || null,
      lastOrderAt:     lastOrder?.createdAt || null,
      // [FIX-MEM] lastBookingAt for salon returning-customer greeting cooldown
      lastBookingAt:   lastBooking?.createdAt || null,
      orderCount:     profile?.stats?.totalOrders || 0,
      totalBookings:  profile?.stats?.totalBookings || 0,
      isReturning:    !!(lastOrder || lastBooking),
      // [MEM-SALON-1] Booking context for salon/barbershop personalisation
      lastBooking:    lastBooking ? {
        service:    lastBooking.service || null,
        staff:      lastBooking.staff || null,
        date:       lastBooking.date || null,
        createdAt:  lastBooking.createdAt || null,
      } : null,
    };
  } catch (err) {
    logger.debug('[Memory] getCustomerContext failed', { err: err.message });
    return {
      name: null, topItem: null, lastItem: null, lastOrderAt: null,
      orderCount: 0, totalBookings: 0, isReturning: false, lastBooking: null,
    };
  }
}
