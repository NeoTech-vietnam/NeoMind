import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { exactRoot, serveHost } from '../dist/vscode-wire.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-wire-privacy-'));
  const key = createHash('sha256').update(`${userInfo().username}\0${exactRoot(root)}`).digest('hex');
  const directory = join(tmpdir(), `neomind-vscode-${key}`);
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  });
  return { root, directory };
}

function aclFacts(path) {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    "$acl=[System.IO.Directory]::GetAccessControl($env:NEOMIND_TEST_ACL_DIRECTORY); " +
    "[pscustomobject]@{ ownerIsUser=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value; " +
    "protected=$acl.AreAccessRulesProtected; foreignAllows=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | " +
    "Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $sid.Value }).Count } | ConvertTo-Json -Compress"],
  { env: { ...process.env, NEOMIND_TEST_ACL_DIRECTORY: path }, encoding: 'utf8', windowsHide: true, timeout: 10_000 }));
}

test('Windows descriptor creation replaces foreign token-default grants when temp parent has no inheritable ACEs', { skip: process.platform !== 'win32' }, t => {
  const { root } = fixture(t);
  const isolatedTemp = join(root, 'isolated-temp');
  mkdirSync(isolatedTemp);
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    '$before=[System.IO.Directory]::GetAccessControl($env:NEOMIND_TEST_ACL_DIRECTORY); $changeOwner=$before.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value; ' +
    "$acl=New-Object System.Security.AccessControl.DirectorySecurity; if($changeOwner){$acl.SetOwner($sid)}; $acl.SetAccessRuleProtection($true,$false); " +
    "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','None','None','Allow'); $acl.AddAccessRule($rule); " +
    '[System.IO.Directory]::SetAccessControl($env:NEOMIND_TEST_ACL_DIRECTORY,$acl)'],
  { env: { ...process.env, NEOMIND_TEST_ACL_DIRECTORY: isolatedTemp }, stdio: 'ignore', windowsHide: true, timeout: 10_000 });
  assert.deepEqual(aclFacts(isolatedTemp), { ownerIsUser: true, protected: true, foreignAllows: 0 });
  // A child with no inherited ACL uses its token's default DACL. Real Windows
  // tokens can include explicit SYSTEM/Admin Allows even for a non-admin user.
  execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {serveHost} from ${JSON.stringify(new URL('../dist/vscode-wire.js', import.meta.url).href)}; ` +
    'const host=await serveHost(process.env.NEOMIND_TEST_WORKSPACE,async()=>({ok:true})); await host.close();'],
  { env: { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp, NEOMIND_TEST_WORKSPACE: root }, stdio: 'pipe', windowsHide: true, timeout: 30_000 });
  const key = createHash('sha256').update(`${userInfo().username}\0${exactRoot(root)}`).digest('hex');
  assert.deepEqual(aclFacts(join(isolatedTemp, `neomind-vscode-${key}`)), { ownerIsUser: true, protected: true, foreignAllows: 0 });
});

test('Windows owner-only descriptor directory passes the production ACL verifier', { skip: process.platform !== 'win32' }, async t => {
  const { root, directory } = fixture(t);
  const host = await serveHost(root, async () => ({ ok: true }));
  try {
    assert.deepEqual(aclFacts(directory), { ownerIsUser: true, protected: true, foreignAllows: 0 },
      'Fresh descriptors must use the user SID as owner even when the Windows token defaults to an Administrators group owner');
  } finally { await host.close(); }
});

test('Windows descriptor directory with an explicit foreign Allow grant is rejected', { skip: process.platform !== 'win32' }, async t => {
  const { root, directory } = fixture(t);
  mkdirSync(directory);
  execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r',
    `${userInfo().username}:(OI)(CI)F`, '*S-1-1-0:(OI)(CI)R'],
  { stdio: 'ignore', windowsHide: true });
  await assert.rejects(serveHost(root, async () => ({ ok: true })));
  assert.equal(existsSync(join(directory, 'host.json')), false);
  assert.ok(aclFacts(directory).foreignAllows > 0, 'Reject preexisting foreign grants rather than silently taking over their directory');
});
