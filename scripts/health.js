/**
 * scripts/health.js — WhatSalesAgent2
 *
 * Cross-platform health check (replaces the old Unix-only curl pipe).
 * Works on Windows, macOS, and Linux.
 *
 * Usage:
 *   npm run health
 *   npm run health -- --port 3000    (custom port)
 */

const portArg = process.argv.find(a => a.startsWith('--port='));
const PORT    = portArg ? portArg.split('=')[1] : (process.env.PORT || 5000);
const URL     = `http://localhost:${PORT}/health`;

console.log(`\nChecking ${URL} ...\n`);

fetch(URL, { signal: AbortSignal.timeout(5000) })
  .then(res => res.json())
  .then(data => {
    console.log('✅  Server is healthy:\n');
    console.log(JSON.stringify(data, null, 2));
    console.log('');
    process.exit(0);
  })
  .catch(err => {
    console.error(`❌  Server is not reachable on port ${PORT}`);
    console.error(`    Error: ${err.message}`);
    console.error('\n    Make sure the server is running:  npm run dev\n');
    process.exit(1);
  });
