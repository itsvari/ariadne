/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('child_process');
const { loadEnvConfig } = require('@next/env');
const path = require('path');

// Load variables from monorepo root into process.env
loadEnvConfig(path.join(__dirname, '../../'));

const nextExecutable = path.resolve(__dirname, '../../node_modules/next/dist/bin/next');

const child = spawn(process.execPath, [nextExecutable, 'dev'], {
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
