# WhatSalesAgent Audit — Quick Reference Summary

## Critical Issues (Require Immediate Fix)

| # | Issue | File | Lines | Impact |
|---|-------|------|-------|--------|
| 1 | Catalog order processing errors silently swallowed | webhookController.js | 1461–1480 | Orders fail invisibly, no admin alert |
| 2 | Payment proof race condition on admin double-tap | paymentService.js | 67–83 | Duplicate payment confirmations sent |
| 3 | Admin notification may fail, leaving order stuck | paymentService.js | 169–238 | Admin never sees payment proof |
| 4 | Order confirmation race with slow network | adminCommandService.js | 330–380 | Duplicate order confirmations |
| 5 | Dynamic import side effects not awaited | webhookController.js | 1431–1437 | Usage tracking fails silently |
| 6 | Session lock timeout too short (12s) | webhookController.js | 1300–1340 | Concurrent order processing race |

## High Severity (Should Fix Soon)

| # | Issue | File | Impact |
|---|-------|------|--------|
| 7 | Missing shortId null check | adminCommandService.js | Admin commands fail on corrupted orders |
| 8 | Unvalidated menuItems array length | businessController.js | DOS via large menu upload |
| 9 | NaN handling in pagination | dashboardController.js | Query returns all/no results randomly |
| 10 | Missing paymentProof index | models/Order.js | Slow recovery queries on payment proofs |
| 11 | Silent customer memory failures | customerMemory.js | Personalization/VIP detection fails |
| 12 | Unvalidated admin phone numbers | paymentService.js | Invalid Meta API calls fail silently |
| 13 | Fire-and-forget paymentReference updates (7 files) | orderFlow.js & others | Missing payment references break reminders |
| 14 | Session TTL not resetting postFlowAck | sessionService.js | Expired sessions route to wrong state |
| 15 | No retry logic in critical admin alerts | dispatcher.js | Slow Meta API timeouts lose alerts |

## Medium Severity (Plan to Fix)

| # | Issue | Impact | Recommendation |
|---|-------|--------|-----------------|
| 16 | Intl.DateTimeFormat locale variation | Business hours check may fail | Use explicit arithmetic instead |
| 17 | toLocaleString in currency display | Confusion in regional formats | Implement zero-padded formatting |
| 18 | Unvalidated RESUME BOT phone | Invalid phone strings bypass checks | Add E.164 validation |
| 19 | Missing await on session update | Retry window breaks on DB error | Verify all session updates are awaited |
| 20 | 40+ fire-and-forget admin alerts | Admins never notified of events | Add logging to all `.catch()` blocks |
| 21 | Usage tracking import not awaited | Plan limits not enforced | Move to top-level import |
| 22 | Session TTL index missing | Expired docs not cleaned up | Add TTL index to schema |
| 23 | Missing compound query indexes | Full table scans on payment queries | Add tenantId+status+createdAt indexes |
| 24 | Session $set overwrites concurrent updates | Concurrent message loss | Use $inc for all numeric counters |

## Low Severity (Nice to Have)

- #25: Dead code export `buildAdminBookingAlert()`
- #26: Inconsistent error logging levels
- #27: No webhook retry exhaustion alerting
- #28: MAX_INPUT_LENGTH=500 is too large
- #29: No rate limiting on admin commands
- #30: Potential integer overflow in messageCount

---

## By Issue Category

**Silent Error Swallowing:** 7 instances  
**Missing Null/Undefined Checks:** 4 instances  
**Race Conditions:** 3 instances  
**Unvalidated Input:** 3 instances  
**Missing Schema Declarations:** 2 instances  
**Encoding Issues:** 2 instances  
**Missing Awaits:** 2 instances  

---

## Files with Most Issues

1. **webhookController.js** — 4 critical issues (catalog orders, import side effects, session lock, admin notification)
2. **paymentService.js** — 2 critical issues (race condition, notification failure)
3. **adminCommandService.js** — 2 critical issues (shortId check, order confirmation race)
4. **orderFlow*.js** — 7 files with fire-and-forget payment reference updates
5. **models/Order.js** — Missing indexes and schema fields

---

## Immediate Actions (This Sprint)

- [ ] Verify atomic `findOneAndUpdate` in payment confirmation paths
- [ ] Add logging to all `.catch(() => {})` blocks in payment/booking flows
- [ ] Implement menuItems length validation
- [ ] Add E.164 phone validation before Meta API calls
- [ ] Increase session lock timeout from 12s to 20s
- [ ] Add database indexes for payment/booking queries
- [ ] Test payment double-tap scenario with concurrent admin taps

