/**
 * scripts/setup.js — DreamLine SalesBot v23.0
 *
 * First-time setup wizard. Run with: node scripts/setup.js
 * Or: npm run setup
 *
 * This script:
 *  1. Checks Node.js version (>=18 required)
 *  2. Copies .env.example → .env.development.local (if not exists)
 *  3. Generates random keys (SUPER_ADMIN_API_KEY, SIMULATION_SECRET)
 *  4. Verifies package.json dependencies are installed
 *  5. Prints next steps
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const BOLD  = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED   = '\x1b[31m';
const CYAN  = '\x1b[36m';
const RESET = '\x1b[0m';

function log(msg, color = RESET) { console.log(color + msg + RESET); }
function ok(msg)   { log('  ✓ ' + msg, GREEN); }
function warn(msg) { log('  ⚠ ' + msg, YELLOW); }
function err(msg)  { log('  ✗ ' + msg, RED); }
function info(msg) { log('  → ' + msg, CYAN); }
function heading(msg) { log('\n' + BOLD + msg + RESET); }

// ── 1. Node version check ────────────────────────────────────────────────────
heading('Checking Node.js version...');
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  err(`Node.js 18+ required. You have ${process.version}. Download at https://nodejs.org`);
  process.exit(1);
}
ok(`Node.js ${process.version} — compatible`);

// ── 2. .env file setup ───────────────────────────────────────────────────────
heading('Setting up environment file...');
const envExample = path.join(ROOT, '.env.example');
const envTarget  = path.join(ROOT, '.env.development.local');

if (!existsSync(envExample)) {
  err('.env.example not found — please restore it from the repository');
  process.exit(1);
}

if (existsSync(envTarget)) {
  ok('.env.development.local already exists — skipping');
} else {
  let envContent = readFileSync(envExample, 'utf8');

  // Auto-generate secure keys
  const adminKey = randomBytes(32).toString('hex');
  const simKey   = randomBytes(16).toString('hex');
  const encKey   = randomBytes(32).toString('hex');

  envContent = envContent
    .replace('your_super_admin_key_here', adminKey)
    .replace('sim_dev_key_change_in_production', 'sim_' + simKey)
    .replace(/^ENCRYPTION_KEY=$/m, `ENCRYPTION_KEY=${encKey}`);

  writeFileSync(envTarget, envContent, 'utf8');
  ok(`.env.development.local created with auto-generated keys`);
  info(`SUPER_ADMIN_API_KEY = ${adminKey.slice(0, 8)}... (saved to .env.development.local)`);
  warn('Keep your .env.development.local file PRIVATE — never commit it to git');
}

// ── 3. Check node_modules ────────────────────────────────────────────────────
heading('Checking dependencies...');
const nodeModules = path.join(ROOT, 'node_modules');
if (!existsSync(nodeModules)) {
  info('node_modules not found — running npm install...');
  try {
    execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
    ok('npm install completed');
  } catch {
    err('npm install failed — check the error above');
    process.exit(1);
  }
} else {
  ok('node_modules found — dependencies already installed');

  // Check for new packages not in node_modules
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const missing = Object.keys(allDeps).filter(dep => {
    try {
      const modPath = path.join(nodeModules, dep);
      return !existsSync(modPath);
    } catch { return true; }
  });

  if (missing.length > 0) {
    warn(`Missing packages detected: ${missing.join(', ')}`);
    info('Running npm install to add them...');
    try {
      execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
      ok('npm install completed — all packages installed');
    } catch {
      err('npm install failed');
      process.exit(1);
    }
  } else {
    ok('All required packages are installed');
  }
}

// ── 4. Check OpenAI / Groq key ───────────────────────────────────────────────
heading('Checking AI provider configuration...');
const envContent = readFileSync(envTarget, 'utf8');
const hasOpenAI  = /^OPENAI_API_KEY=sk-/.test(envContent.split('\n').find(l => l.startsWith('OPENAI_API_KEY=')) || '');
const hasGroq    = /^GROQ_API_KEY=gsk_/.test(envContent.split('\n').find(l => l.startsWith('GROQ_API_KEY=')) || '');

if (hasOpenAI) {
  ok('OPENAI_API_KEY configured (primary AI provider)');
} else {
  warn('OPENAI_API_KEY not set — add your OpenAI key to .env.development.local');
  info('Get an API key at: https://platform.openai.com/api-keys');
}

if (hasGroq) {
  ok('GROQ_API_KEY configured (fallback AI provider)');
} else {
  warn('GROQ_API_KEY not set — Groq fallback will be disabled');
  info('Get a free Groq key at: https://console.groq.com');
}

if (!hasOpenAI && !hasGroq) {
  warn('No AI provider configured — bot will use deterministic replies only');
  warn('Add at least OPENAI_API_KEY to enable intelligent conversations');
}

// ── 5. MongoDB check ─────────────────────────────────────────────────────────
heading('Checking MongoDB configuration...');
const mongoLine = envContent.split('\n').find(l => l.startsWith('MONGODB_URI=')) || '';
const mongoUri  = mongoLine.replace('MONGODB_URI=', '').trim();
if (mongoUri && !mongoUri.includes('your-') && mongoUri !== '') {
  ok(`MongoDB URI configured: ${mongoUri.replace(/\/\/[^@]+@/, '//***@')}`);
} else {
  warn('MONGODB_URI uses default localhost — ensure MongoDB is running');
  info('For cloud DB: get a free cluster at https://www.mongodb.com/cloud/atlas');
}

// ── 6. Print next steps ──────────────────────────────────────────────────────
log('\n' + '═'.repeat(60), BOLD);
log(BOLD + GREEN + '  DreamLine SalesBot v23.0 — Setup Complete!' + RESET);
log('═'.repeat(60), BOLD);

log('\n' + BOLD + 'NEXT STEPS:' + RESET);
log('\n1. Edit your environment file:');
info('  code .env.development.local   # VS Code');
info('  nano .env.development.local   # terminal');

log('\n2. Set your AI provider key (required for intelligent replies):');
info('  OPENAI_API_KEY=sk-your-key   # https://platform.openai.com/api-keys');

log('\n3. Start MongoDB (if running locally):');
info('  mongod                         # or use MongoDB Atlas cloud');

log('\n4. Start the bot in development mode:');
info('  npm run dev                    # auto-restart on file changes');

log('\n5. Test the bot locally (simulation mode is ON by default):');
info('  curl -X POST http://localhost:5000/api/messages \\');
info('    -H "Content-Type: application/json" \\');
info('    -H "x-sim-key: YOUR_SIMULATION_SECRET" \\');
info('    -d \'{"userId":"test_001","message":"Hello"}\'');

log('\n6. View available test businesses:');
info('  curl http://localhost:5000/api/businesses -H "x-sim-key: YOUR_SIM_KEY"');

log('\n7. Seed demo data (optional):');
info('  npm run seed');

log('\n' + BOLD + 'TESTING FLOW (Phase 2):' + RESET);
info('  Phase 1: Backend engine ✓ (already built)');
info('  Phase 2: POST /api/messages simulation ✓ (this)');
info('  Phase 3: Perfect conversation logic locally');
info('  Phase 4: Build admin dashboard');
info('  Phase 5: Connect Meta WhatsApp Cloud API (last step)');

log('\n' + YELLOW + 'NOTE: Meta WhatsApp integration should only be added after');
log('local testing is complete. See docs/INTEGRATION_GUIDE.md' + RESET);
log('');
