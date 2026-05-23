/**
 * controllers/businessController.js — WhatSalesAgent2
 *
 * [FIX] Added updateMenuItem (PATCH by _id) and updateService (PATCH by _id).
 *       Previously these were missing — dashboard could add items but not edit them.
 * [FIX] deleteMenuItem accepts both ?itemName (legacy) and /:itemId (new) params.
 * [FIX] addMenuItem now saves keywords field.
 */
import BusinessConfig from '../models/BusinessConfig.js';
import { getModeConfig, getSupportedModes } from '../config/modes.js';

export async function getBusinessConfig(req, res) {
  try {
    const { tenantId } = req.params;
    const biz = await BusinessConfig.findOne({ tenantId }).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ business: biz });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function updateBusinessConfig(req, res) {
  try {
    const { tenantId } = req.params;
    const update = req.body;
    delete update._id; delete update.tenantId; delete update.__v;
    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId }, { $set: update }, { new: true, upsert: false },
    ).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ business: biz });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function getMenu(req, res) {
  try {
    const { tenantId } = req.params;
    const biz = await BusinessConfig.findOne({ tenantId }).select('menuItems').lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ menuItems: biz.menuItems || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function updateMenu(req, res) {
  try {
    const { tenantId } = req.params;
    const { menuItems } = req.body;
    if (!Array.isArray(menuItems)) return res.status(400).json({ error: 'menuItems must be an array' });
    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId }, { $set: { menuItems } }, { new: true },
    ).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ menuItems: biz.menuItems });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function addMenuItem(req, res) {
  try {
    const { tenantId } = req.params;
    const { name, price, description, category, available = true, keywords = [] } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $push: { menuItems: { name, price: Number(price) || 0, description, category, available, keywords } } },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.status(201).json({ menuItems: biz.menuItems });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function updateMenuItem(req, res) {
  try {
    const { tenantId, itemId } = req.params;
    const { name, price, description, category, available, keywords } = req.body;
    const patch = {};
    if (name        !== undefined) patch['menuItems.$.name']        = name;
    if (price       !== undefined) patch['menuItems.$.price']       = Number(price);
    if (description !== undefined) patch['menuItems.$.description'] = description;
    if (category    !== undefined) patch['menuItems.$.category']    = category;
    if (available   !== undefined) patch['menuItems.$.available']   = available;
    if (keywords    !== undefined) patch['menuItems.$.keywords']    = keywords;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No valid fields' });
    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId, 'menuItems._id': itemId },
      { $set: patch },
      { new: true },
    ).lean();
    if (!biz) return res.status(404).json({ error: 'Item not found' });
    res.json({ menuItems: biz.menuItems });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function deleteMenuItem(req, res) {
  try {
    const { tenantId } = req.params;
    // Support both /:itemName (legacy) and ?itemId=... or /:itemId
    const itemName = req.params.itemName;
    const itemId   = req.params.itemId || req.query.itemId;
    if (itemId) {
      await BusinessConfig.updateOne({ tenantId }, { $pull: { menuItems: { _id: itemId } } });
    } else if (itemName) {
      await BusinessConfig.updateOne({ tenantId }, { $pull: { menuItems: { name: itemName } } });
    } else {
      return res.status(400).json({ error: 'itemId or itemName required' });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── Services ──────────────────────────────────────────────────────────────────
export async function getServices(req, res) {
  try {
    const { tenantId } = req.params;
    const biz = await BusinessConfig.findOne({ tenantId }).select('services').lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ services: biz.services || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function addService(req, res) {
  try {
    const { tenantId } = req.params;
    const { name, price, description, duration, available = true } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $push: { services: { name, price: Number(price) || 0, description, duration, available } } },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.status(201).json({ services: biz.services });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function updateService(req, res) {
  try {
    const { tenantId, serviceId } = req.params;
    const { name, price, description, duration, available } = req.body;
    const patch = {};
    if (name        !== undefined) patch['services.$.name']        = name;
    if (price       !== undefined) patch['services.$.price']       = Number(price);
    if (description !== undefined) patch['services.$.description'] = description;
    if (duration    !== undefined) patch['services.$.duration']    = duration;
    if (available   !== undefined) patch['services.$.available']   = available;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No valid fields' });
    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId, 'services._id': serviceId },
      { $set: patch },
      { new: true },
    ).lean();
    if (!biz) return res.status(404).json({ error: 'Service not found' });
    res.json({ services: biz.services });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function updateServices(req, res) {
  try {
    const { tenantId } = req.params;
    const { services } = req.body;
    if (!Array.isArray(services)) return res.status(400).json({ error: 'services must be an array' });
    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId }, { $set: { services } }, { new: true },
    ).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ services: biz.services });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function deleteService(req, res) {
  try {
    const { tenantId } = req.params;
    const serviceId   = req.params.serviceId;
    const serviceName = req.params.serviceName;
    if (serviceId) {
      await BusinessConfig.updateOne({ tenantId }, { $pull: { services: { _id: serviceId } } });
    } else if (serviceName) {
      await BusinessConfig.updateOne({ tenantId }, { $pull: { services: { name: serviceName } } });
    } else {
      return res.status(400).json({ error: 'serviceId or serviceName required' });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function getModeInfo(req, res) {
  const { mode } = req.query;
  const fakeBiz = { businessMode: mode || 'RESTAURANT' };
  const cfg = getModeConfig(fakeBiz);
  res.json({ mode: cfg.businessMode, flows: cfg.flows, steps: cfg.steps, ui: cfg.ui });
}

export async function listSupportedModes(_req, res) {
  res.json({ modes: getSupportedModes() });
}
