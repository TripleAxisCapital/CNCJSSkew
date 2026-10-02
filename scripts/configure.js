#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [mode, widgetPathArg] = process.argv.slice(2);
if (!['install', 'uninstall'].includes(mode)) {
  console.error('Usage: node scripts/configure.js <install|uninstall> [widgetPath]');
  process.exit(2);
}

const configPath = path.join(os.homedir(), '.cncrc');
let config = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, 'utf8').trim();
  if (raw) {
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.error(`Refusing to modify ${configPath}: it is not valid JSON.`);
      console.error(err.message);
      process.exit(1);
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(configPath, `${configPath}.cncjsskew-backup-${stamp}`);
}

const mountPoints = Array.isArray(config.mountPoints) ? config.mountPoints : [];
const filtered = mountPoints.filter(entry => entry?.route !== '/cncjs-skew');

if (mode === 'install') {
  if (!widgetPathArg) {
    console.error('Widget path is required for install.');
    process.exit(2);
  }
  const widgetPath = path.resolve(widgetPathArg);
  if (!fs.existsSync(path.join(widgetPath, 'index.html'))) {
    console.error(`Widget index not found at ${widgetPath}`);
    process.exit(1);
  }
  filtered.push({ route: '/cncjs-skew', target: widgetPath });
}

config.mountPoints = filtered;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`${mode === 'install' ? 'Configured' : 'Removed'} CNCJSSkew mount in ${configPath}`);
if (mode === 'install') console.log(`Route: /cncjs-skew -> ${path.resolve(widgetPathArg)}`);
