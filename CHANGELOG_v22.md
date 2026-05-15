# DreamLine SalesBot — v22.0 Changelog (v20 + v21 Merge)

## Overview

v22.0 is the definitive merge of `v20_definitive` and `v21` (v19+v20 merged).

**Strategy:**
- **Base**: `v20_definitive` — preferred for all services with functional additions
- **From v21**: Professional communication overhaul (messageBuilders.js, cosmetic text)
- **Package fix**: Full dependency union — `multer`, `cloudinary`, `cors`, `helmet`,
  `json2csv`, `express-rate-limit` all restored + full `devDependencies` + all npm scripts

---

## What Changed

### ✅ Package.json — Complete Dependency Fix
- Bumped to `22.0.0`
- Restored all missing deps from v20: `multer`, `cloudinary`, `cors`, `helmet`,
  `json2csv`, `express-rate-limit`
- Restored `devDependencies`: `eslint`, `nodemon`
- Restored all npm scripts: `dev`, `seed`, `gen-key`, `fix-orders`, etc.

### ✅ Files taken from v20 (more complete)
- `app.js` — graceful SIGTERM/SIGINT shutdown, MongoDB drain, httpServer ref
- `controllers/webhookController.js` — Order import, RESUME BOT, customerName preservation, track order getLabel
- `services/groqService.js` — prompt-injection sanitise(), TIMEOUT_MS 12000, fixes G-1..G-7
- `services/adminPaymentHandler.js` — RESUME BOT WhatsApp command (admin can exit human-mode from phone)
- `services/schedulerService.js` — fixes SC-1..SC-5 (batched DB, accurate date comparison, 48h window)
- `services/templateService.js` — env-overridable template names via TEMPLATE_NAME_* vars
- `services/flowService.js` — parsedDate capture, customerName/partySize on bookings
- `services/brainService.js` — "0" mid-flow → CANCEL (confirm before wiping session)
- `models/Booking.js` — parsedDate, customerName, partySize, adminConfirmedAt/By/Note, shortId
- `.env.development.local.example` — TEMPLATE_NAME_* vars included
- `README.md` — more complete

### ✅ Files taken from v21 (professional comms)
- `utils/messageBuilders.js` — professional customer-facing language
- `CHANGELOG_v21.md`, `MERGE_NOTES.md`

### ✅ Files added from v20 only (not in v21)
- `utils/sanitize.js`
- `tests/v18.test.mjs`

### ✅ Version bumped
- `version`: `22.0.0`

---

## No Migration Required

Drop-in replacement for v20 and v21. No schema changes. No new required env vars
(TEMPLATE_NAME_* are optional overrides).
