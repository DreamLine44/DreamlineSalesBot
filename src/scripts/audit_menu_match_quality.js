/**
 * scripts/audit_menu_match_quality.js
 *
 * [FIX-SILENT-ORDER-MISS companion] Read-only diagnostic.
 *
 * WHY:
 *   The direct-order matcher (cartMessageParser.js parseNaturalOrderMessage /
 *   parseMultiItemMessage, and matchEngine.js findBestMatch) only resolves a
 *   customer's typed product name to a cart line if it fuzzy-matches an
 *   AVAILABLE entry in business.menuItems with HIGH confidence. When a tenant's
 *   menu data has near-duplicate names ("Yassa Chicken" vs "Chicken Yassa"),
 *   an item marked unavailable that customers still see referenced elsewhere
 *   (old broadcasts, WA Catalog cache, word of mouth), or a name too short/
 *   generic to fuzzy-match confidently, a perfectly reasonable customer
 *   message like "two plates of Yassa Chicken" can silently fail to match —
 *   which is the root data-level cause behind the SELECT_ITEM loop bug in
 *   orderFlow.js (now surfaced with an explicit message instead of a silent
 *   loop, but the underlying data issue should still be fixed at the source).
 *
 * WHAT IT DOES (READ-ONLY — never writes anything):
 *   For every tenant (or one tenant via --tenant=<tenantId>):
 *     1. Flags menuItems with no name, or a name < 3 chars (can't be reliably
 *        matched — same floor the matcher itself uses).
 *     2. Flags near-duplicate names within the same tenant (Levenshtein
 *        distance <= 2, or one name's words are a reordering of another's —
 *        catches "Yassa Chicken" vs "Chicken Yassa").
 *     3. Flags items marked unavailable (available === false) alongside an
 *        available item with a near-identical name — the classic "renamed
 *        the live item but left the old stub around" mistake.
 *     4. Flags exact-duplicate names (two entries, same normalised name) —
 *        the matcher's exactItem lookup picks whichever Mongo returns first,
 *        which is non-deterministic if they differ in price/availability.
 *
 * USAGE:
 *   MONGODB_URI=... node -r dotenv/config src/scripts/audit_menu_match_quality.js
 *   MONGODB_URI=... node -r dotenv/config src/scripts/audit_menu_match_quality.js --tenant=<tenantId>
 *   MONGODB_URI=... node -r dotenv/config src/scripts/audit_menu_match_quality.js --json   (machine-readable output)
 */

import { config } from 'dotenv';
config({ path: '.env' });

import mongoose from 'mongoose';
import levenshtein from 'fast-levenshtein';

const MONGODB_URI = process.env.MONGODB_URI;
const TENANT_ARG = process.argv.find(a => a.startsWith('--tenant='));
const ONLY_TENANT = TENANT_ARG ? TENANT_ARG.split('=')[1] : null;
const JSON_OUTPUT = process.argv.includes('--json');

if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI not set');
  process.exit(1);
}

const businessSchema = new mongoose.Schema({}, { strict: false, collection: 'businessconfigs' });

const norm = (s = '') => String(s).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
const sortedWords = (s = '') => norm(s).split(' ').filter(Boolean).sort().join(' ');

function auditTenantMenu(tenant) {
  const menu = Array.isArray(tenant.menuItems) ? tenant.menuItems : [];
  const issues = [];

  // 1. Missing / too-short names
  menu.forEach((item, i) => {
    const name = String(item?.name || '').trim();
    if (!name) {
      issues.push({ type: 'MISSING_NAME', detail: `menuItems[${i}] has no name`, items: [item?._id || `index ${i}`] });
    } else if (name.length < 3) {
      issues.push({ type: 'NAME_TOO_SHORT', detail: `"${name}" is under 3 chars — matchEngine.js can't reliably fuzzy-match it`, items: [name] });
    }
  });

  const named = menu.filter(i => i?.name && String(i.name).trim().length >= 3);

  // 2 & 4. Near-duplicate / exact-duplicate / word-order-swapped names
  for (let a = 0; a < named.length; a++) {
    for (let b = a + 1; b < named.length; b++) {
      const nameA = named[a].name, nameB = named[b].name;
      const normA = norm(nameA), normB = norm(nameB);
      if (normA === normB) {
        issues.push({
          type: 'EXACT_DUPLICATE_NAME',
          detail: `"${nameA}" and "${nameB}" normalise to the same name — matcher's exact lookup is non-deterministic between them`,
          items: [nameA, nameB],
        });
        continue;
      }
      if (sortedWords(nameA) === sortedWords(nameB)) {
        issues.push({
          type: 'WORD_ORDER_DUPLICATE',
          detail: `"${nameA}" and "${nameB}" contain the same words in a different order — a customer typing either phrasing may fail to match the other`,
          items: [nameA, nameB],
        });
        continue;
      }
      const dist = levenshtein.get(normA, normB);
      if (dist <= 2 && Math.min(normA.length, normB.length) > 4) {
        issues.push({
          type: 'NEAR_DUPLICATE_NAME',
          detail: `"${nameA}" and "${nameB}" differ by only ${dist} character${dist === 1 ? '' : 's'} — likely a typo/rename split`,
          items: [nameA, nameB],
        });
      }
    }
  }

  // 3. Unavailable item shadowing an available near-identical one
  const unavailable = named.filter(i => i.available === false);
  const available = named.filter(i => i.available !== false);
  for (const u of unavailable) {
    for (const av of available) {
      if (norm(u.name) === norm(av.name)) continue; // exact dup already caught above
      const dist = levenshtein.get(norm(u.name), norm(av.name));
      if (dist <= 2 && Math.min(norm(u.name).length, norm(av.name).length) > 4) {
        issues.push({
          type: 'STALE_UNAVAILABLE_SHADOW',
          detail: `Unavailable item "${u.name}" closely matches available item "${av.name}" — a customer referencing the old name may get "couldn't match" instead of ordering the live item`,
          items: [u.name, av.name],
        });
      }
    }
  }

  return issues;
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  if (!JSON_OUTPUT) console.log(`Connected to MongoDB (read-only audit — no writes)\n`);

  const BusinessConfig = mongoose.model('BusinessConfigMenuAudit', businessSchema);
  const query = ONLY_TENANT ? { tenantId: ONLY_TENANT } : {};
  const tenants = await BusinessConfig.find(query)
    .select('_id tenantId name menuItems')
    .lean();

  const report = [];
  for (const tenant of tenants) {
    const issues = auditTenantMenu(tenant);
    if (issues.length) {
      report.push({
        tenantId: tenant.tenantId,
        businessName: tenant.name || '(unnamed)',
        menuItemCount: (tenant.menuItems || []).length,
        issues,
      });
    }
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Checked ${tenants.length} tenant(s). ${report.length} tenant(s) have menu data quality issues:\n`);
    for (const t of report) {
      console.log(`━━━ ${t.businessName} (tenantId: ${t.tenantId}) — ${t.menuItemCount} menu items ━━━`);
      for (const issue of t.issues) {
        console.log(`  [${issue.type}] ${issue.detail}`);
      }
      console.log('');
    }
    if (!report.length) console.log('No issues found. ✓');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('✗ Audit failed:', err.message);
  process.exit(1);
});
