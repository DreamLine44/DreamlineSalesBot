/**
 * utils/formatCurrency.js
 *
 * [AUDIT-FIX-CURRENCY-1] Every money display across the app (cart summaries,
 * order totals, admin alerts, payment prompts — 50+ call sites in
 * core/shared/cartEngine.js and the module flows/uiBuilders that consume it)
 * was interpolating raw numbers with zero thousands-separator formatting:
 * `${currency}${amount}` → "GMD1045". Once a cart total crosses 1,000 that
 * reads as a single unbroken digit run, which is exactly the kind of thing
 * customers misread (is that 1045 or 10450?). formatMoney() below is the
 * single shared formatter — added here (utils/, alongside itemLabel.js and
 * parseQuantity.js, the other pure formatting/parsing helpers already used
 * by cartEngine.js) so every caller renders totals identically.
 *
 * Only touches DISPLAY strings. Anywhere a total is computed or compared
 * (cartTotal(), resolveOrderFields(), Order.totalPrice, etc.) still works
 * with the raw Number — formatMoney() is called only at the last step,
 * right before a number is interpolated into customer/admin-facing text.
 */

/**
 * formatMoney(amount)
 * → "1,045" for 1045, "150" for 150, "1,234.50" for 1234.5, "" for
 *   null/undefined/NaN (so `${formatMoney(x)}` degrades to an empty string
 *   rather than the literal text "NaN" when a caller forgets to guard).
 */
export function formatMoney(amount) {
  if (amount === null || amount === undefined) return '';
  const num = Number(amount);
  if (Number.isNaN(num)) return '';
  // toLocaleString adds thousands separators; maxFractionDigits keeps
  // whole-number prices (the overwhelming common case) free of a
  // trailing ".00" while still showing cents when the price actually has them.
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
