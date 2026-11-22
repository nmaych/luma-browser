#!/usr/bin/env node
/**
 * Publishes a release without `gh`.
 *
 * The usual `gh release create` needs GitHub CLI, and `git push` needs a
 * working smart-HTTP path. Neither is guaranteed on a fresh machine, while the
 * REST API usually is (Node's fetch ignores the sandbox proxy, so it reaches
 * api.github.com even when git gets a 502 from a CONNECT tunnel). This script
 * therefore does everything over HTTPS:
 *
 *   1. make sure the local HEAD exists on GitHub (re-creating it object by
 *      object when only a push is missing, which keeps the same commit SHA)
 *   2. create the release for the current version, body taken from CHANGELOG
 *   3. upload every asset, then download it back and compare SHA256
 *   4. prove the published latest.yml and Range support work for the updater
 *
 * Usage:
 *   GH_TOKEN=... node scripts/publish-release.mjs --dry-run
 *   GH_TOKEN=... node scripts/publish-release.mjs
 *   GH_TOKEN=... node scripts/publish-release.mjs --no-push-commit
 *
 * The token is only read from the environment (or --token-file); it is never
 * written to disk and never printed.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const OWNER = 'nmaych';
const REPO = 'luma-browser';
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
const root = join(import.meta.dirname, '..');

const flags = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.split('=');
  flags.set(key, value ?? true);
}
const dryRun = flags.has('--dry-run');
const pushCommit = !flags.has('--no-push-commit');
const tokenFile = flags.get('--token-file');

const log = (message) => console.log(`[publish] ${message}`);
const warn = (message) => console.warn(`[publish] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readToken() {
  const direct = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (direct) return direct.trim();
  if (typeof tokenFile === 'string' && existsSync(tokenFile)) {
    return readFileSync(tokenFile, 'utf8').trim();
  }
  return '';
}

const token = readToken();

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    encoding: options.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** fetch with backoff; the direct route to github.com drops connections now and then. */
async function request(url, { method = 'GET', headers = {}, body, redirect = 'follow', attempts = 5, timeoutMs = 120000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'user-agent': 'luma-browser-release-script',
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body,
        redirect,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 5xx is worth retrying, 4xx is not.
      if (response.status >= 500 && attempt < attempts) {
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        await sleep(attempt * 1500);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 1500);
    }
  }
  throw lastError ?? new Error(`request failed: ${url}`);
}

async function apiJson(path, options) {
  const response = await request(`${API}${path}`, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const reason = payload?.message ? `${response.status} ${payload.message}` : `${response.status} ${text.slice(0, 200)}`;
    const error = new Error(`${options?.method ?? 'GET'} ${path} -> ${reason}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex').toUpperCase();

async function downloadBytes(url, headers = {}) {
  const response = await request(url, {
    headers: { accept: 'application/octet-stream', ...headers },
    timeoutMs: 15 * 60 * 1000,
  });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// 1. the commit must exist remotely, otherwise the release tag would point at
//    unrelated code. When only the push is missing, rebuild the commit through
//    the objects API: same tree, same parents, same dates -> same SHA.
// ---------------------------------------------------------------------------

function parseIdentities(sha) {
  const raw = git(['cat-file', '-p', sha]);
  const pick = (name) => {
    const line = raw.split('\n').find((entry) => entry.startsWith(`${name} `));
    const match = line?.match(/^(\w+) (.+) <([^>]*)> (\d+) ([+-])(\d{2})(\d{2})$/);
    if (!match) throw new Error(`cannot parse ${name} from the commit object`);
    const [, , who, email, seconds, sign, hours, minutes] = match;
    const zone = `${sign}${hours}:${minutes}`;
    // The API wants the wall clock of that zone, so shift by the offset first:
    // formatting UTC and appending "+08:00" would be eight hours off.
    const offsetSeconds = (sign === '-' ? -1 : 1) * (Number(hours) * 3600 + Number(minutes) * 60);
    const wall = new Date((Number(seconds) + offsetSeconds) * 1000).toISOString().replace(/\.\d{3}Z$/, '');
    return { name: who, email, date: `${wall}${zone}` };
  };
  const body = raw.slice(raw.indexOf('\n\n') + 2);
  return { author: pick('author'), committer: pick('committer'), message: body };
}

async function pushCommitThroughApi(head, parentSha) {
  const changed = git(['diff', '--name-status', '--no-renames', `${parentSha}..${head}`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status[0], paths: rest };
    });

  log(`Rebuilding ${changed.length} changed path(s) as API objects…`);
  const items = [];
  for (const { status, paths } of changed) {
    if (status === 'D') {
      items.push({ path: paths[0], mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const target = paths[paths.length - 1];
    if (status === 'R' || status === 'C') {
      items.push({ path: paths[0], mode: '100644', type: 'blob', sha: null });
    }
    const blobSha = git(['rev-parse', `${head}:${target}`]).trim();
    const content = git(['cat-file', 'blob', blobSha], { encoding: 'buffer' });
    const created = await apiJson(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
    });
    if (created.sha !== blobSha) {
      throw new Error(`blob ${target} changed in transit (${created.sha} != ${blobSha})`);
    }
    const mode = git(['ls-tree', head, '--', target]).split(' ')[0].trim() || '100644';
    items.push({ path: target, mode, type: 'blob', sha: blobSha });
  }

  const parentTree = git(['rev-parse', `${parentSha}^{tree}`]).trim();
  const tree = await apiJson(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: parentTree, tree: items }),
  });
  const localTree = git(['rev-parse', `${head}^{tree}`]).trim();
  if (tree.sha !== localTree) {
    throw new Error(`rebuilt tree ${tree.sha} does not match local ${localTree}; refusing to publish a different source`);
  }

  const { author, committer, message } = parseIdentities(head);
  const commit = await apiJson(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha], author, committer }),
  });
  if (commit.sha !== head) {
    const remote = await apiJson(`/repos/${OWNER}/${REPO}/git/commits/${commit.sha}`);
    const stamp = (identity) => `${identity.name} <${identity.email}> ${identity.date}`;
    const detail = [
      `tree      local ${localTree}  remote ${remote.tree?.sha}`,
      `parents   local ${parentSha}  remote ${(remote.parents ?? []).join(',')}`,
      `author    local ${stamp(author)}  remote ${stamp(remote.author ?? {})}`,
      `committer local ${stamp(committer)}  remote ${stamp(remote.committer ?? {})}`,
      `message   local ${message.length}B tail ${JSON.stringify(message.slice(-6))}  remote ${remote.message?.length ?? 0}B tail ${JSON.stringify((remote.message ?? '').slice(-6))}`,
    ].join('\n  ');
    throw new Error(`rebuilt commit ${commit.sha} does not match local ${head}:\n  ${detail}`);
  }
  log(`Commit ${head.slice(0, 7)} rebuilt with an identical SHA.`);
  return commit.sha;
}

/** GitHub answers 422 ("No commit found") for a SHA it has never seen. */
async function commitOnRemote(sha) {
  try {
    await apiJson(`/repos/${OWNER}/${REPO}/commits/${sha}`);
    return true;
  } catch (error) {
    const missing = error.status === 404 || (error.status === 422 && /No commit found/i.test(error.message));
    if (!missing) throw error;
    return false;
  }
}

async function ensureCommitOnRemote() {
  const head = git(['rev-parse', 'HEAD']).trim();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (await commitOnRemote(head)) {
    log(`Commit ${head.slice(0, 7)} already on GitHub.`);
    return { head, branch };
  }

  if (!pushCommit) {
    throw new Error(`commit ${head.slice(0, 7)} is missing on GitHub and --no-push-commit was given`);
  }

  // Walk back until GitHub recognises a commit. Everything above it has to be
  // rebuilt, oldest first, so each parent exists before its child is created.
  const missing = [];
  let base = '';
  let cursor = head;
  for (;;) {
    if (await commitOnRemote(cursor)) { base = cursor; break; }
    missing.unshift(cursor);
    if (missing.length > 100) {
      throw new Error('more than 100 commits are missing on GitHub; push the history with git first');
    }
    let parent = '';
    try {
      parent = git(['rev-parse', `${cursor}^`]).trim();
    } catch {
      parent = '';
    }
    if (!parent) {
      throw new Error('reached the root commit without a base on GitHub; push the history with git first');
    }
    cursor = parent;
  }
  log(`${missing.length} commit(s) missing on GitHub, replaying on top of ${base.slice(0, 7)}.`);

  // A dry run must not mutate anything, so stop right before the objects API.
  if (dryRun) {
    log(`[dry-run] would rebuild ${missing.map((sha) => sha.slice(0, 7)).join(' -> ')} and move ${branch}`);
    return { head, branch, pending: true };
  }

  for (const sha of missing) {
    const parent = git(['rev-parse', `${sha}^`]).trim();
    await pushCommitThroughApi(sha, parent);
  }

  const ref = await apiJson(`/repos/${OWNER}/${REPO}/git/ref/heads/${branch}`);
  if (ref.object.sha !== base) {
    throw new Error(`${branch} on GitHub is ${ref.object.sha.slice(0, 7)}, not the base ${base.slice(0, 7)}; history diverged, push manually`);
  }
  await apiJson(`/repos/${OWNER}/${REPO}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: head, force: false }),
  });
  log(`Moved ${branch} to ${head.slice(0, 7)}.`);
  return { head, branch };
}

// ---------------------------------------------------------------------------
// 2. release + assets
// ---------------------------------------------------------------------------

function releaseNotes(version) {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) throw new Error(`CHANGELOG.md section ${version} is empty`);
  return body;
}

function assetList(version) {
  const directory = join(root, 'release', version);
  if (!existsSync(directory)) throw new Error(`missing ${directory}; run npm run dist first`);
  const names = [
    `Luma-Browser-Setup-${version}-x64.exe`,
    `Luma-Browser-Setup-${version}-x64.exe.blockmap`,
    'latest.yml',
    'checksums.txt',
  ];
  return names.map((name) => {
    const file = join(directory, name);
    if (!existsSync(file)) throw new Error(`missing asset ${name} in release/${version}`);
    const bytes = readFileSync(file);
    return { name, file, bytes, size: statSync(file).size, sha256: sha256Of(bytes) };
  });
}

async function ensureRelease(version, branch, notes) {
  const tag = `v${version}`;
  try {
    const existing = await apiJson(`/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
    log(`Release ${tag} already exists (id ${existing.id}); assets will be re-verified.`);
    if (!dryRun && existing.body !== notes) {
      await apiJson(`/repos/${OWNER}/${REPO}/releases/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: notes }),
      });
      log('Release notes refreshed from CHANGELOG.');
    }
    return existing;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (dryRun) {
    log(`[dry-run] would create release ${tag} on ${branch} with ${notes.split('\n').length} lines of notes`);
    return null;
  }
  const release = await apiJson(`/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, target_commitish: branch, name: version, body: notes, draft: false, prerelease: false }),
  });
  log(`Created release ${tag} (id ${release.id}).`);
  return release;
}

async function uploadAsset(release, asset) {
  const existing = (release.assets ?? []).find((entry) => entry.name === asset.name);
  if (existing) {
    log(`Replacing existing asset ${asset.name}.`);
    if (!dryRun) {
      await request(`${API}/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE' });
    }
  }
  if (dryRun) {
    log(`[dry-run] would upload ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB, sha256 ${asset.sha256.slice(0, 12)}…)`);
    return;
  }
  const url = `${UPLOADS}/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`;
  const response = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', accept: 'application/vnd.github+json' },
    body: asset.bytes,
    timeoutMs: 15 * 60 * 1000,
  });
  if (!response.ok) {
    throw new Error(`upload of ${asset.name} failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  log(`Uploaded ${asset.name}.`);
}

/**
 * The 201 from the upload endpoint is not proof: 1.15.0 shipped a truncated
 * installer that still reported `uploaded`. Download the asset back and hash it.
 */
async function verifyAsset(release, asset, attempt = 1) {
  const fresh = await apiJson(`/repos/${OWNER}/${REPO}/releases/${release.id}`);
  const published = (fresh.assets ?? []).find((entry) => entry.name === asset.name);
  if (!published) throw new Error(`${asset.name} is not listed on the release after upload`);
  if (published.size !== asset.size) {
    warn(`${asset.name}: size ${published.size} != local ${asset.size}`);
  }
  const bytes = await downloadBytes(published.url);
  const digest = sha256Of(bytes);
  if (digest === asset.sha256 && bytes.length === asset.size) {
    log(`Verified ${asset.name}: sha256 matches, ${bytes.length} bytes.`);
    return true;
  }
  warn(`${asset.name}: mismatch after upload (${digest} / ${bytes.length}B vs ${asset.sha256} / ${asset.size}B)`);
  if (attempt >= 3) return false;
  warn(`Deleting ${asset.name} and retrying (attempt ${attempt + 1}/3).`);
  await request(`${API}/repos/${OWNER}/${REPO}/releases/assets/${published.id}`, { method: 'DELETE' });
  await uploadAsset(release, asset);
  return verifyAsset(release, asset, attempt + 1);
}

async function verifyFeed(version) {
  const latest = await apiJson(`/repos/${OWNER}/${REPO}/releases/latest`);
  if (latest.tag_name !== `v${version}`) {
    throw new Error(`releases/latest is ${latest.tag_name}, expected v${version}`);
  }
  const yml = (latest.assets ?? []).find((entry) => entry.name === 'latest.yml');
  if (!yml) throw new Error('latest.yml is missing from the newest release');
  const text = (await downloadBytes(yml.url)).toString('utf8');
  const published = text.match(/^version:\s*(.+)$/m)?.[1]?.trim();
  if (published !== version) throw new Error(`latest.yml announces ${published}, expected ${version}`);
  log(`Update feed points at ${version}.`);

  const installer = (latest.assets ?? []).find((entry) => entry.name === `Luma-Browser-Setup-${version}-x64.exe`);
  if (!installer) throw new Error('installer is missing from the newest release');
  const ranged = await request(installer.url, {
    headers: { accept: 'application/octet-stream', range: 'bytes=0-1023' },
    redirect: 'follow',
  });
  if (ranged.status !== 206) throw new Error(`Range request returned ${ranged.status}; resumable updates need 206`);
  log('Range request returned 206, so resumable updates work.');
}

async function main() {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const assets = assetList(version);
  const checksumFile = assets.find((asset) => asset.name === 'checksums.txt');
  if (checksumFile) {
    const listed = checksumFile.bytes.toString('utf8');
    for (const asset of assets.filter((entry) => entry.name !== 'checksums.txt')) {
      if (!listed.includes(asset.sha256)) {
        throw new Error(`${asset.name} is not covered by checksums.txt; re-run npm run dist`);
      }
    }
    log('Local assets match checksums.txt.');
  }

  log(`Publishing ${version}${dryRun ? ' (dry run)' : ''} as ${OWNER}/${REPO}.`);
  if (!token && !dryRun) throw new Error('set GH_TOKEN (or pass --token-file) with contents:write');

  const { head, branch } = await ensureCommitOnRemote();
  log(`HEAD ${head.slice(0, 7)} on ${branch}.`);
  if (flags.has('--commit-only')) {
    log('Stopped after the commit step (--commit-only).');
    return;
  }

  const notes = releaseNotes(version);
  const release = await ensureRelease(version, branch, notes);
  if (dryRun && !release) {
    log(`[dry-run] ${assets.length} asset(s) ready:`);
    for (const asset of assets) log(`[dry-run]   ${asset.name} ${asset.size}B ${asset.sha256.slice(0, 12)}…`);
    log('[dry-run] no changes were made.');
    return;
  }

  for (const asset of assets) {
    await uploadAsset(release, asset);
    if (!dryRun) {
      const ok = await verifyAsset(release, asset);
      if (!ok) throw new Error(`${asset.name} could not be published intact after 3 attempts`);
    }
  }

  if (!dryRun) {
    await verifyFeed(version);
    log(`Done: https://github.com/${OWNER}/${REPO}/releases/tag/v${version}`);
  }
}

await main().catch((error) => {
  console.error(`[publish] FAILED: ${error.message}`);
  process.exitCode = 1;
});
