#!/usr/bin/env node

/**
 * Modernize service files to use ES6+ arrow function syntax
 * Converts: export function name() {} → export const name = () => {}
 * Converts: function name() {} → const name = () => {}
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const modernizeFile = (filePath) => {
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  // Convert: export function name(params) { ... }
  // to: export const name = (params) => { ... }
  content = content.replace(/export\s+function\s+(\w+)\s*\(([^)]*)\)\s*\{/g, (match, name, params) => {
    const cleanParams = params.trim();
    return `export const ${name} = (${cleanParams}) => {`;
  });

  // Convert: function name(params) { ... }
  // to: const name = (params) => { ... }
  content = content.replace(/(\n|\r\n)([ \t]*)function\s+(\w+)\s*\(([^)]*)\)\s*\{/g, (match, nl, indent, name, params) => {
    const cleanParams = params.trim();
    return `${nl}${indent}const ${name} = (${cleanParams}) => {`;
  });

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✓ Modernized: ${path.relative(__dirname, filePath)}`);
    return true;
  }
  return false;
};

const processDirectory = (dir) => {
  const items = fs.readdirSync(dir);
  let count = 0;

  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory() && !item.startsWith('.')) {
      count += processDirectory(fullPath);
    } else if (item.endsWith('.js') && !item.endsWith('.test.js') && !item.endsWith('.test.mjs') && !item.endsWith('modernize-services.mjs')) {
      if (modernizeFile(fullPath)) {
        count++;
      }
    }
  }

  return count;
};

const servicesDir = path.join(__dirname, 'src', 'services');
console.log(`Modernizing files in: ${servicesDir}\n`);

const filesModified = processDirectory(servicesDir);
console.log(`\n✓ Modernized ${filesModified} service files to ES6+ arrow functions`);
