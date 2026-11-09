'use strict';
const { appendFileSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');

const hash = value => typeof value === 'string' ? createHash('sha256').update(value).digest('hex') : null;
const events = new Set(['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']);
const input = JSON.parse(readFileSync(0, 'utf8'));
const event = input.hook_event_name;
if (!events.has(event)) process.exit(0);
const fixture = require(join(__dirname, '..', 'extension', 'fixture.json'));
const string = value => typeof value === 'string' && /^[a-z0-9._/ -]{1,160}$/i.test(value) ? value : null;
const modelLabel = value => typeof value === 'string' && /^[a-z0-9._/ :()@-]{1,160}$/i.test(value) ? value : null;
const tool = string(input.tool_name);
const args = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
const command = [args.command, args.commandLine].find(value => typeof value === 'string');
const worker = input.agent_type === fixture.worker ? fixture.worker : null;
const target = args.agentName === fixture.worker ? fixture.worker : null;
const observation = {
  event,
  session: hash(input.session_id),
  agent: hash(input.agent_id),
  agent_type: worker,
  tool,
  tool_call: hash(input.tool_use_id),
  tool_input_keys: Object.keys(args).filter(string).sort(),
  target,
  target_name: string(args.agentName),
  requested_model: modelLabel(args.model),
  fixture_command: command?.trim() === 'node --test m2-fixture.test.cjs',
  check_marker_in_response: JSON.stringify(input.tool_response ?? null).includes(fixture.marker),
};
const delegation = target && /(?:^|\/)runSubagent$/i.test(tool ?? '');
if (event === 'PreToolUse' && delegation) {
  let policy;
  try { policy = JSON.parse(readFileSync(join(fixture.evidence, 'model-policy.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (typeof policy?.override === 'string') {
    observation.model_override_requested = true;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...args, model: policy.override } },
    }));
  }
}
appendFileSync(join(fixture.evidence, 'hooks.jsonl'), JSON.stringify(observation) + '\n', { mode: 0o600 });
