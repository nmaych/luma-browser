import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Removes a directory tree. Bulk recursive deletes are blocked by some
 * environments (and can fail on Windows when a file is briefly locked), so a
 * failed recursive attempt falls back to deleting leaf entries one by one.
 */
export function removeTree(target) {
  let stats;
  try {
    stats = statSync(target);
  } catch {
    return true; // Already gone.
  }
  if (!stats.isDirectory()) {
    try {
      rmSync(target, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  const recursive = () => {
    rmSync(target, { recursive: true, force: true });
    return true;
  };
  try {
    return recursive();
  } catch {
    // Fall through to per-entry deletion below.
  }

  let removedAll = true;
  let entries = [];
  try {
    entries = readdirSync(target);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!removeTree(join(target, entry))) removedAll = false;
  }
  try {
    rmSync(target, { recursive: false, force: true });
  } catch {
    return false;
  }
  return removedAll;
}

/** Keeps only the current version's installer and its unpacked folder. */
export function cleanPortableBuilds(root, currentVersion) {
  const releaseRoot = join(root, 'release');
  const removed = [];
  const failed = [];

  const drop = (versionRoot, names) => {
    for (const name of names) {
      const target = join(versionRoot, name);
      let exists = true;
      try {
        statSync(target);
      } catch {
        exists = false;
      }
      if (!exists) continue;
      if (removeTree(target)) removed.push(target);
      else failed.push(target);
    }
  };

  // Older builds wrote the unpacked app directly into release/.
  drop(releaseRoot, ['win-unpacked', 'win-unpacked.tmp']);

  let versions = [];
  try {
    versions = readdirSync(releaseRoot, { withFileTypes: true });
  } catch {
    return { removed, failed };
  }
  for (const entry of versions) {
    if (!entry.isDirectory() || !/^\d+\.\d+\.\d+$/.test(entry.name)) continue;
    if (entry.name === currentVersion) {
      // Keep this build's win-unpacked folder; verify-packaged.mjs and --dir use it.
      drop(join(releaseRoot, entry.name), ['win-unpacked.tmp']);
      continue;
    }
    drop(join(releaseRoot, entry.name), ['win-unpacked', 'win-unpacked.tmp']);
  }
  return { removed, failed };
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const { removed, failed } = cleanPortableBuilds(root, version);
  for (const target of removed) console.log(`[clean] removed ${target}`);
  if (failed.length > 0) {
    console.warn('[clean] kept (files may be locked):');
    for (const target of failed) console.warn(`  ${target}`);
    process.exitCode = 1;
  } else {
    console.log(`[clean] ${removed.length} portable folder(s) removed; ${version} kept.`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
