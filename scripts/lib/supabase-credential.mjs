// Reads Mason's Supabase Management API token, in memory only, from Windows Credential Manager
// (generic target `Supabase CLI:supabase`, where the Supabase CLI keeps it). The value is never
// printed, logged or written to disk, and no error message includes it. Approved uses: applying
// reviewed migrations, the read-only db-invariant sweeps, the read-only ledger drift check
// (scripts/check-migration-drift.mjs), the read-only schema-registry refresh, and
// the rolled-back live smoke chains (`npm run smoke:live`)
// (docs/manual/SERVICES_AND_ACCOUNTS.md).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const CREDENTIAL_TARGET = 'Supabase CLI:supabase';
const TOKEN_RE = /^sbp_[A-Za-z0-9_]{20,}$/;

/** Credential Manager blob (base64) → token. Errors never include the value. */
export function decodeTokenBlob(base64) {
  const bytes = Buffer.from(base64.trim(), 'base64');
  for (const encoding of ['utf8', 'utf16le']) {
    let value = bytes.toString(encoding).replace(/\0+$/, '').trim();
    if (value.startsWith('go-keyring-base64:')) {
      value = Buffer.from(value.slice('go-keyring-base64:'.length), 'base64').toString('utf8').trim();
    }
    if (TOKEN_RE.test(value)) return value;
  }
  throw new Error(`The ${CREDENTIAL_TARGET} credential is not a Supabase access token.`);
}

export function readCredentialToken() {
  if (process.platform !== 'win32') throw new Error('The token lives in Windows Credential Manager; run this on Mason\'s PC.');
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    'using System; using System.Runtime.InteropServices;',
    'public static class CrxCred {',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);',
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);',
    '}',
    "'@",
    '$p = [IntPtr]::Zero',
    `if (-not [CrxCred]::CredReadW('${CREDENTIAL_TARGET}', 1, 0, [ref]$p)) { exit 3 }`,
    'try {',
    // 64-bit CREDENTIALW: CredentialBlobSize at offset 32, CredentialBlob pointer at 40.
    '  $n = [Runtime.InteropServices.Marshal]::ReadInt32($p, 32)',
    '  $b = [Runtime.InteropServices.Marshal]::ReadIntPtr($p, 40)',
    '  $bytes = New-Object byte[] $n',
    '  [Runtime.InteropServices.Marshal]::Copy($b, $bytes, 0, $n)',
    '  [Console]::Out.Write([Convert]::ToBase64String($bytes))',
    '} finally { [CrxCred]::CredFree($p) }',
  ].join('\n');
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // -EncodedCommand: piping a script to `-Command -` returned zero bytes (2026-11-01).
  const res = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0 || !res.stdout) throw new Error(`Could not read the ${CREDENTIAL_TARGET} credential (exit ${res.status}).`);
  return decodeTokenBlob(res.stdout);
}
