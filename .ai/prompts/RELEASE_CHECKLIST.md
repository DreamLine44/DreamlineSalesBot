# prompts/RELEASE_CHECKLIST.md — Prompt template / checklist for shipping a release

Use this before deploying a batch of changes to Railway production.

---

I'm about to release a set of changes to WhatSales production. Walk through
this checklist and confirm each item, flagging anything unresolved:

## Pre-flight
- [ ] `npm test` passes locally with the full expected test count (no
      skipped/deleted tests vs. the pre-change baseline).
- [ ] Every modified file has been syntax-checked
      (`node --check <file>` or equivalent) — per
      `.ai/README.md`'s audit methodology, step 5.
- [ ] `controllers/webhookController.js`'s `WEBHOOK_BUILD_MARKER` has been
      bumped to a new, unique value if this release touches the message
      pipeline at all (see `.ai/references/RAILWAY_ENV.md`).
- [ ] Any new environment variable required by this release is documented
      and set in Railway's environment BEFORE deploy — check
      `.ai/references/RAILWAY_ENV.md` for the existing var list and
      whether `config/env.js`'s `validateEnv()` needs a new required-var
      check added for it.
- [ ] Any new Mongoose schema field/enum value has been added to the
      correct model file (Rules 1–2 in `.ai/README.md`) — grep the diff for
      new field names and cross-check against `models/`.
- [ ] Any new route respects the mount-order constraints in `app.js`
      (Rule 3) — re-read the inline ordering comments if routes were
      touched at all.
- [ ] Any new outbound message path goes through
      `core/whatsapp/dispatcher.js` (Rule 4) and respects Meta's real
      limits (`.ai/whatsapp/DISPATCHER_AND_LIMITS.md`).
- [ ] If this release changes tenant-facing behavior (new buttons, new
      flows, changed copy), does the `whatsales-frontend` dashboard need a
      corresponding update? (Separate repo — flag explicitly if so, since
      this repo's deploy alone won't cover it.)

## Deploy
- [ ] Deploy to Railway.
- [ ] `curl https://<railway-domain>/health` — confirm `webhookBuild`
      matches the value just set in step 1, and `status: 'ok'`.
- [ ] Check Railway boot logs for `[Startup] Environment warnings` and
      `[Startup] Environment validation failed` — resolve any unexpected
      new warnings/errors before considering the deploy healthy.
- [ ] Check the `[AI] Groq:` boot log line — confirm the expected AI
      provider state (live vs. mock fallback) matches intent for this
      environment.
- [ ] If `ENCRYPTION_KEY` was newly set on this deploy, re-save each
      existing tenant's WhatsApp credentials once — existing plaintext
      values do not retroactively encrypt themselves.

## Post-deploy smoke test
- [ ] Send a real (or `SIMULATION_MODE`, if testing pre-prod) test message
      through at least one representative flow per vertical touched by
      this release — confirm the full path from webhook receipt through
      dispatched reply.
- [ ] If this release touched WA Catalog, confirm at least one
      catalog-enabled tenant's `isCatalogEnabled()` check still resolves
      as expected (`.ai/modules/CATALOG.md`).
- [ ] If this release touched session TTL / humanMode logic, confirm an
      admin-takeover session still survives the expected duration
      (`.ai/business/SESSION_RULES.md`).

## Rollback plan
- [ ] Confirm the previous Railway deployment is available to roll back to
      if the smoke test fails.
- [ ] Note any data migration in this release that would NOT be
      automatically reversible by a code rollback alone (e.g. a schema
      migration script run via `scripts/migrate_*.js`) — flag this
      explicitly before deploying.
