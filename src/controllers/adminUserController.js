/**
 * controllers/adminUserController.js
 *
 * [FEATURE-MULTIADMIN-1] Login and staff-management endpoints for the Tenant
 * Dashboard. See models/AdminUser.js for the data model and role/status
 * semantics, services/adminAuthService.js for the crypto primitives.
 *
 * Route surface (mounted in routes/adminUserRoutes.js):
 *   POST /dashboard/auth/login                       — email+password → session token
 *   POST /dashboard/auth/accept-invite                — invite token + password → session token
 *   GET  /dashboard/auth/me                            — whoami for the current session
 *   POST /dashboard/:tenantId/admins/claim-owner       — bootstrap the FIRST admin for a
 *                                                         tenant that predates this feature,
 *                                                         authenticated via the existing
 *                                                         tenant x-api-key as proof of ownership
 *   GET  /dashboard/:tenantId/admins                   — list staff              (OWNER, MANAGER)
 *   POST /dashboard/:tenantId/admins/invite             — invite a new staff member (OWNER only)
 *   PATCH /dashboard/:tenantId/admins/:id               — change role/status     (OWNER only)
 *   DELETE /dashboard/:tenantId/admins/:id              — remove a staff member  (OWNER only)
 */
import { AdminUser, Tenant } from '../models/index.js';
import {
  hashPassword, verifyPassword,
  generateInviteToken, hashInviteToken,
  createSessionToken,
} from '../services/admin/adminAuthService.js';
import logger from '../config/logger.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days to accept an invite

// ── Login / session ──────────────────────────────────────────────────────────

export async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    // [FEATURE-MULTIADMIN-1] Email is only unique PER TENANT, not globally
    // (see AdminUser schema note) — the same person could have accounts on
    // two tenants with different passwords. Login has no tenant context yet,
    // so a single email may legitimately match multiple AdminUser docs; try
    // each until the password matches rather than assuming the first is the
    // right one. In practice this is a rare edge case (an agency managing
    // multiple businesses), but it's cheap to handle correctly.
    const candidates = await AdminUser.find({ email: String(email).toLowerCase().trim() })
      .select('+passwordHash tenantId name role status passwordSalt').lean();

    let matched = null;
    for (const candidate of candidates) {
      if (candidate.status !== 'ACTIVE') continue;
      if (verifyPassword(password, candidate.passwordSalt, candidate.passwordHash)) {
        matched = candidate;
        break;
      }
    }

    if (!matched) {
      logger.warn('[AdminAuth] Failed login attempt', { email, ip: req.ip });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const tenant = await Tenant.findById(matched.tenantId).select('status name').lean();
    if (!tenant || tenant.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'Account suspended. Contact support.' });
    }

    await AdminUser.updateOne({ _id: matched._id }, { $set: { lastLoginAt: new Date() } }).catch(() => {});

    const token = createSessionToken(matched);
    res.json({
      token,
      admin: { id: matched._id, name: matched.name, role: matched.role, email },
      tenant: { id: tenant._id, name: tenant.name },
    });
  } catch (err) {
    logger.error('[AdminAuth] login failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function me(req, res) {
  // req.adminUser is set by requireApiKey's Bearer path. A legacy x-api-key
  // caller has no individual admin identity — say so plainly rather than
  // fabricating one.
  if (!req.adminUser) {
    return res.json({ authMethod: 'api_key', tenantId: req.tenantId, isSuperAdmin: !!req.isSuperAdmin });
  }
  res.json({ authMethod: 'admin_session', ...req.adminUser, tenantId: req.tenantId });
}

// ── Self-service password change ─────────────────────────────────────────────
// [NO-SELFSERVE-PASSWORD-1] Previously there was no way for a logged-in staff/
// owner account to change their own password — only an OWNER could DISABLE and
// re-invite someone, which throws away their whole account history. Requires
// an actual Bearer session (req.adminUser); a legacy shared tenant/super-admin
// x-api-key has no individual password to change, so it's rejected with a
// clear message rather than silently no-op'ing or 500'ing on a missing user.
export async function changePassword(req, res) {
  try {
    if (!req.adminUser) {
      return res.status(400).json({
        error: 'Password change requires an individual staff login (Bearer session). '
             + 'The shared tenant API key has no password to change.',
      });
    }
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
    }

    const admin = await AdminUser.findById(req.adminUser.id)
      .select('+passwordHash passwordSalt status');
    if (!admin || admin.status !== 'ACTIVE') {
      return res.status(404).json({ error: 'Admin account not found' });
    }
    if (!verifyPassword(currentPassword, admin.passwordSalt, admin.passwordHash)) {
      logger.warn('[AdminAuth] Failed password-change attempt (bad current password)', { adminId: admin._id, ip: req.ip });
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const { salt, hash } = hashPassword(newPassword);
    admin.passwordSalt = salt;
    admin.passwordHash = hash;
    await admin.save();

    logger.info('[AdminAuth] Password changed', { adminId: admin._id, tenantId: admin.tenantId });
    res.json({ ok: true });
  } catch (err) {
    logger.error('[AdminAuth] changePassword failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ── Invite acceptance (no auth — the invite token itself is the credential) ──

export async function acceptInvite(req, res) {
  try {
    const { inviteToken, password } = req.body;
    if (!inviteToken || !password) {
      return res.status(400).json({ error: 'inviteToken and password are required' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    const tokenHash = hashInviteToken(inviteToken);
    const admin = await AdminUser.findOne({
      inviteTokenHash: tokenHash,
      status: 'INVITED',
      inviteExpiresAt: { $gt: new Date() },
    });
    if (!admin) {
      return res.status(400).json({ error: 'Invite link is invalid or has expired. Ask an owner to resend it.' });
    }

    const { salt, hash } = hashPassword(password);
    admin.passwordSalt    = salt;
    admin.passwordHash    = hash;
    admin.status          = 'ACTIVE';
    admin.inviteTokenHash = null;
    admin.inviteExpiresAt = null;
    await admin.save();

    const token = createSessionToken(admin);
    res.json({
      token,
      admin: { id: admin._id, name: admin.name, role: admin.role },
    });
  } catch (err) {
    logger.error('[AdminAuth] acceptInvite failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ── Bootstrap — one-time claim for tenants that predate this feature ────────

export async function claimOwner(req, res) {
  try {
    const { tenantId } = req.params;
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    // [FEATURE-MULTIADMIN-1] Only allowed when this tenant has NO admins yet.
    // Auth here is deliberately the EXISTING x-api-key (requireApiKey on the
    // route, super-admin or this tenant's own key) — possession of that key
    // already proves ownership under the pre-existing auth model, so this is
    // the one-time bridge from "shared key" to "named accounts" without
    // requiring a support ticket or admin intervention for every tenant that
    // existed before this feature shipped.
    const existingCount = await AdminUser.countDocuments({ tenantId });
    if (existingCount > 0) {
      return res.status(409).json({ error: 'This tenant already has admin accounts. Ask an existing OWNER to invite you instead.' });
    }

    const { salt, hash } = hashPassword(password);
    const owner = await AdminUser.create({
      tenantId, name, email: String(email).toLowerCase().trim(),
      passwordSalt: salt, passwordHash: hash,
      role: 'OWNER', status: 'ACTIVE',
    });

    const token = createSessionToken(owner);
    logger.info('[AdminAuth] Owner account claimed', { tenantId, email });
    res.status(201).json({
      token,
      admin: { id: owner._id, name: owner.name, role: owner.role },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'An admin account with this email already exists for this tenant.' });
    }
    logger.error('[AdminAuth] claimOwner failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ── Staff management (OWNER-gated via requireRole in the route definitions) ─

export async function listAdmins(req, res) {
  try {
    const { tenantId } = req.params;
    const admins = await AdminUser.find({ tenantId })
      .select('name email role status lastLoginAt createdAt').lean();
    res.json({ admins });
  } catch (err) {
    logger.error('[AdminAuth] listAdmins failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function inviteAdmin(req, res) {
  try {
    const { tenantId } = req.params;
    const { name, email, role = 'STAFF' } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
    if (!['OWNER', 'MANAGER', 'STAFF'].includes(role)) {
      return res.status(400).json({ error: 'role must be one of OWNER, MANAGER, STAFF' });
    }

    // [FEATURE-MULTIADMIN-1] Enforce Tenant.limits.maxAdmins — this field has
    // existed in the schema since before this feature but was previously
    // unenforced anywhere (same class of gap as maxMenuItems — see
    // [AUDIT-FIX-USAGE-1] in dashboardController.js).
    const [tenant, currentCount] = await Promise.all([
      Tenant.findById(tenantId).select('limits.maxAdmins').lean(),
      AdminUser.countDocuments({ tenantId, status: { $ne: 'DISABLED' } }),
    ]);
    const maxAdmins = tenant?.limits?.maxAdmins ?? 1;
    if (currentCount >= maxAdmins) {
      return res.status(403).json({
        // [NO-SELFSERVE-1] Same wording fix as the menu-item cap messages —
        // there's no self-serve billing/upgrade flow, only the platform admin
        // can raise this limit.
        error: `Admin limit reached (${currentCount}/${maxAdmins} on your current plan). `
             + `Contact your account admin to raise your plan limit, or remove an existing admin to invite a new one.`,
        limit: maxAdmins, current: currentCount,
      });
    }

    const { raw, hash } = generateInviteToken();
    const admin = await AdminUser.create({
      tenantId, name, email: String(email).toLowerCase().trim(), role,
      status: 'INVITED',
      passwordSalt: 'pending', // placeholder — required:true in schema but unused until accept-invite
      inviteTokenHash: hash,
      inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
      invitedBy: req.adminUser?.id || null,
    });

    logger.info('[AdminAuth] Admin invited', { tenantId, email, role });
    // [FEATURE-MULTIADMIN-1] The raw invite token is returned ONLY in this
    // response, never stored — whoever calls this endpoint (the frontend) is
    // responsible for delivering it to the invitee (email, WhatsApp, etc.).
    // This backend has no email-sending integration to hook into yet.
    res.status(201).json({
      admin: { id: admin._id, name: admin.name, email: admin.email, role: admin.role, status: admin.status },
      inviteToken: raw,
      inviteExpiresAt: admin.inviteExpiresAt,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'An admin account with this email already exists for this tenant.' });
    }
    logger.error('[AdminAuth] inviteAdmin failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function updateAdmin(req, res) {
  try {
    const { tenantId, id } = req.params;
    const { role, status } = req.body;
    const updates = {};
    if (role) {
      if (!['OWNER', 'MANAGER', 'STAFF'].includes(role)) {
        return res.status(400).json({ error: 'role must be one of OWNER, MANAGER, STAFF' });
      }
      updates.role = role;
    }
    if (status) {
      if (!['ACTIVE', 'DISABLED'].includes(status)) {
        return res.status(400).json({ error: 'status must be ACTIVE or DISABLED (cannot manually set INVITED)' });
      }
      updates.status = status;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

    // [FEATURE-MULTIADMIN-1] Prevent a tenant from locking themselves out —
    // refuse to demote/disable the LAST active OWNER.
    if ((updates.role && updates.role !== 'OWNER') || updates.status === 'DISABLED') {
      const target = await AdminUser.findOne({ _id: id, tenantId }).lean();
      if (target?.role === 'OWNER') {
        const otherActiveOwners = await AdminUser.countDocuments({
          tenantId, role: 'OWNER', status: 'ACTIVE', _id: { $ne: id },
        });
        if (otherActiveOwners === 0) {
          return res.status(409).json({ error: 'Cannot remove the last active OWNER for this tenant.' });
        }
      }
    }

    const admin = await AdminUser.findOneAndUpdate(
      { _id: id, tenantId }, { $set: updates }, { new: true },
    ).select('name email role status');
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    res.json({ admin });
  } catch (err) {
    logger.error('[AdminAuth] updateAdmin failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function removeAdmin(req, res) {
  try {
    const { tenantId, id } = req.params;
    const target = await AdminUser.findOne({ _id: id, tenantId }).lean();
    if (!target) return res.status(404).json({ error: 'Admin not found' });

    if (target.role === 'OWNER') {
      const otherActiveOwners = await AdminUser.countDocuments({
        tenantId, role: 'OWNER', status: 'ACTIVE', _id: { $ne: id },
      });
      if (otherActiveOwners === 0) {
        return res.status(409).json({ error: 'Cannot remove the last active OWNER for this tenant.' });
      }
    }

    await AdminUser.deleteOne({ _id: id, tenantId });
    logger.info('[AdminAuth] Admin removed', { tenantId, id });
    res.json({ ok: true });
  } catch (err) {
    logger.error('[AdminAuth] removeAdmin failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

