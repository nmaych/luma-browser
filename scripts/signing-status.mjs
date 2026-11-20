import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Reports how the current build will be signed.
 *
 * Luma has no certificate in the repository, so the default is an unsigned
 * build. This script makes that explicit instead of silently shipping an exe
 * that SmartScreen flags as "unknown publisher", and it tells you exactly which
 * environment variables would turn signing on.
 */

const root = path.resolve(import.meta.dirname, '..');
const exe = process.argv[2] ? path.resolve(process.argv[2]) : null;

const has = (name) => Boolean(process.env[name] && String(process.env[name]).trim());

const pfx = ['WIN_CSC_LINK', 'CSC_LINK'].find(has);
const azure = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'].every(has);

export function signingStatus() {
  if (pfx) {
    return {
      mode: 'pfx',
      detail: `certificate file from ${pfx}`,
      password: has('WIN_CSC_KEY_PASSWORD') || has('CSC_KEY_PASSWORD') ? 'set' : 'missing',
    };
  }
  if (azure) {
    return { mode: 'azure-trusted-signing', detail: 'Azure Trusted Signing credentials present' };
  }
  return { mode: 'unsigned', detail: 'no certificate configured' };
}

function describeSignature(file) {
  if (process.platform !== 'win32' || !existsSync(file)) return null;
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}').Status`,
    ], { encoding: 'utf8' }).trim();
    return output;
  } catch {
    return null;
  }
}

const status = signingStatus();
if (status.mode === 'unsigned') {
  console.log('[signing] Unsigned build: set WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD (PFX)');
  console.log('[signing] or Azure Trusted Signing variables. See docs/code-signing.md.');
} else {
  console.log(`[signing] Will sign with ${status.mode} (${status.detail})`);
  if (status.mode === 'pfx' && status.password === 'missing') {
    console.log('[signing] Warning: the certificate password is not set.');
  }
}

if (exe) {
  const state = describeSignature(exe);
  console.log(`[signing] ${path.basename(exe)}: ${state ?? 'signature state unknown'}`);
  if (status.mode === 'unsigned' && state && state !== 'NotSigned') {
    console.log('[signing] Warning: the file is signed but no credentials are configured now.');
  }
  if (status.mode !== 'unsigned' && state === 'NotSigned') {
    console.log('[signing] Warning: credentials are present but the file is NOT signed.');
    process.exitCode = 1;
  }
}
