import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { controlledToolNames } from '../dist/controlled-tools.js';

const skillsRoot = new URL('../resources/skills/', import.meta.url);
const binding = (stage, role) => ({ workflow_id: 'NM-SKILL-KNW-0001', invocation_id: 'skill-contract-fixture',
  stage, role, implementation_paths: ['src', 'notes'], verification_paths: ['checks'] });
const roles = {
  'neomind-implement': [['implementation', 'developer']],
  'neomind-finish': [['diagnosis', 'manager']],
  'neomind-cornell': [['implementation', 'developer'], ['synthesis', 'manager']],
  'neomind-design': [['diagnosis', 'architect']],
  'neomind-requirements': [['diagnosis', 'requirements']],
  'neomind-research': [['diagnosis', 'researcher']],
  'neomind-verify': [['verification', 'verifier'], ['review', 'reviewer']],
  'neomind-manager': [['planning', 'manager']],
  'neomind-knowledge-reuse': [['planning', 'manager'], ['diagnosis', 'researcher']],
  'neomind-validate': [['planning', 'manager'], ['verification', 'verifier']],
  'neomind-upstream-watch': [['diagnosis', 'researcher']],
};

test('autoloaded NeoMind skills choose bound worker tools before legacy private guides and lifecycle operations', () => {
  const names = readdirSync(skillsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('neomind-')).map(entry => entry.name).sort();
  assert.deepEqual(names, Object.keys(roles).sort(), 'A new NeoMind skill must declare its controlled-session instruction contract.');
  const allOperations = new Set(Object.values(roles).flat().flatMap(([stage, role]) => controlledToolNames(binding(stage, role))));
  for (const name of names) {
    const content = readFileSync(new URL(`${name}/SKILL.md`, skillsRoot), 'utf8');
    const workerAt = content.indexOf('## Backend-owned session');
    const legacyAt = content.indexOf('## Client intake and other saved modes');
    assert.ok(workerAt >= 0 && legacyAt > workerAt, name);
    const worker = content.slice(workerAt, legacyAt), legacy = content.slice(legacyAt);
    assert.match(worker, /explicit NeoMind-owned role\/stage packet and bound tools/, name);
    assert.match(worker, /one compact `assignment_report`/, name);
    assert.doesNotMatch(worker, /\.neomind\/(?:roles|automation|guides\/(?:workflow|manager|process))|assignment_claim|assignment_progress|record_create|record_update|recipe_prepare|manager_finish|task accept|seven.section/i, name);
    const available = new Set(roles[name].flatMap(([stage, role]) => controlledToolNames(binding(stage, role))));
    for (const [, operation] of worker.matchAll(/`([a-z][a-z0-9_]*)`/g))
      if (allOperations.has(operation)) assert.ok(available.has(operation), `${name}: ${operation}`);
    assert.match(legacy, /matching saved non-controlled execution mode/, name);
  }
  const implement = readFileSync(new URL('neomind-implement/SKILL.md', skillsRoot), 'utf8');
  const finish = readFileSync(new URL('neomind-finish/SKILL.md', skillsRoot), 'utf8');
  assert.match(implement.slice(implement.indexOf('## Client intake and other saved modes')), /all seven sections/);
  assert.match(finish.slice(finish.indexOf('## Client intake and other saved modes')), /seven-section work record/);
});
