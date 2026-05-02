# WhatsBotLyn — Merge & Audit Notes

**Date:** 2026-05-02  
**Source A:** `WhatsBotLyn_final.zip` (v5.0 baseline)  
**Source B:** `WhatsBotLyn_fixed_v2.zip` (v5.1 patches, newer timestamps)

## Merge Strategy

`final/` was used as the base. All files that differed between the two zips
were taken from `fixed_v2/` since they carry later timestamps and targeted bug fixes.

### Files updated from fixed_v2

| File | Change summary |
|------|---------------|
| `controllers/ordersController.js` | Minor fix (5 bytes) |
| `controllers/tenantController.js` | Expanded fixes (571 bytes larger) |
| `controllers/webhookController.js` | Large patch (212 bytes larger) |
| `models/Session.js` | loopCount / stepHistory / SALON_BOOKING comment cleanup |
| `services/brainService.js` | No size change — patch was in-place |
| `services/flowService.js` | 467 bytes of fixes |
| `services/sessionService.js` | 59 bytes of fixes |

## Audit Fixes Applied

1. **`.gitignore` created** — was missing entirely. Prevents `.env.*.local` files
   (which contain API keys) from being accidentally committed to version control.

2. **`.env.development.local.example` and `.env.production.local.example` restored**  
   — Dotfiles were silently skipped by the initial `cp -r`. Both files are now present.

3. **`models/Session.js` stale comment fixed**  
   — JSDoc said "SALON_BOOKING added" but the enum only contains `ORDER` and `BOOKING`.
   `SALON_BOOKING` is never set by any service. Comment updated to reflect reality.

## No Issues Found

- All `import`/`export` names match between callers and providers.
- `dispatch()` guards against `null` UI — no silent message drops.
- `fast-levenshtein` is in `dependencies` and used correctly.
- `groqService` uses native Node 18+ `fetch` — no extra SDK package needed.
- `GROQ_API_KEY` absence is handled gracefully (degrades to static fallback).
- `authMiddleware` uses `timingSafeEqual` for all key comparisons — no timing attacks.
- `ProcessedMessage` atomic dedup prevents race-condition duplicate messages.
- `errorHandler` never exposes stack traces in production.
- Rate limiter uses `standardHeaders: true, legacyHeaders: false` — RFC-compliant.
- All business routes are correctly scoped to `req.tenant._id`.
