// tests/uncaughtExceptionNoExit.test.mjs
//
// Regression test for [AUDIT-FIX-CRASH-1] in app.js.
//
// Bug found: process.on('uncaughtException', ...) called process.exit(1).
// On this single-process, multi-tenant Railway deployment, that means ANY
// single uncaught exception — anywhere in the process, not necessarily in
// webhook request handling — killed the bot for EVERY tenant's customers
// until Railway noticed the crash and restarted the container. Any webhook
// in flight at that moment (e.g. a customer tapping "Confirm Order") gets no
// reply and no automatic retry.
//
// webhookController.js already wraps essentially all per-message processing
// in its own try/catch (receiveWebhook's inner catch around
// handleIncomingMessage), so an exception escaping all the way to this
// top-level handler is almost always something isolated — a background job,
// a rarely-hit edge case — not corrupted shared state that makes continuing
// unsafe. Logging loudly and staying up keeps the platform serving every
// OTHER tenant instead of a full outage over one bad edge case.
//
// This is a source-text guard, not a live invocation — app.js calls
// validateEnv() and connects to Mongo at import time, which is not safe to
// exercise in this sandbox (same rationale as this codebase's other
// infrastructure-level guard tests, e.g. groqHours.test.mjs).
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('app.js: uncaughtException handler logs but does not process.exit', () => {
  const src = read('../app.js');
  const start = src.indexOf("process.on('uncaughtException'");
  assert.ok(start !== -1, "process.on('uncaughtException', ...) handler not found");

  // Slice to the matching close of this handler's callback — up to the next
  // top-level statement (`start()` call that boots the app) is a safe bound.
  const end = src.indexOf('start()', start);
  const body = src.slice(start, end === -1 ? start + 1200 : end);

  assert.match(body, /logger\.error/, 'uncaughtException handler must still log loudly');
  assert.doesNotMatch(
    body,
    /process\.exit/,
    'uncaughtException must NOT call process.exit — that takes down every tenant for one isolated error'
  );
});

test('app.js: unhandledRejection handler also does not process.exit (unchanged baseline)', () => {
  const src = read('../app.js');
  const start = src.indexOf("process.on('unhandledRejection'");
  assert.ok(start !== -1, "process.on('unhandledRejection', ...) handler not found");
  const end = src.indexOf("process.on('uncaughtException'", start);
  const body = src.slice(start, end === -1 ? start + 400 : end);

  assert.doesNotMatch(body, /process\.exit/, 'unhandledRejection must not exit the process either');
});

test('app.js: SIGTERM/SIGINT still trigger a real graceful shutdown (this fix must not touch that path)', () => {
  const src = read('../app.js');
  assert.match(src, /process\.on\('SIGTERM',\s*\(\)\s*=>\s*gracefulShutdown\('SIGTERM'\)\)/);
  assert.match(src, /process\.on\('SIGINT',\s*\(\)\s*=>\s*gracefulShutdown\('SIGINT'\)\)/);
  assert.match(src, /async function gracefulShutdown/);
});
