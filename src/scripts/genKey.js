/**
 * scripts/genKey.js — WhatSalesAgent2
 * Generates SUPER_ADMIN_API_KEY and ENCRYPTION_KEY values.
 * Usage: npm run gen-key
 */
import crypto from 'crypto';

const adminKey      = crypto.randomBytes(32).toString('hex');       // 64 hex chars
const encryptionKey = crypto.randomBytes(16).toString('hex');       // 32 hex chars

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  WhatSalesAgent2 — Generated Keys');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('  Copy these into your .env file:\n');
console.log(`  SUPER_ADMIN_API_KEY=${adminKey}`);
console.log(`  ENCRYPTION_KEY=${encryptionKey}`);
console.log('\n  ⚠️  Save these somewhere safe — they cannot be recovered.');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
