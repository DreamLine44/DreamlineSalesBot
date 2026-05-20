/**
 * controllers/businessController.js — WhatSalesAgent2
 */
import BusinessConfig from '../models/BusinessConfig.js';
import { getModeConfig, getSupportedModes } from '../config/modes.js';

export async function getBusinessConfig(req, res) {
  const { tenantId } = req.params;
  const biz = await BusinessConfig.findOne({ tenantId }).lean();
  if (!biz) return res.status(404).json({ error: 'Not found' });
  res.json({ business: biz });
}

export async function updateBusinessConfig(req, res) {
  const { tenantId } = req.params;
  const update = req.body;
  delete update._id; delete update.tenantId; delete update.__v;

  const biz = await BusinessConfig.findOneAndUpdate(
    { tenantId }, { $set: update }, { new: true, upsert: false },
  ).lean();
  if (!biz) return res.status(404).json({ error: 'Not found' });
  res.json({ business: biz });
}

export async function getMenu(req, res) {
  const { tenantId } = req.params;
  const biz = await BusinessConfig.findOne({ tenantId }).select('menuItems services').lean();
  if (!biz) return res.status(404).json({ error: 'Not found' });
  res.json({ menuItems: biz.menuItems || [], services: biz.services || [] });
}

export async function updateMenu(req, res) {
  const { tenantId } = req.params;
  const { menuItems } = req.body;
  if (!Array.isArray(menuItems)) return res.status(400).json({ error: 'menuItems must be an array' });

  const biz = await BusinessConfig.findOneAndUpdate(
    { tenantId }, { $set: { menuItems } }, { new: true },
  ).lean();
  res.json({ menuItems: biz.menuItems });
}

export async function addMenuItem(req, res) {
  const { tenantId } = req.params;
  const { name, price, description, category, available = true } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const biz = await BusinessConfig.findOneAndUpdate(
    { tenantId },
    { $push: { menuItems: { name, price: Number(price) || 0, description, category, available } } },
    { new: true },
  );
  res.status(201).json({ menuItems: biz.menuItems });
}

export async function deleteMenuItem(req, res) {
  const { tenantId, itemName } = req.params;
  await BusinessConfig.updateOne({ tenantId }, { $pull: { menuItems: { name: itemName } } });
  res.json({ ok: true });
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
