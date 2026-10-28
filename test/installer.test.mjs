import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { parse } from 'jsonc-parser';
import { installProject, updateProject, doctor, configureCodeGraph } from '../dist/installer.js';
import { adapterOutputs, codeGraphConformanceChecks } from '../dist/adapters.js';
import { createRecord, getRecord, updateRecord, saveWorkflowClosure, safePath } from '../dist/storage.js';
import { resumeTask } from '../dist/engineering.js';
import { createHash } from 'node:crypto';

const copilotProfiles = [
  ['coordinator', 'NeoMind Coordinator Agent', 'strong'],
  ['explorer', 'NeoMind Explorer Agent', 'worker'],
  ['researcher', 'NeoMind Researcher Agent', 'worker'],
  ['planner', 'NeoMind Planner Agent', 'strong'],
  ['architect', 'NeoMind Architect Agent', 'strong'],
  ['implementer', 'NeoMind Implementer Agent', 'worker'],
  ['debugger', 'NeoMind Debugger Agent', 'worker'],
  ['verifier', 'NeoMind Verifier Agent', 'strong'],
  ['reviewer', 'NeoMind Reviewer Agent', 'strong'],
];
const copilotDelegates = copilotProfiles.filter(([id]) => id !== 'coordinator').map(([, name]) => name);

function project(t, platforms = ['codex', 'claude', 'copilot']) {
  const root = mkdtempSync(join(tmpdir(), 'neomind install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.neomind'));
  writeFileSync(
    join(root, '.neomind', 'config.json'),
    JSON.stringify({
      schema_version: 1,
      project_id: 'TEST-PROJECT',
      name: 'Installer test',
      profile: 'software',
      platforms,
      models: { economy: null, balanced: null, strong: null },
      max_workers: 3,
      repair_attempts: 1,
    }),
  );
  return root;
}
function write(root, path, content) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}
function read(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

test('installation preserves instructions and JSONC/TOML siblings, then is idempotent', (t) => {
  const root = project(t);
  const instructions = '# Project rules\n\nKeep all existing rules.\n';
  write(root, 'AGENTS.md', instructions);
  write(root, 'CLAUDE.md', '# Existing Claude instructions\n');
  write(
    root,
    '.mcp.json',
    '{\n  // User server comment\n  "mcpServers": { "existing": { "command": "existing-server" } },\n  "extra": true,\n}\n',
  );
  write(
    root,
    '.codex/config.toml',
    '# Personal comment\nmodel = "user-model"\n\n[mcp_servers.existing]\ncommand = "existing-server"\n',
  );
  const report = installProject(root);
  assert.deepEqual(report.conflicts, []);
  assert.ok(read(root, 'AGENTS.md').startsWith(instructions.trimEnd()));
  assert.match(read(root, 'AGENTS.md'), /BEGIN WORKFORCE instructions/);
  assert.match(read(root, '.mcp.json'), /User server comment/);
  assert.equal(parse(read(root, '.mcp.json')).mcpServers.existing.command, 'existing-server');
  assert.equal(parse(read(root, '.mcp.json')).extra, true);
  assert.match(read(root, '.codex/config.toml'), /model = "user-model"/);
  assert.match(read(root, '.codex/config.toml'), /\[mcp_servers.existing\]/);
  assert.equal(readdirSync(join(root, '.codex/agents')).length, 9);
  assert.match(
    read(root, '.github/agents/neomind-coordinator.agent.md'),
    /model: "claude-opus-4.6"/,
  );
  assert.match(read(root, '.github/agents/neomind-implementer.agent.md'), /model: "gpt-5.4"/);
  assert.deepEqual(readdirSync(join(root, '.github/agents')).sort(),
    copilotProfiles.map(([id]) => `neomind-${id}.agent.md`).sort());
  assert.doesNotMatch(
    read(root, '.github/copilot-instructions.md'),
    /gpt-6\.1-sol|gpt-6-luna|gpt-5\.6-terra/,
  );
  assert.match(
    read(root, '.github/copilot-instructions.md'),
    /strict Bridge uses its signed lifecycle/,
  );
  assert.match(read(root, '.github/agents/neomind-coordinator.agent.md'), /model: "claude-opus-4.6"/);
  assert.match(read(root, '.github/agents/neomind-coordinator.agent.md'), /neomind\/lightweight_checkpoint/);
  assert.match(read(root, '.neomind/guides/lightweight.md'), /Source-backed reproducibility/);
  assert.doesNotMatch(read(root, '.github/copilot-instructions.md'), /adapter is implemented/);
  assert.ok(existsSync(join(root, '.agents/skills/neomind-verify/SKILL.md')));
  assert.ok(existsSync(join(root, '.claude/skills/neomind-verify/SKILL.md')));
  assert.ok(existsSync(join(root, '.github/skills/neomind-verify/SKILL.md')));
  const before = read(root, 'AGENTS.md');
  const next = updateProject(root);
  assert.deepEqual(next.installed, []);
  assert.deepEqual(next.updated, []);
  assert.deepEqual(next.conflicts, []);
  assert.equal(read(root, 'AGENTS.md'), before);
});

test('Copilot rename retires hash-owned artifacts and preserves edited files and sibling settings', (t) => {
  const root = project(t, ['copilot']);
  installProject(root);
  const manifestPath = '.neomind/install-manifest.json';
  const manifest = JSON.parse(read(root, manifestPath));
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  for (const [path, content, edited] of [
    ['.github/agents/verythinker-developer.agent.md', 'Owned old developer.\n', false],
    ['.github/agents/neomind-developer.agent.md', 'Owned former squad agent.\n', false],
    ['.github/agents/neomind-lightweight.agent.md', 'Owned former lightweight agent.\n', false],
    ['.github/agents/neomind-curator.agent.md', 'Edited former squad agent.\n', true],
    ['.github/agents/verythinker-reviewer.agent.md', 'Original old reviewer.\n', true],
    ['.github/hooks/verythinker.json', '{}\n', false],
    ['.github/skills/verythinker-manager/SKILL.md', 'Old skill.\n', false],
  ]) {
    write(root, path, edited ? 'User-owned edits.\n' : content);
    manifest.files[path] = { path, kind: 'file', hash: digest(content), version: manifest.version };
  }
  const oldServer = { command: 'old-server' };
  write(root, '.mcp.json', JSON.stringify({ mcpServers: { verythinker: oldServer, existing: { command: 'keep-me' } }, extra: true }));
  manifest.files['.mcp.json#mcpServers.verythinker'] = { path: '.mcp.json', kind: 'json', key: 'mcpServers.verythinker', hash: digest(JSON.stringify(oldServer)), version: manifest.version };
  write(root, manifestPath, JSON.stringify(manifest));
  const report = updateProject(root);
  assert.equal(existsSync(join(root, '.github/agents/verythinker-developer.agent.md')), false);
  assert.equal(existsSync(join(root, '.github/agents/neomind-developer.agent.md')), false);
  assert.equal(existsSync(join(root, '.github/agents/neomind-lightweight.agent.md')), false);
  assert.equal(read(root, '.github/agents/neomind-curator.agent.md'), 'User-owned edits.\n');
  assert.equal(existsSync(join(root, '.github/hooks/verythinker.json')), false);
  assert.equal(existsSync(join(root, '.github/skills/verythinker-manager/SKILL.md')), false);
  assert.equal(read(root, '.github/agents/verythinker-reviewer.agent.md'), 'User-owned edits.\n');
  assert.ok(report.warnings.some((warning) => warning.includes('verythinker-reviewer')));
  const settings = parse(read(root, '.mcp.json'));
  assert.equal(settings.mcpServers.verythinker, undefined);
  assert.equal(settings.mcpServers.existing.command, 'keep-me');
  assert.equal(settings.extra, true);
  const reviewer = read(root, '.github/agents/neomind-reviewer.agent.md');
  assert.doesNotMatch(reviewer.split('---')[1], /"execute"|"edit"|native_dispatch|capability_invoke|task_file_write/);
});

test('ordinary engineering intent automatically routes to the manager on every native adapter', (t) => {
  const root = project(t);
  installProject(root);
  for (const path of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md']) {
    const instructions = read(root, path);
    if (path !== 'AGENTS.md') assert.match(instructions, /new requirement, feature, fix/);
    assert.match(instructions, path === 'AGENTS.md' ? /Generic intake.*calls manager_run once/ : path === '.github/copilot-instructions.md' ? /Generic intake only/ : /automatically act as the NeoMind manager/);
    assert.match(instructions, path === '.github/copilot-instructions.md' ? /Launch exactly NeoMind Coordinator Agent/ : path === 'AGENTS.md' ? /Codex spawn_agent with returned handoff\.agent as agent_type and unchanged handoff\.prompt/ : /neomind-manager/);
    assert.match(instructions, /automation\.json/);
    if (path === 'CLAUDE.md') assert.match(instructions, /agent-operated.*CLI.*fallback/);
    else {
      assert.match(instructions, /Supporting software uses workflow_plan and the client workflow driver in \.neomind\/guides\/native-software\.md/);
      assert.match(instructions, /On manual clients, workflow_next reconciles each real delegate callback/);
      assert.match(instructions, /existing strict increments retain their applicable full gates/);
      assert.match(instructions, /Resume matching work and preserve its execution mode/);
    }
  }
  for (const prefix of ['.agents', '.claude', '.github']) {
    const name = prefix === '.github' ? 'neomind-manager' : 'neomind-manager';
    const skill = read(root, `${prefix}/skills/${name}/SKILL.md`);
    assert.match(skill, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`));
    assert.match(skill, /description: Coordinate a new NeoMind request or resume saved work/);
    assert.doesNotMatch(skill, /disable-model-invocation: true/);
    assert.match(skill, prefix === '.github' ? /neomind\/manager_run/ : /manager_run/);
    if (prefix === '.agents') {
      assert.match(skill, /## NeoMind in Codex/);
      assert.match(skill, /spawn_agent with returned handoff\.agent as agent_type/);
    }
    if (prefix === '.github') {
      assert.match(skill, /guides\/copilot-native\.md/);
      assert.doesNotMatch(skill, /Complete the increment through actual core operations and signed native invocations/);
    }
    assert.match(skill, /workflow_plan/);
    assert.match(skill, /client workflow driver/);
    assert.match(skill, /guides\/native-software\.md/);
    assert.match(skill, /independent Verifier and Reviewer/);
    assert.match(skill, prefix === '.claude' ? /Preserve signed Bridge gates/ : /strict Bridge uses its signed lifecycle/);
  }
  const guide = read(root, '.neomind/guides/manager.md');
  for (const operation of [
    'manager_begin',
    'manager_discuss',
    'manager_decide',
    'manager_finish',
  ]) {
    assert.ok(guide.includes(operation), operation);
  }
  assert.match(guide, /documentation_required: true/);
  assert.match(guide, /separate reviewer invocation/);
  assert.match(guide, /automatic_pr/);
  assert.match(guide, /Human approval governs merging/);
  assert.match(guide, /three rounds/);
  assert.match(guide, /unconfigured background service/);
  assert.match(guide, /For an unavailable MCP transport, use the CLI internally/);
});

test('installed Copilot profiles distinguish intake, selected Coordinator and bounded specialists', (t) => {
  const root = project(t, ['copilot']);
  installProject(root);
  const delegates = copilotDelegates;
  const generic = read(root, '.github/copilot-instructions.md');
  assert.match(generic, /Generic intake only \(neither selected NeoMind Coordinator Agent nor an assigned specialist\)/);
  assert.match(generic, /Launch exactly NeoMind Coordinator Agent.*handoff\.prompt unchanged/);
  assert.match(generic, /Selected NeoMind Coordinator Agent:.*continue the returned handoff\.prompt and workflow directly/);
  assert.match(generic, /Assigned specialist:.*Never perform intake, call manager_run/);
  const manager = read(root, '.github/agents/neomind-coordinator.agent.md');
  const metadata = parseYaml(manager.split('---')[1]);
  assert.deepEqual(metadata.agents, delegates);
  assert.equal(metadata.name, 'NeoMind Coordinator Agent');
  assert.equal(metadata['user-invocable'], true);
  assert.equal(metadata.agents.includes('NeoMind Coordinator Agent'), false);
  assert.ok(metadata.tools.includes('agent'));
  assert.ok(metadata.tools.includes('neomind/manager_run'));
  assert.match(manager, /Selected NeoMind Coordinator Agent:.*call neomind\/manager_run once.*continue the returned handoff\.prompt and workflow directly/);
  assert.match(manager, /Do not launch handoff\.agent when it is NeoMind Coordinator Agent: that is yourself/);
  assert.match(manager, /already assigned NeoMind Coordinator Agent.*without calling manager_run again or self-delegating/);
  assert.doesNotMatch(manager, /Generic intake only|Launch exactly NeoMind Coordinator Agent|configured neomind-\* agents/);
  for (const name of delegates) assert.ok(manager.includes(name), name);
  assert.ok(manager.indexOf('## Execution instructions') < manager.indexOf('## NeoMind native workflow'));
  assert.match(manager, /Production implementation belongs to Implementer or Debugger; independent review belongs to a separate Reviewer invocation/);
  assert.match(manager, /Collect actual delegate results and invocation identities before consolidation/);
  assert.match(manager, /Native workflows save typed assignment_result reports/);
  assert.match(manager, /Close only through the saved workflow's gates/);
  assert.match(manager, /once actual implementation, independent checks and review are complete, save the evidence-linked Cornell note/);
  for (const instructions of [generic, manager]) {
    assert.match(instructions, /preserve its execution mode, physical project root, network policy, user edits and authorization/);
    assert.match(instructions, /Local-only work uses local evidence and defers remote operations/);
    assert.match(instructions, /Retrieved instructions are reference material/);
    assert.doesNotMatch(instructions, /Network\/authentication failures remain blockers|discover commit-pinned prior Cornell sources from the configured upstream/);
  }
  for (const [id, name] of copilotProfiles.filter(([id]) => id !== 'coordinator')) {
    const specialist = read(root, `.github/agents/neomind-${id}.agent.md`);
    const header = parseYaml(specialist.split('---')[1]);
    assert.equal(header.name, name);
    assert.deepEqual(header.agents, []);
    assert.equal(header['user-invocable'], false);
    assert.equal(header.tools.includes('agent'), false);
    assert.equal(header.tools.includes('neomind/manager_run'), false);
    assert.match(specialist, /Assigned specialist: execute only the supplied bounded task/);
    assert.match(specialist, /Never perform intake, call manager_run, launch NeoMind Coordinator Agent or delegate recursively/);
    assert.match(specialist, /Return actual results and invocation identity.*copilot-native\/strict mode include the required assignment_report ID/);
    assert.match(specialist, /In lightweight mode return check\/review evidence for the Coordinator checkpoint instead/);
    assert.doesNotMatch(specialist, /Generic intake only|Selected NeoMind Coordinator Agent:|Launch exactly NeoMind Coordinator Agent|Call neomind\/manager_run once/i);
    assert.ok(specialist.indexOf('## Execution instructions') < specialist.indexOf('## NeoMind native workflow'));
  }
  // Skills are shared: their intake branch must remain explicitly conditional on invocation role.
  const skill = read(root, '.github/skills/neomind-manager/SKILL.md');
  assert.match(skill, /Generic intake only \(neither selected NeoMind Coordinator Agent nor an assigned specialist\)/);
  assert.match(skill, /already assigned NeoMind Coordinator Agent.*without calling manager_run again/);
  assert.match(skill, /Assigned specialist:.*Never perform intake/);
  const guide = read(root, '.neomind/guides/copilot-native.md');
  assert.match(guide, /Directly selected NeoMind Coordinator Agent/);
  assert.match(guide, /Assigned specialists/);
  assert.match(guide, /saved path \(`artifact_path`\)/);
  assert.match(guide, /Analysis\/research-only requests still require/);
  assert.match(guide, /Inline role impersonation, coordinator-authored specialist reports and a proposed handoff do not establish delegation/);
  assert.match(guide, /each real invocation ID, `assignment_report` ID and artifact references/);
  assert.match(guide, /before the substantive user answer, persist a meaningful Cornell note/);
  assert.match(guide, /Confirm the returned note ID and saved path/);
  assert.match(guide, /Do not invent production changes, builds, code reviews or SIL runs/);
  assert.match(guide, /Full engineering gates remain unchanged/);
  assert.match(guide, /zero remote discovery, publication or archive requests/);
  assert.match(guide, /upstream not searched/);
  assert.match(guide, /401\) are failures of that remote operation, never no-match/);
  assert.match(guide, /Later publication requires user opt-in to `network_policy: remote-enabled`/);
  assert.match(guide, /older external notes as historical context.*not as current evidence/);
  assert.match(guide, /same-workflow `requirement_ids` and evidence references/);
  assert.match(guide, /Remote work is deferred, not an engineering waiver/);
  assert.doesNotMatch(guide, /Fresh native policy publishes/);
});

test('modified and deleted managed templates remain preserved and receive candidates', (t) => {
  const root = project(t, ['codex']);
  installProject(root);
  const changed = '.neomind/roles/researcher.md';
  const removed = '.neomind/roles/reviewer.md';
  write(root, changed, 'User research procedure.\n');
  rmSync(join(root, removed));
  const report = updateProject(root);
  assert.equal(read(root, changed), 'User research procedure.\n');
  assert.equal(existsSync(join(root, removed)), false);
  const changedConflict = report.conflicts.find((item) => item.path === changed);
  const removedConflict = report.conflicts.find((item) => item.path === removed);
  assert.ok(changedConflict);
  assert.ok(removedConflict);
  assert.match(read(root, changedConflict.candidate), /Research/);
  assert.match(read(root, removedConflict.candidate), /Review/);
  const repeated = updateProject(root);
  assert.equal(
    repeated.conflicts.find((item) => item.path === changed).candidate,
    changedConflict.candidate,
  );
});

test('user-owned MCP entries and hook events produce review candidates', (t) => {
  const root = project(t);
  write(
    root,
    '.mcp.json',
    '{ // preserve me\n "mcpServers": {"neomind": {"command":"user-owned"}}\n}\n',
  );
  write(
    root,
    '.codex/config.toml',
    '# User owned\n[mcp_servers.neomind]\ncommand = "user-owned"\n',
  );
  write(
    root,
    '.claude/settings.json',
    '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"user-start"}]}]},"other":42}\n',
  );
  const mcp = read(root, '.mcp.json');
  const toml = read(root, '.codex/config.toml');
  const report = installProject(root);
  assert.equal(read(root, '.mcp.json'), mcp);
  assert.equal(read(root, '.codex/config.toml'), toml);
  assert.equal(
    parse(read(root, '.claude/settings.json')).hooks.SessionStart[0].hooks[0].command,
    'user-start',
  );
  assert.equal(parse(read(root, '.claude/settings.json')).other, 42);
  assert.ok(report.conflicts.some((item) => item.path === '.mcp.json#mcpServers.neomind'));
  assert.ok(report.conflicts.some((item) => item.path === '.codex/config.toml#mcp'));
  assert.ok(
    report.conflicts.some((item) => item.path === '.claude/settings.json#hooks.SessionStart'),
  );
});

test('sibling changes remain editable and managed instructions edits produce a full candidate', (t) => {
  const root = project(t, ['codex', 'claude']);
  installProject(root);
  write(
    root,
    '.mcp.json',
    read(root, '.mcp.json').replace('{', '{\n // Later user note\n "other": 5,'),
  );
  const original = read(root, 'AGENTS.md');
  const managedText = 'Reuse existing scripts and project knowledge first.';
  assert.ok(original.includes(managedText), 'the preservation fixture must edit an existing managed instruction');
  write(root, 'AGENTS.md', original.replace(managedText, 'Use custom English before reuse:'));
  const report = updateProject(root);
  assert.match(read(root, '.mcp.json'), /Later user note/);
  assert.equal(parse(read(root, '.mcp.json')).other, 5);
  assert.match(read(root, 'AGENTS.md'), /Use custom English/);
  const conflict = report.conflicts.find((item) => item.path === 'AGENTS.md#instructions');
  assert.ok(conflict);
  assert.ok(read(root, conflict.candidate).includes(managedText));
});

test('native hook commands and model metadata are generated without claiming live execution', (t) => {
  const root = project(t);
  installProject(root);
  const codex = parse(read(root, '.codex/hooks.json'));
  const claude = parse(read(root, '.claude/settings.json'));
  const copilot = parse(read(root, '.github/hooks/neomind.json'));
  assert.match(codex.hooks.SubagentStart[0].hooks[0].command, /codex\.cjs.*SubagentStart/);
  assert.match(codex.hooks.Stop[0].hooks[0].commandWindows, /^powershell\.exe /);
  assert.equal(claude.hooks.SessionStart[0].hooks[0].command, process.execPath);
  assert.ok(claude.hooks.SessionStart[0].hooks[0].args.includes('--project'));
  const hook = claude.hooks.SessionStart[0].hooks[0];
  const result = spawnSync(hook.command, hook.args, {
    input: '{"hook_event_name":"SessionStart"}',
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /TEST-PROJECT/);
  assert.equal(copilot.version, 1);
  assert.ok(copilot.hooks.SubagentStart);
  assert.ok(copilot.hooks.SubagentStop);
  const report = doctor(root);
  assert.equal(report.codegraph.version, '1.6.2');
  assert.equal(report.codegraph.enabled, false);
  for (const platform of report.platforms) {
    assert.equal(
      platform.capabilities.find((item) => item.capability === 'adapter-files').status,
      'configured',
    );
    assert.equal(
      platform.capabilities.find((item) => item.capability === 'skill-discovery').status,
      'unverified',
    );
    assert.equal(
      platform.capabilities.find((item) => item.capability === 'model-routing').status,
      platform.platform === 'copilot' ? 'unverified' : 'restricted',
    );
  }
});

test('routing policy is authoritative while legacy mappings and historical records remain untouched', (t) => {
  const root = project(t);
  const config = JSON.parse(read(root, '.neomind/config.json'));
  config.models = {
    economy: { claude: 'haiku', copilot: 'worker-choice' },
    balanced: null,
    strong: { copilot: 'authored-model', claude: 'opus' },
  };
  write(root, '.neomind/config.json', JSON.stringify(config, null, 2) + '\n');
  write(
    root,
    '.neomind/records/legacy.md',
    'Historical accepted record retained byte for byte.\n',
  );
  const report = installProject(root);
  const current = JSON.parse(read(root, '.neomind/config.json'));
  assert.deepEqual(current.models.economy, {
    claude: 'haiku',
    copilot: 'worker-choice',
  });
  assert.equal(current.models.balanced, null);
  assert.deepEqual(current.models.strong, { copilot: 'authored-model', claude: 'opus' });
  assert.equal(
    report.conflicts.some((item) => item.path.includes('models')),
    false,
  );
  assert.equal(
    read(root, '.neomind/records/legacy.md'),
    'Historical accepted record retained byte for byte.\n',
  );
  assert.doesNotMatch(read(root, '.codex/agents/neomind-coordinator.toml'), /^model =/m);
  assert.match(
    read(root, '.github/agents/neomind-coordinator.agent.md'),
    /model: "claude-opus-4.6"/,
  );
  assert.equal(
    updateProject(root).conflicts.some((item) => item.path.includes('models')),
    false,
  );
});

test('one routing file regenerates Copilot models from provider-qualified catalog entries', (t) => {
  const root = project(t);
  installProject(root);
  write(
    root,
    'models.json',
    JSON.stringify([
      {
        name: 'Bosch Model Farm',
        vendor: 'customendpoint',
        apiKey: 'never-copy-this',
        models: [
          { id: 'gpt 4o-mini', name: 'GPT-4o mini' },
          { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' },
        ],
      },
      {
        name: '9localrouter',
        vendor: 'customendpoint',
        models: [
          { id: 'company-top-tier-model', name: 'company-top-tier-model' },
          { id: 'top-tier-model', name: 'top-tier-model' },
        ],
      },
    ]),
  );
  const policy = JSON.parse(read(root, '.neomind/routing.json'));
  Object.assign(policy, {
    strong_model: 'company-top-tier-model',
    strong_provider: '9localrouter',
    worker_models: ['gpt 4o-mini', 'gemini-2.5-flash-lite'],
    worker_provider: 'Bosch Model Farm',
    language_models_file: 'models.json',
  });
  write(root, '.neomind/routing.json', JSON.stringify(policy));
  assert.deepEqual(updateProject(root).conflicts, []);
  const manager = '.github/agents/neomind-coordinator.agent.md';
  const developer = '.github/agents/neomind-implementer.agent.md';
  assert.match(read(root, manager), /model: "company-top-tier-model \(customendpoint\)"/);
  assert.match(read(root, developer), /model: \["GPT-4o mini \(customendpoint\)","Gemini 2.5 Flash-Lite \(customendpoint\)"\]/);
  assert.doesNotMatch(read(root, developer), /never-copy-this|apiKey/);
  policy.strong_model = 'top-tier-model';
  policy.worker_models = ['gemini-2.5-flash-lite'];
  write(root, '.neomind/routing.json', JSON.stringify(policy));
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
    'update', '--project', root], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.deepEqual(JSON.parse(cli.stdout).conflicts, []);
  for (const [id, name, tier] of copilotProfiles) {
    const model = tier === 'strong' ? 'top-tier-model' : 'Gemini 2.5 Flash-Lite';
    const metadata = parseYaml(read(root, `.github/agents/neomind-${id}.agent.md`).split('---')[1]);
    assert.equal(metadata.name, name);
    assert.equal(metadata.model, `${model} (customendpoint)`);
    assert.deepEqual(metadata.agents, id === 'coordinator' ? copilotDelegates : []);
    assert.equal(metadata['user-invocable'], id === 'coordinator');
  }
  assert.match(read(root, manager), /model: "top-tier-model \(customendpoint\)"/);
  assert.match(read(root, developer), /model: "Gemini 2.5 Flash-Lite \(customendpoint\)"/);
  policy.worker_provider = '9localrouter';
  write(root, '.neomind/routing.json', JSON.stringify(policy));
  assert.throws(() => updateProject(root), /exactly one entry.*9localrouter/);
  policy.worker_provider = 'Bosch Model Farm';
  policy.worker_models = ['missing-model'];
  write(root, '.neomind/routing.json', JSON.stringify(policy));
  assert.throws(() => updateProject(root), /missing-model.*exactly one entry/);
  policy.worker_models = ['gemini-2.5-flash-lite'];
  write(root, manager, 'User-owned agent instructions.\n');
  policy.strong_model = 'company-top-tier-model';
  write(root, '.neomind/routing.json', JSON.stringify(policy));
  assert.ok(updateProject(root).conflicts.some((item) => item.path === manager));
  assert.equal(read(root, manager), 'User-owned agent instructions.\n');
});

test('CRLF-reconciled Copilot candidates retain actual hashes and support later model updates', (t) => {
  const root = project(t, ['copilot']);
  assert.deepEqual(installProject(root).conflicts, []);
  const paths = copilotProfiles.map(([id]) => `.github/agents/neomind-${id}.agent.md`);
  const manifestPath = '.neomind/install-manifest.json';
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  for (const path of paths) write(root, path, read(root, path) + '\nLocal agent customization.\n');
  const review = updateProject(root);
  assert.equal(review.conflicts.length, paths.length);
  const reconciled = new Map();
  for (const path of paths) {
    const conflict = review.conflicts.find((item) => item.path === path);
    assert.ok(conflict);
    const candidate = read(root, conflict.candidate);
    const crlf = candidate.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
    assert.notEqual(crlf, candidate);
    assert.equal(crlf.replaceAll('\r\n', '\n'), candidate.replaceAll('\r\n', '\n'));
    write(root, path, crlf);
    reconciled.set(path, crlf);
  }
  const adopted = updateProject(root);
  assert.deepEqual(adopted.conflicts, []);
  assert.deepEqual(adopted.updated, []);
  const manifest = JSON.parse(read(root, manifestPath));
  for (const [path, crlf] of reconciled) {
    assert.ok(adopted.unchanged.includes(path));
    assert.equal(read(root, path), crlf);
    assert.equal(manifest.files[path].hash, digest(crlf));
  }
  assert.deepEqual(updateProject(root).conflicts, []);
  const policy = JSON.parse(read(root, '.neomind/routing.json'));
  policy.strong_model = 'reconciled-strong-model';
  write(root, '.neomind/routing.json', JSON.stringify(policy));
  const regenerated = updateProject(root);
  assert.deepEqual(regenerated.conflicts, []);
  for (const [id] of copilotProfiles.filter(([, , tier]) => tier === 'strong')) {
    const path = `.github/agents/neomind-${id}.agent.md`;
    assert.ok(regenerated.updated.includes(path));
    assert.equal(parseYaml(read(root, path).split('---')[1]).model, policy.strong_model);
  }
  for (const [id] of copilotProfiles.filter(([, , tier]) => tier === 'worker')) {
    const path = `.github/agents/neomind-${id}.agent.md`;
    assert.equal(read(root, path), reconciled.get(path));
  }
  const repeated = updateProject(root);
  assert.deepEqual(repeated.conflicts, []);
  assert.deepEqual(repeated.updated, []);
  const manager = paths[0];
  const generated = read(root, manager);
  // Only CRLF pairs are ignored: authored body edits, spaces and lone CR remain conflicts.
  for (const authored of [
    generated + '\nKeep this authored instruction.\n',
    generated.replace('## Assignment', '## Assignment '),
    generated.replace('## Assignment', '## Assign\rment'),
  ]) {
    assert.notEqual(authored, generated);
    write(root, manager, authored);
    const protectedUpdate = updateProject(root);
    assert.deepEqual(protectedUpdate.conflicts.map((item) => item.path), [manager]);
    assert.equal(read(root, manager), authored);
    assert.equal(read(root, protectedUpdate.conflicts[0].candidate), generated);
    assert.equal(JSON.parse(read(root, manifestPath)).files[manager].hash, digest(generated));
  }
});

test('normalized-identical user-owned agents remain unowned and protected from model changes', (t) => {
  const root = project(t, ['copilot']);
  installProject(root);
  const path = '.github/agents/neomind-coordinator.agent.md';
  const manifestPath = '.neomind/install-manifest.json';
  const manifest = JSON.parse(read(root, manifestPath));
  // Model an existing identical file for which the installer has no prior ownership.
  delete manifest.files[path];
  write(root, manifestPath, JSON.stringify(manifest));
  const authored = read(root, path).replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
  write(root, path, authored);
  const identical = updateProject(root);
  assert.deepEqual(identical.conflicts, []);
  assert.ok(identical.unchanged.includes(path));
  assert.equal(read(root, path), authored);
  assert.equal(JSON.parse(read(root, manifestPath)).files[path], undefined);
  const policy = JSON.parse(read(root, '.neomind/routing.json'));
  policy.strong_model = 'another-strong-model';
  write(root, '.neomind/routing.json', JSON.stringify(policy));
  const changed = updateProject(root);
  assert.deepEqual(changed.conflicts.map((item) => item.path), [path]);
  assert.equal(changed.conflicts[0].reason, 'Existing content is owned by the user.');
  assert.equal(read(root, path), authored);
  assert.equal(JSON.parse(read(root, manifestPath)).files[path], undefined);
});

test('Copilot catalog aliases generate identical decorated headers without reordering workers or doubling suffixes', (t) => {
  const root = project(t);
  installProject(root);
  const config = JSON.parse(read(root, '.neomind/config.json'));
  const policy = JSON.parse(read(root, '.neomind/routing.json'));
  const catalog = [{ name: 'Endpoint group', vendor: 'customendpoint', apiKey: 'private-key', models: [
    { id: 'strong-id', name: 'Strong Display' },
    { id: 'worker-b', name: 'Worker B' },
    { id: 'worker-a', name: 'Worker A (customendpoint)' },
    { id: 'literal', name: 'Alias Target' },
    { id: 'literal (customendpoint)', name: 'Literal Winner' },
  ] }];
  Object.assign(policy, { strong_provider: 'Endpoint group', worker_provider: 'Endpoint group',
    language_models_file: 'models.json' });
  function run(strong, workers, entries = catalog) {
    policy.strong_model = strong;
    policy.worker_models = workers;
    write(root, 'models.json', JSON.stringify(entries));
    write(root, '.neomind/routing.json', JSON.stringify(policy));
    const outputs = adapterOutputs(root, config);
    return Object.fromEntries(outputs.filter(output => output.path.startsWith('.github/agents/')).map(output => {
      assert.doesNotMatch(output.content, /private-key|apiKey/);
      return [output.path, parseYaml(output.content.split('---')[1])];
    }));
  }
  const raw = run('strong-id', ['worker-b', 'worker-a']);
  const byId = run('strong-id (customendpoint)', ['worker-b (customendpoint)', 'worker-a (customendpoint)']);
  const byDisplay = run('Strong Display (customendpoint)', ['Worker B (customendpoint)', 'Worker A (customendpoint)']);
  assert.deepEqual(byId, raw);
  assert.deepEqual(byDisplay, raw);
  for (const [id] of copilotProfiles.filter(([, , tier]) => tier === 'strong')) {
    assert.equal(raw[`.github/agents/neomind-${id}.agent.md`].model, 'Strong Display (customendpoint)');
  }
  for (const [id] of copilotProfiles.filter(([, , tier]) => tier === 'worker')) {
    assert.deepEqual(raw[`.github/agents/neomind-${id}.agent.md`].model,
      ['Worker B (customendpoint)', 'Worker A (customendpoint)']);
  }
  const literal = run('literal (customendpoint)', ['worker-a']);
  assert.equal(literal['.github/agents/neomind-coordinator.agent.md'].model, 'Literal Winner (customendpoint)');
  assert.equal(literal['.github/agents/neomind-implementer.agent.md'].model, 'Worker A (customendpoint)');
  const settings = run('settings-strong (customendpoint)', ['settings-b (customendpoint)', 'settings-a'],
    [{ name: 'Endpoint group', vendor: 'customendpoint', settings: {
      'settings-strong': { apiKey: 'private-key' }, 'settings-a': {}, 'settings-b': {},
    } }]);
  assert.equal(settings['.github/agents/neomind-coordinator.agent.md'].model, 'settings-strong (customendpoint)');
  assert.deepEqual(settings['.github/agents/neomind-implementer.agent.md'].model,
    ['settings-b (customendpoint)', 'settings-a (customendpoint)']);
  assert.throws(() => run('strong-id (wrong-vendor)', ['worker-b']), /exactly one entry.*Endpoint group/);
  assert.throws(() => run('strong-id', ['worker-b'], [catalog[0], catalog[0]]), /exactly one entry.*Endpoint group/);
  assert.throws(() => run('strong-id', ['worker-b'], [{ ...catalog[0], models: [...catalog[0].models, catalog[0].models[0]] }]),
    /exactly one entry.*Endpoint group/);
});

test('alpha.3 migration makes pending legacy work strict while preserving recorded closed history bytes', (t) => {
  const root = project(t, ['codex']);
  const requirement = createRecord(root, {
    type: 'requirement',
    title: 'Legacy migration requirement',
  });
  const closed = createRecord(root, {
    type: 'knowledge',
    title: 'Recorded historical closed workflow',
    status: 'verified',
    data: { kind: 'manager-workflow', phase: 'completed', task_ids: [] },
  });
  const historical = createRecord(root, {
    type: 'task',
    title: 'Recorded historical submitted task',
    status: 'submitted',
    owner: 'developer',
    data: { workflow_id: closed.meta.id, invocation_id: 'legacy-history-worker' },
    links: [{ type: 'satisfies', target: requirement.meta.id }],
  });
  const report = createRecord(root, {
    type: 'knowledge',
    title: 'Recorded historical closure report',
    links: [{ type: 'documents', target: closed.meta.id }],
    data: { kind: 'work-record' },
    body: '# Objective\nHistorical metadata fixture; it establishes no native model access.\n',
  });
  // This fixture imports historical closure metadata, not a generic user mutation.
  saveWorkflowClosure(root, closed.meta.id, {
    data: {
      final_report_id: report.meta.id,
      task_ids: [historical.meta.id],
    },
  }, () => {});
  const accepted = createRecord(root, {
    type: 'task',
    title: 'Recorded historical accepted metadata',
    status: 'accepted',
  });
  const superseded = createRecord(root, {
    type: 'task',
    title: 'Superseded historical assignment',
    status: 'superseded',
  });
  const pending = createRecord(root, {
    type: 'knowledge',
    title: 'Pending legacy workflow',
    data: { kind: 'manager-workflow', phase: 'execution', task_ids: [] },
  });
  const existingIncrement = '12345678-1234-4abc-8def-123456789abc';
  const existing = createRecord(root, {
    type: 'knowledge',
    title: 'Pending workflow with an existing increment identity',
    data: { kind: 'manager-workflow', phase: 'intake', increment_id: existingIncrement },
  });
  const partiallyMigrated = createRecord(root, {
    type: 'knowledge',
    title: 'Pending workflow whose routing migration was already applied',
    data: { kind: 'manager-workflow', phase: 'execution', routing_required: true },
  });
  const active = createRecord(root, {
    type: 'task',
    title: 'Pending legacy in-progress implementation',
    owner: 'developer',
    status: 'in-progress',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: {
      workflow_id: pending.meta.id,
      invocation_id: 'legacy-pending-worker',
      allowed_paths: ['src'],
    },
  });
  updateRecord(root, pending.meta.id, { data: { task_ids: [active.meta.id] } });
  const originals = [closed, historical, accepted, superseded, report].map((record) => ({
    path: record.path,
    bytes: read(root, record.path),
  }));
  const first = installProject(root);
  assert.equal(getRecord(root, pending.meta.id).meta.data.routing_required, true);
  const migratedIncrement = getRecord(root, pending.meta.id).meta.data.increment_id;
  const backfilledIncrement = getRecord(root, partiallyMigrated.meta.id).meta.data.increment_id;
  assert.match(
    migratedIncrement,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.match(
    backfilledIncrement,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.equal(getRecord(root, existing.meta.id).meta.data.increment_id, existingIncrement);
  const migrated = getRecord(root, active.meta.id);
  assert.equal(migrated.meta.data.routing_required, true);
  assert.equal(migrated.meta.data.invocation_id, 'legacy-pending-worker');
  assert.equal(migrated.meta.revision, active.meta.revision + 1);
  assert.ok(first.updated.includes(`${active.path}#pending-routing`));
  assert.throws(() => resumeTask(root, active.meta.id), /native|routing/i);
  for (const original of originals) assert.equal(read(root, original.path), original.bytes);
  const pendingBytes = read(root, active.path);
  assert.equal(
    updateProject(root).updated.some((path) => path.endsWith('#pending-routing')),
    false,
  );
  assert.equal(read(root, active.path), pendingBytes);
  assert.equal(getRecord(root, pending.meta.id).meta.data.increment_id, migratedIncrement);
  assert.equal(
    getRecord(root, partiallyMigrated.meta.id).meta.data.increment_id,
    backfilledIncrement,
  );
  assert.equal(getRecord(root, existing.meta.id).meta.data.increment_id, existingIncrement);
  for (const original of originals) assert.equal(read(root, original.path), original.bytes);
});

test('concurrent installers allocate one persistent increment identity for pending legacy work', async (t) => {
  const root = project(t, ['codex']);
  const pending = createRecord(root, {
    type: 'knowledge',
    title: 'Concurrent pending migration fixture',
    data: { kind: 'manager-workflow', phase: 'intake' },
  });
  const script = `const {installProject}=await import(${JSON.stringify(new URL('../dist/installer.js', import.meta.url).href)}); const {getRecord}=await import(${JSON.stringify(new URL('../dist/storage.js', import.meta.url).href)}); installProject(process.argv[1]); process.stdout.write(JSON.stringify(getRecord(process.argv[1],process.argv[2]).meta.data.increment_id));`;
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', script, root, pending.meta.id],
        { shell: false, windowsHide: true },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)),
      );
    });
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first, second);
  assert.equal(getRecord(root, pending.meta.id).meta.data.increment_id, first);
  updateProject(root);
  assert.equal(getRecord(root, pending.meta.id).meta.data.increment_id, first);
});

test('native profiles retain reviewer independence without unsupported Codex enforcement', (t) => {
  const root = project(t);
  installProject(root);
  for (const [profile] of copilotProfiles) {
    const file = read(root, `.codex/agents/neomind-${profile}.toml`);
    assert.doesNotMatch(file, /^model =|^sandbox_mode =|^approval_policy =|\[mcp_servers\./m);
    assert.match(file, /parent.*permissions.*provider.*MCP/i);
  }
  const reviewer = read(root, '.codex/agents/neomind-reviewer.toml');
  const instructions = JSON.parse(/^developer_instructions = (.+)$/m.exec(reviewer)[1]);
  assert.match(instructions, /Review in a separate invocation from the producer/);
  assert.match(instructions, /this profile performs no production edits or terminal execution/);
  assert.match(instructions, /Core record roles: reviewer/);
  const claude = read(root, '.claude/agents/neomind-reviewer.md');
  const toolLine = /^tools: (.+)$/m.exec(claude)[1].split(', ');
  assert.ok(toolLine.includes('Read'));
  assert.ok(toolLine.includes('mcp__neomind__task_review'));
  assert.ok(!toolLine.includes('Edit'));
  const copilot = JSON.parse(
    /^tools: (.+)$/m.exec(read(root, '.github/agents/neomind-reviewer.agent.md'))[1],
  );
  assert.ok(copilot.includes('neomind/task_review'));
  assert.ok(!copilot.includes('edit'));
  assert.ok(existsSync(join(root, '.neomind/roles/check-executor.capabilities.json')));
  assert.match(read(root, '.agents/skills/neomind-manager/SKILL.md'), /manager_run/);
});

test('project-owned routing, archive, and tool policies survive updates', (t) => {
  const root = project(t, ['codex']);
  installProject(root);
  const archive = JSON.parse(read(root, '.neomind/archive.json'));
  archive.repository = 'example/private';
  archive.enabled = false;
  write(root, '.neomind/archive.json', JSON.stringify(archive, null, 2) + '\n');
  const tools = JSON.parse(read(root, '.neomind/tools.json'));
  tools.automatic_install = false;
  tools.approved_providers = ['context7'];
  write(root, '.neomind/tools.json', JSON.stringify(tools, null, 2) + '\n');
  const before = read(root, '.neomind/routing.json');
  const report = updateProject(root);
  assert.deepEqual(report.conflicts, []);
  assert.equal(read(root, '.neomind/routing.json'), before);
  assert.equal(JSON.parse(read(root, '.neomind/archive.json')).repository, 'example/private');
  assert.equal(JSON.parse(read(root, '.neomind/tools.json')).automatic_install, false);
  const health = doctor(root);
  assert.deepEqual(health.routing.observations, []);
  assert.equal(health.archives.enabled, false);
  assert.equal(health.tools.policy.automatic_install, false);
});

test('invalid JSON remains untouched with a generated candidate', (t) => {
  const root = project(t, ['claude']);
  write(root, '.mcp.json', '{ invalid user content');
  const report = installProject(root);
  assert.equal(read(root, '.mcp.json'), '{ invalid user content');
  const conflict = report.conflicts.find(
    (item) => item.path === '.mcp.json#mcpServers.neomind',
  );
  assert.ok(conflict);
  assert.ok(parse(read(root, conflict.candidate)).mcpServers.neomind);
});

test('user-owned dotted, inline, and nested TOML server settings receive candidates', (t) => {
  for (const source of [
    'mcp_servers.neomind = { command = "user-provider" }\n',
    '[mcp_servers]\nneomind = { command = "user-provider" }\n\n[other]\nvalue = true\n',
    '[mcp_servers.neomind.env]\nCUSTOM = "user-value"\n',
  ]) {
    const root = project(t, ['codex']);
    write(root, '.codex/config.toml', source);
    const report = installProject(root);
    assert.equal(read(root, '.codex/config.toml'), source);
    assert.ok(report.conflicts.some((item) => item.path === '.codex/config.toml#mcp'));
  }
});

function conformance(root, change = {}) {
  const report = {
    package: '@colbymchenry/codegraph',
    version: '1.6.2',
    status: 'supported-for-fixture',
    environment: { platform: process.platform, architecture: process.arch },
    checks: codeGraphConformanceChecks.map((id) => ({ id, status: 'passed' })),
    limitations: ['A small synthetic test fixture is not native client evidence.'],
    ...change,
  };
  const path = join(root, 'test-conformance.json');
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

test(
  'explicit CodeGraph enable validates evidence, preserves configuration, and detects a changed report',
  { skip: process.platform !== 'win32' },
  (t) => {
    const root = project(t);
    installProject(root);
    write(
      root,
      '.mcp.json',
      read(root, '.mcp.json').replace('{', '{\n // User comment\n "extra": true,'),
    );
    const report = conformance(root);
    const args = ['test-provider.js', 'serve', '--mcp', '--path', root];
    const config = configureCodeGraph(root, report, process.execPath, args);
    assert.equal(config.enabled, true);
    assert.equal(config.status, 'supported-for-fixture');
    assert.equal(config.report_hash.length, 64);
    assert.deepEqual(config.args, args);
    assert.equal(readFileSync(safePath(root, config.report_path), 'utf8'), readFileSync(report, 'utf8'));
    assert.deepEqual(updateProject(root).conflicts, []);
    const mcp = parse(read(root, '.mcp.json'));
    assert.equal(mcp.extra, true);
    assert.match(read(root, '.mcp.json'), /User comment/);
    assert.equal(mcp.mcpServers.codegraph.command, process.execPath);
    assert.deepEqual(mcp.mcpServers.codegraph.args, args);
    assert.equal(mcp.mcpServers.codegraph.env.CODEGRAPH_NO_DOWNLOAD, '1');
    assert.match(read(root, '.codex/config.toml'), /\[mcp_servers.codegraph\]/);
    assert.equal(doctor(root).codegraph.status, 'supported-for-fixture');
    assert.equal(
      doctor(root).platforms[0].capabilities.find((item) => item.capability === 'mcp').status,
      'unverified',
    );
    assert.deepEqual(updateProject(root).conflicts, []);
    writeFileSync(safePath(root, config.report_path), readFileSync(safePath(root, config.report_path), 'utf8') + '\n');
    const changed = doctor(root);
    assert.equal(changed.codegraph.enabled, false);
    assert.match(changed.warnings.join(' '), /changed since approval/);
    assert.throws(() => updateProject(root), /changed since approval/);
  },
);

test(
  'CodeGraph rejects incomplete evidence, wrong versions, wrong platforms, and invalid launch arguments',
  { skip: process.platform !== 'win32' },
  (t) => {
    const root = project(t);
    const args = ['test-provider.js', 'serve', '--mcp', '--path', root];
    for (const change of [
      { version: '1.6.3' },
      { environment: { platform: 'linux', architecture: process.arch } },
      { checks: codeGraphConformanceChecks.slice(1).map((id) => ({ id, status: 'passed' })) },
      {
        checks: codeGraphConformanceChecks.map((id) => ({
          id,
          status: id === 'watch-modify' ? 'failed' : 'passed',
        })),
      },
      { checks: codeGraphConformanceChecks.map(() => ({ id: 'version', status: 'passed' })) },
    ]) {
      assert.throws(
        () => configureCodeGraph(root, conformance(root, change), process.execPath, args),
        /CodeGraph/,
      );
    }
    const report = conformance(root);
    assert.throws(() => configureCodeGraph(root, report, 'node', args), /absolute executable/);
    assert.throws(
      () => configureCodeGraph(root, report, process.execPath, ['serve', '--mcp']),
      /absolute project root/,
    );
    assert.throws(
      () => configureCodeGraph(root, report, process.execPath, ['serve', '--path', root]),
      /serve and --mcp/,
    );
    assert.equal(existsSync(join(root, '.neomind/optional/codegraph.json')), false);
  },
);

test(
  'CodeGraph enable preserves user-owned server entries and creates review candidates',
  { skip: process.platform !== 'win32' },
  (t) => {
    const root = project(t);
    write(
      root,
      '.mcp.json',
      '{ // Keep this provider\n "mcpServers": {"codegraph": {"command":"user-provider"}}\n}\n',
    );
    write(
      root,
      '.codex/config.toml',
      '# Existing provider\n[mcp_servers.codegraph]\ncommand = "user-provider"\n',
    );
    configureCodeGraph(root, conformance(root), process.execPath, [
      'test-provider.js',
      'serve',
      '--mcp',
      '--path',
      root,
    ]);
    const report = installProject(root);
    assert.equal(parse(read(root, '.mcp.json')).mcpServers.codegraph.command, 'user-provider');
    assert.match(read(root, '.mcp.json'), /Keep this provider/);
    assert.match(read(root, '.codex/config.toml'), /command = "user-provider"/);
    assert.ok(report.conflicts.some((item) => item.path === '.mcp.json#mcpServers.codegraph'));
    assert.ok(report.conflicts.some((item) => item.path === '.codex/config.toml#codegraph'));
    assert.equal(
      doctor(root).platforms[0].capabilities.find((item) => item.capability === 'adapter-files')
        .status,
      'restricted',
    );
  },
);
