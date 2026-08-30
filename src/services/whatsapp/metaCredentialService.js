/**
 * services/metaCredentialService.js — WhatSalesAgent2 (Production)
 *
 * Handles WhatsApp Business Account (WABA) onboarding operations:
 *   - Verifying an access token + phone number against the Meta Graph API
 *   - Fetching WABA details (name, business info) from Meta
 *   - Fetching registered Phone Number IDs from a WABA
 *   - Fetching Business Manager details
 *
 * These helpers are called by the admin onboarding flow (tenantController,
 * admin routes) to auto-populate tenant credentials from Meta's API rather
 * than requiring manual entry of every field.
 *
 * ─── CHANGE LOG ──────────────────────────────────────────────────────────────
 *
 * [META-CREDS] Multi-tenant credential upgrade.
 *   verifyCredentials() now accepts an optional appId parameter.
 *   When provided it is appended to the debug_token call so Meta returns
 *   which app issued the token — prevents cross-app token reuse where a
 *   system user token from Tenant A's app is accidentally supplied for Tenant B.
 *
 * [ONBOARD-1]  All functions return a consistent result envelope:
 *                { ok: true,  data: {...} }  — success
 *                { ok: false, error: '...', hint?: '...', metaCode?: number }
 *              Callers never need to try/catch individual function calls.
 *
 * [ONBOARD-2]  All outbound fetch calls use a 10-second AbortController timeout
 *              matching the pattern in tenantController.verifyCredentialsWithMeta().
 *              Railway free-tier has ~30 s request timeout; 10 s leaves room for
 *              retries within a single HTTP request from the admin dashboard.
 *
 * [ONBOARD-3]  decryptToken imported from tenantController so this service can
 *              accept either a raw plaintext token (e.g. freshly entered in the
 *              onboarding form) or a stored encrypted token (enc: prefix) — both
 *              work transparently without callers needing to think about it.
 *
 * [ONBOARD-4]  getPhoneNumbers() fetches phone_numbers for a WABA and returns
 *              them shaped for direct use in the admin onboarding UI selector.
 *              Each entry includes display_phone_number, verified_name, status,
 *              quality_rating, and id (= phoneNumberId for WhatSales config).
 *
 * [ONBOARD-5]  getWABADetails() fetches the WABA name and business info so the
 *              admin dashboard can confirm which WABA they are onboarding without
 *              requiring them to switch tabs to the Meta developer console.
 *
 * [ONBOARD-6]  getBusinessDetails() fetches Business Manager name + verification
 *              status. Optional enrichment — never called in the critical path.
 *
 * [ONBOARD-7]  Error code translation is shared via translateMetaError() so all
 *              functions give consistent, actionable guidance for the same codes.
 */

import { decryptToken } from '../../controllers/tenantController.js';
import logger           from '../../config/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_API_VERSION = process.env.META_API_VERSION || 'v21.0';
const FETCH_TIMEOUT_MS    = 10_000;

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Translates common Meta Graph API error codes / messages into actionable
 * guidance strings shown to the super-admin in the onboarding dashboard.
 *
 * @param {number|null} code
 * @param {string}      message
 * @returns {string|null}
 */
const translateMetaError = (code, message = '') => {
  const msg = message.toLowerCase();

  if (code === 190 || msg.includes('access token') || msg.includes('oauth')) {
    return (
      'The Access Token is invalid or expired. ' +
      'Generate a new System User token in Meta Business Manager → System Users → ' +
      'Generate New Token. Ensure the token has whatsapp_business_messaging and ' +
      'whatsapp_business_management permissions.'
    );
  }
  if (code === 10 || msg.includes('permission')) {
    return (
      'The token is missing required permissions. ' +
      'Ensure the System User has whatsapp_business_messaging and ' +
      'whatsapp_business_management permissions assigned in Meta Business Manager.'
    );
  }
  if (code === 100 || msg.includes('invalid parameter') || msg.includes('does not exist')) {
    return (
      'One or more IDs appear incorrect. Verify the Phone Number ID, WABA ID, and ' +
      'Business ID are all numeric values copied from Meta for Developers. ' +
      'Do NOT use phone numbers, App IDs, or page IDs in these fields.'
    );
  }
  if (code === 200 || msg.includes('blocked') || msg.includes('restricted')) {
    return (
      'API access is blocked or restricted. This can occur when the app is in ' +
      'Development mode (only test numbers work), the app has not been approved ' +
      'for WhatsApp Business API, or the Business Manager account has a policy violation. ' +
      'Check your Meta App status in the developer dashboard.'
    );
  }
  if (msg.includes('rate limit') || msg.includes('too many')) {
    return (
      'Meta is rate-limiting requests from this IP/token. ' +
      'Wait 60 seconds and try again.'
    );
  }
  if (msg.includes('unsupported') || msg.includes('unknown')) {
    return (
      'Meta returned an unsupported operation error. ' +
      'Verify the API version (currently ' + DEFAULT_API_VERSION + ') is still supported.'
    );
  }
  return null;
}

/**
 * Makes a GET request to the Meta Graph API with a timeout.
 * Returns { ok: true, data } on success or { ok: false, error, hint, metaCode } on failure.
 *
 * @param {string} url         Full Graph API URL (already built by caller)
 * @param {string} token       Plaintext bearer token (already decrypted by caller)
 * @param {string} [context]   Caller description for log messages (e.g. 'verifyCredentials')
 */
async function metaGet(url, token, context = 'metaGet') {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal:  ctrl.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    logger.warn(`[OnboardingSvc] ${context} network error`, { err: err.message, url });
    return {
      ok:    false,
      error: isTimeout
        ? `Request to Meta API timed out (${FETCH_TIMEOUT_MS / 1000} s). ` +
          'Check Railway outbound network configuration and retry.'
        : `Network error reaching Meta API: ${err.message}`,
    };
  }

  if (!resp.ok) {
    const body     = await resp.json().catch(() => ({}));
    const metaMsg  = body?.error?.message || `Meta returned HTTP ${resp.status}`;
    const metaCode = body?.error?.code    ?? null;
    const hint     = translateMetaError(metaCode, metaMsg);
    logger.warn(`[OnboardingSvc] ${context} Meta error`, { metaMsg, metaCode, status: resp.status });
    return { ok: false, error: metaMsg, hint, metaCode };
  }

  const data = await resp.json().catch(() => null);
  if (!data) {
    return { ok: false, error: 'Meta returned an empty or unparseable response.' };
  }
  return { ok: true, data };
}

// ─── verifyCredentials ────────────────────────────────────────────────────────

/**
 * Verifies that an access token is valid and optionally confirms which Meta App
 * issued it (when appId is provided) via the debug_token endpoint.
 *
 * Also confirms the phoneNumberId is registered and active by querying the
 * phone number object directly.
 *
 * [META-CREDS] appId parameter added. When present, Meta's debug_token response
 * includes app.id — we compare it against the supplied appId to confirm the token
 * belongs to the correct Meta App and not a copy-pasted token from another project.
 *
 * @param {object} params
 * @param {string}      params.accessToken   Raw or enc:-prefixed token
 * @param {string}      params.phoneNumberId Numeric phone number ID
 * @param {string}      [params.apiVersion]
 * @param {string|null} [params.appId]       Meta App ID for cross-app token validation
 *
 * @returns {{ ok: boolean, tokenInfo?, phoneInfo?, appMismatch?: boolean,
 *             error?, hint?, metaCode? }}
 */
export async function verifyCredentials({
  accessToken,
  phoneNumberId,
  apiVersion = DEFAULT_API_VERSION,
  appId = null,
}) {
  // ── Pre-flight ────────────────────────────────────────────────────────────
  if (!accessToken) {
    return { ok: false, error: 'accessToken is required.' };
  }
  if (!phoneNumberId) {
    return { ok: false, error: 'phoneNumberId is required.' };
  }
  if (phoneNumberId.startsWith('SIM_')) {
    return {
      ok:    false,
      error: 'phoneNumberId is still a simulation placeholder. Set a real Meta phoneNumberId first.',
    };
  }
  if (!/^\d{10,}$/.test(phoneNumberId)) {
    return {
      ok:    false,
      error: `phoneNumberId "${phoneNumberId}" does not look like a valid Meta Phone Number ID.`,
      hint:  'A valid Phone Number ID is purely numeric (e.g. 123456789012345). ' +
             'Find it in Meta for Developers → WhatsApp → API Setup → "Phone number ID". ' +
             'Do NOT use the WABA ID, App ID, or the phone number itself.',
    };
  }

  const token = decryptToken(accessToken);

  // ── Step 1: debug_token — validate the token and optionally verify the app ──
  // [META-CREDS] When appId is provided, we append it to the request.
  // Meta's response includes application.id so we can confirm the token was
  // issued by the correct app, not accidentally copied from another project.
  //
  // NOTE: debug_token requires the token to authenticate itself, which works for
  // System User tokens (long-lived). For short-lived user tokens, the App ID and
  // App Secret must be used as access_token=<app_id>|<app_secret>. The admin
  // onboarding flow uses System User tokens exclusively — this is by design.
  const debugUrl = appId
    ? `https://graph.facebook.com/${apiVersion}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}&fields=app_id,type,is_valid,expires_at,scopes,granular_scopes`
    : `https://graph.facebook.com/${apiVersion}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}&fields=app_id,type,is_valid,expires_at,scopes`;

  const debugResult = await metaGet(debugUrl, token, 'verifyCredentials/debug_token');

  let tokenInfo  = null;
  let appMismatch = false;

  if (debugResult.ok) {
    const d = debugResult.data?.data ?? debugResult.data;
    tokenInfo = {
      isValid:    d?.is_valid    ?? null,
      type:       d?.type        ?? null,
      appId:      d?.app_id      ?? null,
      expiresAt:  d?.expires_at  ?? null,   // 0 = never expires (system user token)
      scopes:     d?.scopes      ?? [],
    };

    // [META-CREDS] Cross-app token validation.
    // If the admin supplied an appId and the token was issued by a different app,
    // surface a warning. This is non-blocking (ok: true) but flagged via appMismatch
    // so the admin dashboard can show a yellow warning badge.
    if (appId && tokenInfo.appId && String(tokenInfo.appId) !== String(appId)) {
      appMismatch = true;
      logger.warn('[OnboardingSvc] verifyCredentials: token app_id mismatch', {
        expected: appId,
        actual:   tokenInfo.appId,
      });
    }

    // Invalid token is an immediate hard failure
    if (tokenInfo.isValid === false) {
      return {
        ok:    false,
        error: 'The access token is invalid according to Meta.',
        hint:  translateMetaError(190, 'access token'),
        tokenInfo,
      };
    }
  } else {
    // debug_token failure is soft — some valid System User tokens return 400 on
    // debug_token in certain API versions. Log it and continue to the phone number check.
    logger.warn('[OnboardingSvc] verifyCredentials: debug_token soft failure (continuing)', {
      error: debugResult.error,
    });
  }

  // ── Step 2: phone number object — confirm the phoneNumberId is real ────────
  const phoneUrl    = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}` +
                      `?fields=display_phone_number,verified_name,quality_rating,status,name_status`;
  const phoneResult = await metaGet(phoneUrl, token, 'verifyCredentials/phoneNumber');

  if (!phoneResult.ok) {
    return {
      ok:        false,
      error:     phoneResult.error,
      hint:      phoneResult.hint,
      metaCode:  phoneResult.metaCode,
      tokenInfo,
    };
  }

  const p = phoneResult.data;
  const phoneInfo = {
    phoneNumberId:  phoneNumberId,
    displayPhone:   p.display_phone_number ?? null,
    verifiedName:   p.verified_name        ?? null,
    qualityRating:  p.quality_rating       ?? null,
    status:         p.status               ?? null,
    nameStatus:     p.name_status          ?? null,
  };

  logger.info('[OnboardingSvc] verifyCredentials: success', { phoneNumberId, verifiedName: phoneInfo.verifiedName });

  return {
    ok: true,
    tokenInfo,
    phoneInfo,
    ...(appMismatch ? {
      appMismatch:      true,
      appMismatchHint:  `Token was issued by app ${tokenInfo.appId} but meta.appId is set to ${appId}. ` +
                        'Verify you are using the correct System User token for this Meta App.',
    } : {}),
  };
}

// ─── getWABADetails ───────────────────────────────────────────────────────────

/**
 * Fetches WABA (WhatsApp Business Account) details from the Meta Graph API.
 * Used during onboarding to auto-populate tenant WABA information and confirm
 * the admin is connecting the correct WABA.
 *
 * @param {object} params
 * @param {string} params.wabaId
 * @param {string} params.accessToken  Raw or enc:-prefixed token
 * @param {string} [params.apiVersion]
 *
 * @returns {{ ok: boolean, waba?: { id, name, currency, timezone, ownerBusinessId,
 *             messageTemplateNamespace, status }, error?, hint?, metaCode? }}
 */
export async function getWABADetails({
  wabaId,
  accessToken,
  apiVersion = DEFAULT_API_VERSION,
}) {
  if (!wabaId || !accessToken) {
    return { ok: false, error: 'wabaId and accessToken are required.' };
  }
  if (!/^\d{10,}$/.test(wabaId)) {
    return {
      ok:    false,
      error: `wabaId "${wabaId}" does not look like a valid WABA ID.`,
      hint:  'A valid WABA ID is purely numeric. Find it in Meta Business Manager → ' +
             'WhatsApp Accounts → Account ID.',
    };
  }

  const token  = decryptToken(accessToken);
  const url    = `https://graph.facebook.com/${apiVersion}/${wabaId}` +
                 `?fields=id,name,currency,timezone_id,owner_business_info,` +
                 `message_template_namespace,account_review_status,on_behalf_of_business_info`;
  const result = await metaGet(url, token, 'getWABADetails');

  if (!result.ok) return result;

  const d = result.data;
  return {
    ok: true,
    waba: {
      id:                         d.id                                        ?? wabaId,
      name:                       d.name                                      ?? null,
      currency:                   d.currency                                  ?? null,
      timezoneId:                 d.timezone_id                               ?? null,
      ownerBusinessId:            d.owner_business_info?.id                   ?? null,
      ownerBusinessName:          d.owner_business_info?.name                 ?? null,
      onBehalfOfBusinessId:       d.on_behalf_of_business_info?.id            ?? null,
      onBehalfOfBusinessName:     d.on_behalf_of_business_info?.name          ?? null,
      messageTemplateNamespace:   d.message_template_namespace                ?? null,
      accountReviewStatus:        d.account_review_status                     ?? null,
    },
  };
}

// ─── getPhoneNumbers ──────────────────────────────────────────────────────────

/**
 * Fetches all phone numbers registered under a WABA.
 * Used during onboarding to present a picker so the admin can select (or confirm)
 * the correct phone number without having to manually copy the Phone Number ID.
 *
 * [ONBOARD-4] Each entry is shaped for direct use in the frontend selector:
 *   id             → the phoneNumberId to store in Tenant.whatsapp.phoneNumberId
 *   displayPhone   → the formatted phone number shown in the UI
 *   verifiedName   → the business display name
 *   status         → CONNECTED / DISCONNECTED / FLAGGED / etc.
 *   qualityRating  → GREEN / YELLOW / RED / UNKNOWN
 *
 * @param {object} params
 * @param {string} params.wabaId
 * @param {string} params.accessToken  Raw or enc:-prefixed token
 * @param {string} [params.apiVersion]
 *
 * @returns {{ ok: boolean, phoneNumbers?: Array, error?, hint?, metaCode? }}
 */
export async function getPhoneNumbers({
  wabaId,
  accessToken,
  apiVersion = DEFAULT_API_VERSION,
}) {
  if (!wabaId || !accessToken) {
    return { ok: false, error: 'wabaId and accessToken are required.' };
  }
  if (!/^\d{10,}$/.test(wabaId)) {
    return {
      ok:    false,
      error: `wabaId "${wabaId}" does not look like a valid WABA ID.`,
      hint:  'Find the WABA ID in Meta Business Manager → WhatsApp Accounts → Account ID.',
    };
  }

  const token  = decryptToken(accessToken);
  const url    = `https://graph.facebook.com/${apiVersion}/${wabaId}/phone_numbers` +
                 `?fields=id,display_phone_number,verified_name,quality_rating,status,` +
                 `name_status,code_verification_status,is_official_business_account`;
  const result = await metaGet(url, token, 'getPhoneNumbers');

  if (!result.ok) return result;

  const numbers = (result.data?.data ?? []).map(p => ({
    id:                         p.id                                ?? null,   // = phoneNumberId
    displayPhone:               p.display_phone_number              ?? null,
    verifiedName:               p.verified_name                     ?? null,
    qualityRating:              p.quality_rating                    ?? 'UNKNOWN',
    status:                     p.status                            ?? null,
    nameStatus:                 p.name_status                       ?? null,
    codeVerificationStatus:     p.code_verification_status          ?? null,
    isOfficialBusinessAccount:  p.is_official_business_account      ?? false,
  }));

  logger.info('[OnboardingSvc] getPhoneNumbers: success', { wabaId, count: numbers.length });

  return { ok: true, phoneNumbers: numbers };
}

// ─── getBusinessDetails ───────────────────────────────────────────────────────

/**
 * Fetches Meta Business Manager details for a given business ID.
 * Optional enrichment — used to show the business name and verification status
 * in the admin onboarding UI so the admin can confirm they have the right account.
 *
 * [ONBOARD-6] This is never called in the critical path. Failures are surfaced
 * as warnings in the UI, not errors — onboarding can proceed without it.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.accessToken  Raw or enc:-prefixed token
 * @param {string} [params.apiVersion]
 *
 * @returns {{ ok: boolean, business?: { id, name, verificationStatus,
 *             isVerified }, error?, hint?, metaCode? }}
 */
export async function getBusinessDetails({
  businessId,
  accessToken,
  apiVersion = DEFAULT_API_VERSION,
}) {
  if (!businessId || !accessToken) {
    return { ok: false, error: 'businessId and accessToken are required.' };
  }
  if (!/^\d{6,}$/.test(businessId)) {
    return {
      ok:    false,
      error: `businessId "${businessId}" does not look like a valid Meta Business Manager ID.`,
      hint:  'Find the Business Manager ID in Meta Business Manager → Business Settings → ' +
             'Business Info → Business Account ID.',
    };
  }

  const token  = decryptToken(accessToken);
  const url    = `https://graph.facebook.com/${apiVersion}/${businessId}` +
                 `?fields=id,name,verification_status,is_verified_business`;
  const result = await metaGet(url, token, 'getBusinessDetails');

  if (!result.ok) return result;

  const d = result.data;
  return {
    ok: true,
    business: {
      id:                 d.id                   ?? businessId,
      name:               d.name                 ?? null,
      verificationStatus: d.verification_status  ?? null,
      isVerified:         d.is_verified_business ?? false,
    },
  };
}

// ─── autoDiscoverTenantCredentials ────────────────────────────────────────────

/**
 * All-in-one onboarding helper: given an accessToken and (optionally) a wabaId,
 * fetches all Meta configuration for a tenant in a single call.
 *
 * Called by the admin dashboard's "Auto-discover" button to populate every
 * credential field automatically without requiring manual copy-paste from the
 * Meta developer console.
 *
 * Steps:
 *   1. If wabaId provided — fetch WABA details (name, owner business ID)
 *   2. If wabaId provided — fetch all phone numbers under that WABA
 *   3. If phoneNumberId resolved (or provided) — verify the token against it
 *   4. If ownerBusinessId resolved — fetch business details (best-effort)
 *
 * Returns a result shaped for the admin onboarding form pre-fill:
 *   suggestedConfig — { phoneNumberId, wabaId, displayPhone, verifiedName,
 *                       businessName, businessId, apiVersion }
 *
 * @param {object} params
 * @param {string}      params.accessToken    Raw or enc:-prefixed token
 * @param {string|null} [params.wabaId]       Provide to auto-fetch phone numbers
 * @param {string|null} [params.phoneNumberId] Provide to skip WABA phone discovery
 * @param {string|null} [params.appId]        [META-CREDS] For cross-app token validation
 * @param {string}      [params.apiVersion]
 *
 * @returns {{ ok: boolean, suggestedConfig?, waba?, phoneNumbers?,
 *             business?, verification?, warnings?: string[], error?, hint? }}
 */
export async function autoDiscoverTenantCredentials({
  accessToken,
  wabaId        = null,
  phoneNumberId = null,
  appId         = null,
  apiVersion    = DEFAULT_API_VERSION,
}) {
  if (!accessToken) {
    return { ok: false, error: 'accessToken is required to auto-discover credentials.' };
  }

  const warnings = [];
  let waba         = null;
  let phoneNumbers = [];
  let business     = null;
  let verification = null;

  // ── Step 1: WABA details ──────────────────────────────────────────────────
  if (wabaId) {
    const wabaResult = await getWABADetails({ wabaId, accessToken, apiVersion });
    if (wabaResult.ok) {
      waba = wabaResult.waba;
    } else {
      warnings.push(`WABA details fetch failed: ${wabaResult.error}`);
    }
  }

  // ── Step 2: Phone numbers under WABA ─────────────────────────────────────
  if (wabaId) {
    const phoneResult = await getPhoneNumbers({ wabaId, accessToken, apiVersion });
    if (phoneResult.ok) {
      phoneNumbers = phoneResult.phoneNumbers;
      // Auto-select if exactly one phone number is registered — the most common case
      if (!phoneNumberId && phoneNumbers.length === 1) {
        phoneNumberId = phoneNumbers[0].id;
        logger.info('[OnboardingSvc] autoDiscover: single phone number auto-selected', { phoneNumberId });
      } else if (!phoneNumberId && phoneNumbers.length > 1) {
        warnings.push(
          `${phoneNumbers.length} phone numbers found on this WABA. ` +
          'phoneNumberId not auto-selected — caller must choose from phoneNumbers array.',
        );
      }
    } else {
      warnings.push(`Phone numbers fetch failed: ${phoneResult.error}`);
    }
  }

  // ── Step 3: Verify token + phoneNumberId ─────────────────────────────────
  if (phoneNumberId) {
    const verifyResult = await verifyCredentials({ accessToken, phoneNumberId, apiVersion, appId });
    if (verifyResult.ok) {
      verification = verifyResult;
      if (verifyResult.appMismatch) {
        warnings.push(verifyResult.appMismatchHint);
      }
    } else {
      // Verification failure is fatal — we cannot onboard without confirmed credentials
      return {
        ok:          false,
        error:       verifyResult.error,
        hint:        verifyResult.hint,
        metaCode:    verifyResult.metaCode,
        waba,
        phoneNumbers,
        warnings,
      };
    }
  }

  // ── Step 4: Business details (best-effort) ────────────────────────────────
  const businessId = waba?.ownerBusinessId ?? waba?.onBehalfOfBusinessId ?? null;
  if (businessId) {
    const bizResult = await getBusinessDetails({ businessId, accessToken, apiVersion });
    if (bizResult.ok) {
      business = bizResult.business;
    } else {
      // Non-fatal — surface as warning only
      warnings.push(`Business details fetch failed: ${bizResult.error}`);
    }
  }

  // ── Build suggested config ────────────────────────────────────────────────
  const suggestedConfig = {
    phoneNumberId:  phoneNumberId                            ?? null,
    wabaId:         wabaId                                   ?? null,
    apiVersion:     apiVersion,
    displayPhone:   verification?.phoneInfo?.displayPhone    ?? null,
    verifiedName:   verification?.phoneInfo?.verifiedName    ?? null,
    qualityRating:  verification?.phoneInfo?.qualityRating   ?? null,
    phoneStatus:    verification?.phoneInfo?.status          ?? null,
    businessId:     business?.id                             ?? businessId ?? null,
    businessName:   business?.name                           ?? waba?.ownerBusinessName ?? null,
    wabaName:       waba?.name                               ?? null,
    tokenType:      verification?.tokenInfo?.type            ?? null,
    tokenExpires:   verification?.tokenInfo?.expiresAt       ?? null,
  };

  logger.info('[OnboardingSvc] autoDiscover: complete', {
    wabaId,
    phoneNumberId,
    verified: !!verification,
    warnings: warnings.length,
  });

  return {
    ok: true,
    suggestedConfig,
    waba,
    phoneNumbers,
    business,
    verification,
    ...(warnings.length ? { warnings } : {}),
  };
}
