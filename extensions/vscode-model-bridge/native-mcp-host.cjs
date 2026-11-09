'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { nativeProfessionalRoles } = require('./local-delegation.cjs');

const roleSet = new Set(nativeProfessionalRoles);
const baseTools = Object.freeze({ 'WF.SWSD': ['read', 'search'], 'WF.P-RES': ['read', 'search'],
  'WF.FnD': ['read', 'search', 'edit', 'execute'], 'WF.Reviewer': ['read', 'search'], 'WF.Tester': ['read', 'search', 'execute'] });
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function stat(file) { return fs.lstatSync(file, { throwIfNoEntry: false }); }

/** Workspace-local variant profiles contain only trusted runtime instructions
 * and exact User-approved native references. They are never model-authored.
 * This host owns no MCP connection, server process, credentials or tool loop. */
function createNativeMcpHost(vscode, api, workspaceRoot, options = {}) {
  const root = fs.realpathSync.native(path.resolve(workspaceRoot)), rootHash = sha(canonical(root));
  const prepared = new WeakSet(), details = new WeakMap();
  function safe(relative, file = false) {
    const selected = path.resolve(root, relative), route = path.relative(root, selected);
    if (!route || route.startsWith(`..${path.sep}`) || route === '..' || path.isAbsolute(route)) fail('profile-unsafe-path');
    const parts = route.split(path.sep);
    for (let index = 0, current = root; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      const state = stat(current);
      if (!state) continue;
      if (state.isSymbolicLink() || index < parts.length - 1 && !state.isDirectory() ||
          index === parts.length - 1 && (file ? !state.isFile() || state.nlink !== 1 : !state.isDirectory())) fail('profile-unsafe-path');
      if (canonical(fs.realpathSync.native(current)) !== canonical(current)) fail('profile-unsafe-path');
    }
    return selected;
  }
  function ensureDirectory(relative) {
    const parts = relative.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const current = safe(parts.slice(0, index).join('/'));
      try { fs.mkdirSync(current); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
      safe(parts.slice(0, index).join('/'));
    }
  }
  function read(relative) {
    const file = safe(relative, true), before = stat(file);
    if (!before || before.size > 2 * 1024 * 1024) fail('profile-modified');
    const content = fs.readFileSync(file, 'utf8'), after = stat(file);
    safe(relative, true);
    if (!after || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        Buffer.byteLength(content) !== after.size) fail('profile-modified');
    return content;
  }
  function writeNew(relative, content) {
    const file = safe(relative, true);
    let descriptor;
    try { descriptor = fs.openSync(file, 'wx', 0o600); }
    catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
    try { fs.writeFileSync(descriptor, content, 'utf8'); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    safe(relative, true);
    if (read(relative) !== content) fail('profile-modified');
    return true;
  }
  function resolve(role, selected) {
    if (typeof api?.resolveNativeMcpCapabilities !== 'function' || typeof api?.nativeMcpCapabilitiesMatchInventory !== 'function') fail('matching-runtime-required');
    const policy = options.readApprovedConnectors?.() ?? [];
    return api.resolveNativeMcpCapabilities(policy, vscode.lm?.tools ?? [], { role, selectIds: selected });
  }
  function base(role) {
    const renderer = options.baseProfile ?? api.nativeLocalWorkerProfile;
    const original = typeof renderer === 'function' ? renderer(role) : renderer;
    if (typeof original !== 'string' || original.length > 128000) fail('base-profile-invalid');
    const text = original.replaceAll('\r\n', '\n'), header = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!header) fail('base-profile-invalid');
    const entries = new Map();
    for (const line of header[1].split('\n')) {
      const match = /^([a-z][a-z-]*): (.*)$/i.exec(line);
      if (!match || entries.has(match[1]) || !['name', 'description', 'tools', 'agents', 'user-invocable'].includes(match[1])) fail('base-profile-invalid');
      entries.set(match[1], match[2]);
    }
    try {
      if (JSON.parse(entries.get('name')) !== `${role} Worker` || entries.get('user-invocable') !== 'false' ||
          JSON.stringify(JSON.parse(entries.get('agents'))) !== '[]' || typeof JSON.parse(entries.get('description')) !== 'string' ||
          JSON.stringify(JSON.parse(entries.get('tools'))) !== JSON.stringify(baseTools[role])) fail('base-profile-invalid');
    } catch { fail('base-profile-invalid'); }
    return { text, header, tools: [...baseTools[role]] };
  }
  function publish(role, resolution) {
    const source = base(role), fingerprint = sha(JSON.stringify({ role, base_sha256: sha(source.text), capability_fingerprint: resolution.fingerprint }));
    const name = `${role} Worker MCP ${fingerprint.slice(0, 16)}`, slug = role.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const profilePath = `.github/agents/.workforce-${slug}-${fingerprint}.agent.md`;
    const receiptPath = `.workforce/native/mcp-profiles/${fingerprint}.json`;
    const references = resolution.snapshots.flatMap(snapshot => snapshot.tools.map(tool => tool.reference));
    const tools = [...new Set([...source.tools, ...references])];
    const header = source.header[1].split('\n').map(line => line.startsWith('name: ') ? `name: ${JSON.stringify(name)}` :
      line.startsWith('tools: ') ? `tools: ${JSON.stringify(tools)}` : line).join('\n');
    const text = `---\n${header}\n---\n${source.text.slice(source.header[0].length)}`;
    const profile = { name, path: profilePath, sha256: sha(text), role, tools };
    const receipt = `${JSON.stringify({ schema_version: 1, root_sha256: rootHash, fingerprint,
      capability_fingerprint: resolution.fingerprint, profile })}\n`;
    // Validate both destinations before writing either. An existing profile
    // without our exact receipt belongs to the user, even if its bytes match.
    safe(profilePath, true); safe(receiptPath, true);
    const existingProfile = stat(path.join(root, profilePath)), existingReceipt = stat(path.join(root, receiptPath));
    if (existingProfile && !existingReceipt) fail('profile-ownership-unproven');
    ensureDirectory('.github/agents'); ensureDirectory('.workforce/native/mcp-profiles');
    if (!existingReceipt) writeNew(receiptPath, receipt);
    if (read(receiptPath) !== receipt) fail('profile-receipt-modified');
    if (!existingProfile) writeNew(profilePath, text);
    if (read(profilePath) !== text) fail('profile-modified');
    return { fingerprint, profile, receiptPath, receipt, text, baseHash: sha(source.text) };
  }
  function prepare(role, connectorIds = []) {
    const selected = Array.isArray(connectorIds) ? [...connectorIds] : connectorIds;
    let resolution, published, problem, resolvable = true;
    try { resolution = resolve(role, selected); }
    catch { resolvable = false; problem = 'native-mcp-policy-unavailable'; }
    if (!resolution) {
      const body = { state: 'unavailable', role: roleSet.has(role) ? role : null, snapshots: [], unavailable: [], fallback: 'ordinary-work', reason: problem };
      resolution = { ...body, fingerprint: sha(JSON.stringify(body)) };
    }
    if (roleSet.has(role) && resolution.snapshots.length) {
      try {
        published = publish(role, resolution);
        if (!api.nativeMcpCapabilitiesMatchInventory(resolution.snapshots, vscode.lm?.tools ?? [])) fail('native-tool-inventory-changed');
      } catch (error) {
        published = undefined;
        problem = ['profile-unsafe-path', 'profile-modified', 'profile-receipt-modified', 'profile-ownership-unproven',
          'base-profile-invalid', 'native-tool-inventory-changed'].includes(error?.code) ? error.code : 'native-mcp-profile-unavailable';
      }
    }
    const observations = resolution.unavailable.map(item => ({ ...item, state: 'unavailable', fallback: 'ordinary-work' }));
    if (problem) observations.push({ state: 'unavailable', reason: problem, fallback: 'ordinary-work' });
    if (published) for (const snapshot of resolution.snapshots) observations.push({ connector_id: snapshot.connector_id,
      state: 'registered', tools: snapshot.tools.map(tool => ({ name: tool.name, reference: tool.reference })),
      ownership: 'not-observed', used: 'not-observed' });
    const binding = freeze({ role, resolution, snapshots: published ? resolution.snapshots : [],
      fingerprint: published?.fingerprint ?? resolution.fingerprint, ...(published ? { profile: published.profile } : {}),
      fallback: 'ordinary-work', observations });
    prepared.add(binding); details.set(binding, { selected, resolutionHash: resolution.fingerprint, published, resolvable });
    return binding;
  }
  function isPrepared(binding) {
    if (!binding || !prepared.has(binding)) return false;
    const own = details.get(binding);
    try {
      if (!own?.resolvable || !roleSet.has(binding.role) || resolve(binding.role, own.selected).fingerprint !== own.resolutionHash) return false;
      if (!own.published) return true;
      return api.nativeMcpCapabilitiesMatchInventory(binding.snapshots, vscode.lm?.tools ?? []) &&
        sha(base(binding.role).text) === own.published.baseHash && read(own.published.receiptPath) === own.published.receipt &&
        read(binding.profile.path) === own.published.text && sha(own.published.text) === binding.profile.sha256;
    } catch { return false; }
  }
  return Object.freeze({ prepare, isPrepared, assertCurrent: isPrepared });
}

module.exports = { createNativeMcpHost };
