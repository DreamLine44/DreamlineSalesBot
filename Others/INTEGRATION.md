# WhatSales Onboarding Module — Integration Guide

## Overview

This document describes the **only two changes** needed to the existing codebase
to integrate the onboarding module. Every other file in this PR is a brand-new
addition.

---

## 1. `src/models/Tenant.js` — Add `connectedAt` field

**Why:** `markConnected()` in the onboarding service stamps `whatsapp.connectedAt`
the first time a tenant connects. The existing schema has `connected`, `tokenUpdatedAt`,
and `lastVerifiedAt` but is missing `connectedAt`. Without it, Mongoose silently
discards the value on the `$set`.

**Change (additive — append inside the `whatsapp` subdocument only):**

```diff
  // ================= WHATSAPP CREDENTIALS =================
  whatsapp: {
    ...
    tokenUpdatedAt: {
      type: Date,
      default: null
    },
+
+   // Stamped by the onboarding service on first successful credential verification
+   connectedAt: {
+     type: Date,
+     default: null
+   },
+
+   // Updated by testTenantWhatsAppConnection on every successful verify
+   lastVerifiedAt: {
+     type: Date,
+     default: null
+   },
  },
```

> **Note:** If `lastVerifiedAt` is already present in your schema, skip that
> part of the diff. Add only what is missing.

---

## 2. `src/app.js` — Mount the onboarding router

**Why:** The router must be registered once so Express dispatches requests to it.
This is a 2-line addition: one import, one `app.use()`.

**Add after the existing route imports** (around line 35–40):

```diff
  import adminRoutes from './routes/adminRoutes.js';
+ import whatsappOnboardingRoutes from './routes/whatsappOnboardingRoutes.js';
```

**Add after the existing `/admin` mount** (around line 70–75):

```diff
  app.use('/admin', adminLimiter, requireApiKey, adminRoutes);
+
+ // ── WhatsApp Onboarding (isolated module) ─────────────────────────────────
+ // Handles both /api/whatsapp/* (tenant) and /admin/whatsapp/* (super-admin).
+ // Rate-limited via adminLimiter; auth enforced per-route inside the router.
+ app.use('/', adminLimiter, whatsappOnboardingRoutes);
```

That is the complete integration. No other existing file requires modification.

---

## New Files Created

| File | Purpose |
|------|---------|
| `src/models/WhatsAppConnectionRequest.js` | MongoDB schema for onboarding requests |
| `src/middleware/onboardingValidation.js` | Request body validators (no external deps) |
| `src/services/whatsappNotificationService.js` | Status-change notification dispatcher |
| `src/services/whatsappOnboardingService.js` | Core business logic (credentials, verify, connect) |
| `src/controllers/whatsappOnboardingController.js` | 7 HTTP handlers |
| `src/routes/whatsappOnboardingRoutes.js` | Route definitions + middleware wiring |

---

## Environment Variables (no new ones required)

The onboarding module reuses:

| Variable | Used For |
|----------|---------|
| `SUPER_ADMIN_API_KEY` | Admin route authentication (already exists) |

Optional additions you may want to set later:

| Variable | Purpose |
|----------|---------|
| `SUPER_ADMIN_EMAIL` | Recipient for new-request admin alerts (stub ready in notificationService) |

---

## API Reference

### Tenant Endpoints

#### `POST /api/whatsapp/request`
Submit a new WhatsApp connection request.

**Auth:** `x-api-key: <tenant-api-key>`

**Body:**
```json
{
  "businessName":     "Akara Kitchen",
  "businessCategory": "Restaurant",
  "whatsappNumber":   "+220xxxxxxx",
  "contactPerson":    "Fatou Diallo",
  "contactEmail":     "fatou@akarakitchen.gm",
  "notes":            "We serve breakfast and lunch daily"
}
```

**Response 201:**
```json
{
  "message":   "Connection request submitted successfully. Our team will contact you shortly.",
  "requestId": "665f1a2b3c4d5e6f7a8b9c0d",
  "status":    "pending"
}
```

**Response 409** (duplicate request):
```json
{
  "error":     "A connection request already exists for this tenant",
  "status":    "contacted",
  "requestId": "665f1a2b3c4d5e6f7a8b9c0d"
}
```

---

#### `GET /api/whatsapp/request/status`
Poll the status of the tenant's latest connection request.

**Auth:** `x-api-key: <tenant-api-key>`

**Response 200:**
```json
{
  "request": {
    "id":             "665f1a2b3c4d5e6f7a8b9c0d",
    "businessName":   "Akara Kitchen",
    "whatsappNumber": "+220xxxxxxx",
    "status":         "connecting",
    "submittedAt":    "2025-06-01T10:00:00.000Z",
    "lastUpdated":    "2025-06-01T11:30:00.000Z"
  },
  "whatsappConnected": false,
  "connectedAt":       null
}
```

---

### Admin Endpoints

All admin endpoints require: `x-api-key: <SUPER_ADMIN_API_KEY>`

---

#### `GET /admin/whatsapp/requests`
List all requests (paginated).

**Query params:** `?status=pending&page=1&limit=20`

**Response 200:**
```json
{
  "requests": [ ... ],
  "total": 42,
  "page":  1,
  "pages": 3,
  "limit": 20
}
```

---

#### `GET /admin/whatsapp/requests/:id`
Full request detail including `adminNotes`.

---

#### `PATCH /admin/whatsapp/requests/:id/status`
Update request status.

**Body:**
```json
{
  "status":     "contacted",
  "adminNotes": "Called Fatou, will send Meta setup guide"
}
```

**Valid statuses:** `pending` → `contacted` → `connecting` → `connected` | `rejected`

---

#### `POST /admin/whatsapp/connect/:tenantId`
Save WhatsApp credentials for a tenant.

**Body:**
```json
{
  "phoneNumberId": "1234567890",
  "wabaId":        "9876543210",
  "accessToken":   "EAAxxxxxxx...",
  "verifyToken":   "my-verify-token-123",
  "apiVersion":    "v21.0",
  "verifyFirst":   true
}
```

Set `verifyFirst: true` to verify against Meta before saving (strongly recommended in production).

**Response 200:**
```json
{
  "message":      "Credentials saved and verified. Tenant is now CONNECTED.",
  "tenantId":     "665f...",
  "phoneNumberId":"1234567890",
  "verified":     true,
  "verifyDetails": {
    "displayPhoneNumber": "+220xxxxxxx",
    "verifiedName":       "Akara Kitchen",
    "phoneStatus":        "CONNECTED"
  }
}
```

---

#### `POST /admin/whatsapp/test/:tenantId`
Test a tenant's already-saved credentials. On success, tenant status → `CONNECTED`.

**Response 200:**
```json
{
  "verifyStatus": "CONNECTED",
  "message":      "Credentials verified successfully",
  "details": {
    "displayPhoneNumber": "+220xxxxxxx",
    "verifiedName":       "Akara Kitchen",
    "phoneStatus":        "CONNECTED"
  },
  "tenantId":   "665f...",
  "tenantName": "Akara Kitchen"
}
```

**Possible `verifyStatus` values:**

| Value | Meaning |
|-------|---------|
| `CONNECTED` | ✅ Credentials valid, tenant connected |
| `INVALID_TOKEN` | ❌ Access token expired or wrong |
| `INVALID_PHONE_NUMBER` | ❌ Phone Number ID not found in WABA |
| `META_ERROR` | ⚠️ Meta Graph API unreachable or unexpected error |

---

## Onboarding Workflow (Step-by-Step)

```
1.  Tenant calls POST /api/whatsapp/request
        → status: "pending"
        → Admin receives alert notification

2.  Admin reviews in GET /admin/whatsapp/requests
        → Sets status to "contacted" via PATCH

3.  Admin provisions WABA credentials in Meta Business Manager

4.  Admin saves credentials:
        POST /admin/whatsapp/connect/:tenantId  { verifyFirst: true }
        → Credentials saved + verified in one call
        → Tenant marked CONNECTED
        → Request status → "connected"
        → Tenant.status → "ACTIVE"
        → Tenant.whatsapp.connected → true
        → Existing bot immediately picks up new credentials
```

The existing bot requires NO changes. It already reads `tenant.whatsapp.*`
for every message dispatch — once `connected = true` and credentials are stored,
it works automatically.
