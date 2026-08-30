/**
 * services/usageService.js
 *
 * [AUDIT-FIX-USAGE-1] Tenant.usage.messagesThisMonth and Tenant.limits (plan
 * caps) have existed in models/Tenant.js since early in this project, but
 * nothing anywhere in the codebase ever wrote to usage.messagesThisMonth or
 * read it back — the field was pure dead schema. A tenant on the FREE plan
 * could send unlimited messages with no visibility into where they stood
 * against their plan, and the dashboard had no usage/plan widget to show —
 * a standard, expected feature on any SaaS tenant-facing site. This service
 * wires the schema up: increments on every genuine inbound customer message
 * (called fire-and-forget from webhookController, never blocks message
 * processing) and exposes a read helper for the dashboard overview.
 *
 * Deliberately NOT enforcing the cap here (i.e. not blocking messages once
 * over limit) — turning off a paying tenant's live bot because of a usage
 * counter is a product/billing decision, not something to bake in silently
 * as a side effect of an audit pass. This only tracks and reports; whether
 * to gate on it is a separate decision for later.
 */
import Tenant from '../models/Tenant.js';
import logger from '../config/logger.js';

/** True if `resetDate` falls in a different calendar month than `now`. */
const isPastResetWindow = (resetDate, now) => {
  if (!resetDate) return true;
  const r = new Date(resetDate);
  return r.getFullYear() !== now.getFullYear() || r.getMonth() !== now.getMonth();
}

/**
 * Increment usage.messagesThisMonth for a tenant, auto-resetting to 1 if the
 * stored resetDate has rolled into a new calendar month. Fire-and-forget —
 * callers should never await this in a way that could delay message delivery,
 * and errors are swallowed here (also caught defensively) so a usage-tracking
 * failure can never break the actual customer-facing conversation.
 */
export async function incrementTenantUsage(tenantId) {
  try {
    const now    = new Date();
    const tenant = await Tenant.findById(tenantId).select('usage.resetDate').lean();
    if (!tenant) return;

    if (isPastResetWindow(tenant.usage?.resetDate, now)) {
      await Tenant.updateOne(
        { _id: tenantId },
        { $set: { 'usage.messagesThisMonth': 1, 'usage.resetDate': now } },
      );
    } else {
      await Tenant.updateOne(
        { _id: tenantId },
        { $inc: { 'usage.messagesThisMonth': 1 } },
      );
    }
  } catch (err) {
    logger.debug('[UsageService] incrementTenantUsage failed (non-fatal)', { tenantId, err: err.message });
  }
}

/**
 * Read-only usage summary for the dashboard overview. Reports the CURRENT
 * count as stored — does not itself trigger a reset (that only happens on
 * the next incrementTenantUsage call), so a tenant who hasn't received a
 * message yet this month will still see last month's number until their
 * next inbound message rolls it over. This is a display nuance, not a
 * correctness bug: the counter is always accurate as of the last message.
 */
export async function getTenantUsageSummary(tenantId) {
  const tenant = await Tenant.findById(tenantId).select('plan limits usage').lean();
  if (!tenant) return null;
  return {
    plan:   tenant.plan || 'FREE',
    limits: tenant.limits || { messagesPerMonth: 500, maxMenuItems: 10, maxAdmins: 1 },
    usage:  {
      messagesThisMonth: tenant.usage?.messagesThisMonth || 0,
      resetDate:         tenant.usage?.resetDate || null,
    },
  };
}
