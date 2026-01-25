#!/usr/bin/env node

// Development wrapper: runs TypeScript file with tsx
// This allows npm link to work without building first

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const tsPath = join(__dirname, 'lakehouse.ts');
const tsxPath = join(__dirname, '..', 'node_modules', '.bin', 'tsx');

// Check if tsx is available
if (!existsSync(tsxPath)) {
  console.error('Error: tsx not found. Run: npm install');
  process.exit(1);
}

// Run the TypeScript file with tsx
const child = spawn('node', [tsxPath, tsPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env
});

child.on('error', (err) => {
  console.error('Error running lakehouse:', err.message);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
