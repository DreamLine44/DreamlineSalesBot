/**
 * controllers/businessController.js — WhatSalesAgent2
 *
 * [FIX-BIZ-1] All handlers now wrapped in try/catch — previously updateBusinessConfig,
 *             addMenuItem, and deleteMenuItem had no error handling; any DB or validation
 *             error threw an unhandled exception that crashed the response with a raw
 *             Mongoose stack trace instead of a clean 500 JSON response.
 * [FIX-BIZ-2] deleteMenuItem now matches by _id (not name) to be consistent with the
 *             dashboard CRUD and avoid accidental deletion of same-named items.
 *             The old route was DELETE /:tenantId/menu/:itemName — replaced with
 *             DELETE /:tenantId/menu/:itemId for precision.
 * [FIX-BIZ-3] updateBusinessConfig now strips protected fields (_id, tenantId, __v)
 *             AND rejects a completely empty body with a 400 instead of silently
 *             no-opping.
 */
import BusinessConfig from '../models/BusinessConfig.js';
import { getModeConfig, getSupportedModes } from '../config/modes.js';
import logger from '../config/logger.js';

export async function getBusinessConfig(req, res) {
  try {
    const { tenantId } = req.params;
    const biz = await BusinessConfig.findOne({ tenantId }).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ business: biz });
  } catch (err) {
    logger.error('[Business] getBusinessConfig failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function updateBusinessConfig(req, res) {
  try {
    const { tenantId } = req.params;
    const update = { ...req.body };

    // [FIX-BIZ-1,3] Strip immutable fields and validate body
    delete update._id;
    delete update.tenantId;
    delete update.__v;

    if (!update || Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Request body is empty — nothing to update' });
    }

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $set: update },
      { new: true, upsert: false, runValidators: true },
    ).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ business: biz });
  } catch (err) {
    logger.error('[Business] updateBusinessConfig failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function getMenu(req, res) {
  try {
    const { tenantId } = req.params;
    const biz = await BusinessConfig.findOne({ tenantId }).select('menuItems services').lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ menuItems: biz.menuItems || [], services: biz.services || [] });
  } catch (err) {
    logger.error('[Business] getMenu failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function updateMenu(req, res) {
  try {
    const { tenantId } = req.params;
    const { menuItems } = req.body;
    if (!Array.isArray(menuItems)) {
      return res.status(400).json({ error: 'menuItems must be an array' });
    }
    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $set: { menuItems } },
      { new: true },
    ).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ menuItems: biz.menuItems });
  } catch (err) {
    logger.error('[Business] updateMenu failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function addMenuItem(req, res) {
  try {
    const { tenantId } = req.params;
    const { name, price, description, category, available = true, keywords = [] } = req.body;

    // [FIX-BIZ-1] Validation was already here but no try/catch around the DB call
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $push: { menuItems: { name: name.trim(), price: Number(price) || 0, description, category, available, keywords } } },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.status(201).json({ menuItems: biz.menuItems });
  } catch (err) {
    logger.error('[Business] addMenuItem failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// [FIX-BIZ-2] Match by _id (not name) — precise, safe, consistent with dashboard CRUD
// [FIX #13]  Kept in sync with dashboardController.deleteMenuItem: both now check
//            modifiedCount so callers can detect a stale/wrong itemId.
export async function deleteMenuItem(req, res) {
  try {
    const { tenantId, itemId } = req.params;
    const result = await BusinessConfig.updateOne(
      { tenantId },
      { $pull: { menuItems: { _id: itemId } } },
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Business not found' });
    if (result.modifiedCount === 0) return res.status(404).json({ error: 'Menu item not found' });
    res.json({ ok: true });
  } catch (err) {
    logger.error('[Business] deleteMenuItem failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function getModeInfo(req, res) {
  try {
    const { mode } = req.query;
    const fakeBiz = { businessMode: mode || 'RESTAURANT' };
    const cfg = getModeConfig(fakeBiz);
    res.json({ mode: cfg.businessMode, flows: cfg.flows, steps: cfg.steps, ui: cfg.ui });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function listSupportedModes(_req, res) {
  try {
    res.json({ modes: getSupportedModes() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
