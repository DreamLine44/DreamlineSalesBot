import rateLimit from "express-rate-limit";

// [FIX-2] Export a FACTORY, not a singleton instance.
// One shared rateLimit() instance means ALL mounted routes (/register, /business,
// /admin/tenants, /admin/messages) share a single 60-req/min counter.
// A tenant hammering /business exhausts the budget and blocks /register for new
// users and /admin/tenants for the super-admin.
// Each app.use() call now gets its own independent counter via createRateLimiter().

// [FIX-7] Use a per-tenant key when an API key is present, falling back to IP.
// Without this, multiple tenants sharing the same office IP or NAT gateway
// share a single rate-limit bucket — one chatty tenant starves everyone else.
function tenantAwareKey(req) {
  // Post-auth middleware attaches req.tenant; use its ID for isolation.
  if (req.tenant?._id) return String(req.tenant._id);
  // Pre-auth (or routes without auth): key by API key header if present.
  const apiKey = req.headers["x-api-key"];
  if (apiKey) return apiKey;
  // Final fallback: IP address (original behaviour)
  return req.ip;
}

export function createRateLimiter(max = 60) {
  return rateLimit({
    windowMs:        60 * 1000,
    max,
    keyGenerator:    tenantAwareKey,
    standardHeaders: true,
    legacyHeaders:   false,
    message: { success: false, message: "Too many requests" },
  });
}

// Default export for backward-compat (creates a fresh instance each call)
export default createRateLimiter;
