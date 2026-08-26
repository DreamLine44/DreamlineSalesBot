/**
 * salonHelpers.js — shared salon/barbershop utilities without flow dependencies.
 * Kept separate from flows/index.js to avoid circular imports (flows → flowEngine
 * → postFlowHandler → modes → flows).
 */

import { formatMoney } from '../../utils/formatCurrency.js';

export function isBarbershopMode(business) {
  return (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';
}

/** Returns available bookable services — merges business.services[] and service-tagged menuItems. */
export function getSalonServices(business) {
  const menuItems = (business?.menuItems || []).filter(i => i.available !== false);
  const serviceMenuItems = menuItems.filter(i => {
    const cat = (i.category || '').toLowerCase();
    return cat === 'services' || cat === 'service';
  });

  const fromServices = (business?.services || [])
    .filter(s => s.available !== false)
    .map(s => ({
      name:        s.name,
      price:       s.price ?? null,
      duration:    s.duration ?? null,
      description: s.description || '',
      prep:        s.prep || null,
      currency:    business?.payment?.currency || 'D',
    }));

  const seen = new Set();
  const merged = [];
  for (const entry of [...fromServices, ...serviceMenuItems]) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    const key  = name?.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  if (merged.length > 0) return merged;

  if (menuItems.length > 0) return menuItems;

  return isBarbershopMode(business)
    ? [
        { name: 'Haircut',                  price: null, duration: 30 },
        { name: 'Beard Trim',               price: null, duration: 20 },
        { name: 'Shape-Up / Edge',          price: null, duration: 20 },
        { name: 'Full Service (Cut+Beard)', price: null, duration: 45 },
        { name: 'Kids Cut',                 price: null, duration: 25 },
      ]
    : [
        { name: 'Haircut & Style', price: null, duration: 45 },
        { name: 'Blow Dry',        price: null, duration: 30 },
        { name: 'Hair Colour',     price: null, duration: 90 },
        { name: 'Highlights',      price: null, duration: 120 },
        { name: 'Deep Conditioning', price: null, duration: 45 },
        { name: 'Braids / Weave',  price: null, duration: 120 },
        { name: 'Trim',            price: null, duration: 20 },
      ];
}

/** [v14-PREP] Preparation tip for a booked service. */
export function getSalonPrepTip(serviceName, business) {
  if (!serviceName) return null;
  const lowerName = serviceName.toLowerCase();

  const item = (business?.menuItems || []).find(
    i => i.name?.toLowerCase() === lowerName
  );
  if (item?.prep) return item.prep;

  const svc = (business?.services || []).find(
    s => s.name?.toLowerCase() === lowerName
  );
  if (svc?.prep) return svc.prep;

  const prepMap = business?.settings?.servicePrep;
  if (prepMap) {
    const entries = prepMap instanceof Map ? Object.fromEntries(prepMap) : prepMap;
    const matchKey = Object.keys(entries).find(k => k.toLowerCase() === lowerName);
    if (matchKey && entries[matchKey]) return entries[matchKey];
  }

  const lower = serviceName.toLowerCase();
  if (lower.includes('colour') || lower.includes('color') || lower.includes('highlight') || lower.includes('dye')) {
    return 'Please arrive with unwashed hair and avoid heat styling the day before. 💇';
  }
  if (lower.includes('keratin') || lower.includes('relaxer') || lower.includes('perm')) {
    return 'Please arrive with clean, dry hair. Avoid washing for 3 days after the treatment. 💇';
  }
  if (lower.includes('braids') || lower.includes('weave') || lower.includes('extensions')) {
    return 'Arrive with freshly washed and blow-dried hair for best results. 💇';
  }
  if (lower.includes('facial') || lower.includes('skin')) {
    return 'Please arrive with a clean face and avoid retinol products 24h before. 💆';
  }
  if (lower.includes('massage') || lower.includes('spa')) {
    return 'Please arrive 5 minutes early and wear comfortable clothing. 🧖';
  }
  return null;
}

/** Format service price + duration for list row descriptions. */
export function formatServiceMeta(s, business) {
  const price = typeof s === 'string' ? null : s.price;
  const currency = (typeof s !== 'string' && s.currency) || business?.payment?.currency || 'D';
  const priceStr = price ? `${currency}${formatMoney(price)}` : null;
  const durationStr = typeof s !== 'string' && s.duration ? `${s.duration} min` : null;
  return [priceStr, durationStr].filter(Boolean).join(' · ') || undefined;
}
