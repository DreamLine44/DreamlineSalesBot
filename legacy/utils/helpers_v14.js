'use strict';

const config = require('../config/businessConfig');

/**
 * Format a number as currency.
 * e.g. 175 → "D175" or "GMD 175.00"
 */
function formatCurrency(amount) {
  return `${config.currencySymbol}${amount.toLocaleString('en-GM', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

/**
 * Generate a short, human-readable order ID.
 * e.g. "DL-2506-A3K9"
 */
function generateOrderId() {
  const now = new Date();
  const date = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `DL-${date}-${rand}`;
}

/**
 * Delay (for rate limiting).
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Truncate string to max length with ellipsis.
 */
function truncate(str, max = 60) {
  if (!str) return '';
  return str.length <= max ? str : str.substring(0, max - 1) + '…';
}

module.exports = { formatCurrency, generateOrderId, sleep, truncate };
