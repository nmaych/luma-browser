import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanPortableBuilds } from './cleanRelease.mjs';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const directoryOnly = process.argv.includes('--dir');
const outputDir = join(root, 'release', version);

/**
 * Publishes a SHA256 manifest next to the installer, the same way vendors list
 * checksums for a download. Release notes and the update feed both quote it, so
 * a mirror or a partially cached download can be verified by hand.
 */
function writeChecksums(directory) {
  try {
    const files = readdirSync(directory)
      .filter((name) => /\.(exe|blockmap|yml)$/i.test(name) && name !== 'builder-debug.yml')
      .filter((name) => statSync(join(directory, name)).isFile())
      .sort();
    const lines = files.map((name) => {
      const digest = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex').toUpperCase();
      return `${digest}  ${name}`;
    });
    writeFileSync(join(directory, 'checksums.txt'), `${lines.join('\n')}\n`, 'utf8');
    console.log(`[package] Wrote checksums.txt for ${files.length} artifact(s).`);
  } catch (error) {
    console.warn(`[package] Could not write checksums.txt: ${error.message}`);
  }
}
const args = [
  join(root, 'node_modules', 'electron-builder', 'cli.js'),
  '--win',
  directoryOnly ? '--dir' : 'nsis',
  '--x64',
  // On CI a tag build is published implicitly by default; uploading is the
  // release workflow's job and it has no electron-builder token of its own.
  '--publish',
  'never',
  `--config.directories.output=release/${version}`,
];

const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) throw result.error;
if (result.status === 0 && !directoryOnly) {
  // Surface the signing decision instead of discovering it at download time.
  const installer = join(outputDir, `Luma-Browser-Setup-${version}-x64.exe`);
  const signing = spawnSync(process.execPath, [join(root, 'scripts', 'signing-status.mjs'), installer], {
    stdio: 'inherit',
  });
  if (signing.status !== 0) console.warn('[package] Signing check reported a problem.');
}

if (result.status === 0) {
  const { removed, failed } = cleanPortableBuilds(root, version);
  console.log(`[package] Removed ${removed.length} old portable folder(s); installers were kept.`);
  if (failed.length > 0) {
    console.warn('[package] These folders are still in use and were kept:');
    for (const target of failed) console.warn(`  ${target}`);
  }
  if (!directoryOnly) writeChecksums(outputDir);
}
process.exit(result.status ?? 1);
