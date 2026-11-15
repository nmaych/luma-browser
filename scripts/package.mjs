import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanPortableBuilds } from './cleanRelease.mjs';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const directoryOnly = process.argv.includes('--dir');
const args = [
  join(root, 'node_modules', 'electron-builder', 'cli.js'),
  '--win',
  directoryOnly ? '--dir' : 'nsis',
  '--x64',
  `--config.directories.output=release/${version}`,
];

const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) throw result.error;
if (result.status === 0) {
  const { removed, failed } = cleanPortableBuilds(root, version);
  console.log(`[package] Removed ${removed.length} old portable folder(s); installers were kept.`);
  if (failed.length > 0) {
    console.warn('[package] These folders are still in use and were kept:');
    for (const target of failed) console.warn(`  ${target}`);
  }
}
process.exit(result.status ?? 1);
