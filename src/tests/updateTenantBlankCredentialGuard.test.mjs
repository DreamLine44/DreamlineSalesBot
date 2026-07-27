// tests/updateTenantBlankCredentialGuard.test.mjs
//
// Regression test for [FIX-CRED-BLANK-GUARD] in tenantController.js.
//
// Bug: the `updates` object PATCH /admin/tenants/:id builds only checked
// `!== undefined` before writing a field into `updates`. An admin-panel save
// that included e.g. `whatsapp: { accessToken: '' }` (trivial to trigger from
// a form re-submitting every field on screen, including credential fields
// the operator never touched locally) passed straight through: '' is falsy,
// so the encryption step just below skips it, and Tenant.findByIdAndUpdate's
// `$set` then silently overwrote the real, working, encrypted secret with a
// plain empty string — breaking WhatsApp sending/receiving and webhook
// signature verification for that tenant on a save that had nothing to do
// with credentials.
//
// Fix: every whatsapp.*/meta.* credential field is now only accepted into
// `updates` when it is a non-blank string after trimming — a blank value is
// treated as "not supplied," exactly like omitting the field from the
// request, mirroring the existing waCatalog.catalogId "don't send blank"
// convention already in this same function.
//
// This is a source-text guard (consistent with updateTenantCatalogIdSync.test.mjs
// for this same controller function) plus a direct exercise of the extraction
// logic in isolation, since it's a small pure loop safe to lift and re-run
// without a live Mongo/Express stack.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const src = read('../controllers/tenantController.js');

function updateTenantBody() {
  const start = src.indexOf('export async function updateTenant');
  assert.notEqual(start, -1, 'updateTenant() should exist');
  const end = src.indexOf('export async function updateTenantStatus');
  assert.notEqual(end, -1, 'updateTenantStatus() should exist (used as the end boundary)');
  return src.slice(start, end);
}

test('updateTenant(): BLANK_GUARDED_FIELDS covers every whatsapp/meta credential field', () => {
  const body = updateTenantBody();
  const idx = body.indexOf('BLANK_GUARDED_FIELDS = new Set([');
  assert.notEqual(idx, -1, 'BLANK_GUARDED_FIELDS guard must exist');
  const block = body.slice(idx, body.indexOf(']);', idx));
  for (const field of [
    'whatsapp.phoneNumberId', 'whatsapp.wabaId', 'whatsapp.accessToken',
    'whatsapp.verifyToken', 'whatsapp.webhookSecret', 'whatsapp.apiVersion',
    'meta.appId', 'meta.appSecret',
  ]) {
    assert.ok(block.includes(`'${field}'`), `${field} must be in BLANK_GUARDED_FIELDS`);
  }
});

test('updateTenant(): a blank credential value is dropped from `updates`, not passed through', () => {
  const body = updateTenantBody();
  assert.match(
    body,
    /if \(nestedVal !== undefined && !\(BLANK_GUARDED_FIELDS\.has\(field\) && isBlank\(nestedVal\)\)\)/,
    'the nested-shape branch must skip blank values for guarded fields'
  );
  assert.match(
    body,
    /if \(flatVal !== undefined && !\(BLANK_GUARDED_FIELDS\.has\(field\) && isBlank\(flatVal\)\)\)/,
    'the flat-shape branch must skip blank values for guarded fields'
  );
});

// ── Direct exercise of the extraction logic (lifted verbatim in spirit) ─────
// A minimal re-implementation mirroring updateTenant()'s field loop, run
// against representative request bodies, to prove the actual *behavior* (not
// just the presence of the guard string) is correct: blank/whitespace-only
// values for guarded fields never reach `updates`, non-blank values still do,
// and non-guarded fields (name/notes/etc.) are unaffected.
function isBlank(v) { return typeof v === 'string' && !v.trim(); }

const ALLOWED = [
  'name', 'adminPhone', 'email', 'plan', 'notes',
  'whatsapp.phone', 'whatsapp.phoneNumberId', 'whatsapp.wabaId',
  'whatsapp.accessToken', 'whatsapp.verifyToken', 'whatsapp.webhookSecret', 'whatsapp.apiVersion',
  'meta.appId', 'meta.appSecret',
  'limits.messagesPerMonth', 'limits.maxMenuItems', 'limits.maxAdmins',
];
const BLANK_GUARDED_FIELDS = new Set([
  'whatsapp.phone', 'whatsapp.phoneNumberId', 'whatsapp.wabaId',
  'whatsapp.accessToken', 'whatsapp.verifyToken', 'whatsapp.webhookSecret', 'whatsapp.apiVersion',
  'meta.appId', 'meta.appSecret',
]);

function buildUpdates(body) {
  const updates = {};
  for (const field of ALLOWED) {
    const parts = field.split('.');
    if (parts.length === 1) {
      if (body[field] !== undefined) updates[field] = body[field];
    } else {
      const [top, sub] = parts;
      const nestedVal = body[top]?.[sub];
      const flatVal   = body[field];
      if (nestedVal !== undefined && !(BLANK_GUARDED_FIELDS.has(field) && isBlank(nestedVal))) {
        updates[`${top}.${sub}`] = nestedVal;
      }
      if (flatVal !== undefined && !(BLANK_GUARDED_FIELDS.has(field) && isBlank(flatVal))) {
        updates[field] = flatVal;
      }
    }
  }
  return updates;
}

test('buildUpdates(): an empty accessToken on an unrelated save no longer overwrites the real secret', () => {
  const updates = buildUpdates({ name: 'DreamLine Restaurant', whatsapp: { accessToken: '' } });
  assert.equal(updates.name, 'DreamLine Restaurant');
  assert.equal('whatsapp.accessToken' in updates, false, 'blank accessToken must be dropped, not set to \'\'');
});

test('buildUpdates(): whitespace-only credential values are also treated as blank', () => {
  const updates = buildUpdates({ meta: { appSecret: '   ' } });
  assert.equal('meta.appSecret' in updates, false);
});

test('buildUpdates(): a real, non-blank credential value still gets written', () => {
  const updates = buildUpdates({ whatsapp: { webhookSecret: 'shhh-real-secret' } });
  assert.equal(updates['whatsapp.webhookSecret'], 'shhh-real-secret');
});

test('buildUpdates(): non-credential fields (name/notes) are unaffected — blank is still accepted there', () => {
  const updates = buildUpdates({ notes: '' });
  assert.equal(updates.notes, '', 'notes is not a credential field — clearing it is a legitimate action');
});

test('buildUpdates(): flat dotted-key shape is guarded the same as nested shape', () => {
  const updates = buildUpdates({ 'whatsapp.accessToken': '' });
  assert.equal('whatsapp.accessToken' in updates, false);
});
