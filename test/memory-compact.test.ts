import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultProject } from '../src/domain/templates.js';
import { RunManager } from '../src/runtime/run-manager.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import { compactLegacyLesson } from '../src/runtime/memory-proposals.js';
import { createEditorApi } from '../src/ui-server/server.js';
import { readProject } from '../src/runtime/project.js';
import { compactLegacyLessonBody, maxLessonBodyLength, memoryTitle, repairLessonBody, sourceRunIds, splitBodyParts } from '../src/memory/lesson-body.js';

const quote = 'Hint: Thử lần theo hai chỉ số `i` và `j` ngay ở lần lặp đầu tiên với mảng một phần tử. '.repeat(3);
const artifact = (text: string) => ({ kind: 'artifact', nodeId: 'coach', sha256: 'a'.repeat(64), quote: text });
/** Reviewer output shaped like the leetcode-practice runs: long criteria first, then the findings. */
function reviewerOutput(criteria: number) {
  return { nodeId: 'audit', attemptId: 'ad9d9f4a-e7f2-4182-a942-a0c957a4917e', summary: 'Báo cáo có đủ các mục nhưng còn hai vấn đề.',
    evidence: { criteria: Array.from({ length: criteria }, (_, index) => ({ criterion: `R${index + 1} criterion`, status: 'pass', references: [artifact(quote)] })),
      findings: [{ id: 'F1', criterion: 'R2 one hint per issue', explanation: 'Cùng một issue nhận hai gợi ý.', references: [artifact(quote)] },
        { id: 'F2', criterion: 'R5 every claim backed by trace or run', explanation: 'Báo cáo nói "O(n) thời gian" nhưng code thật là O(n²) vì vòng lặp lồng nhau.',
          references: [{ kind: 'source', path: 'c/hash/0217-contains-duplicate/solution.c', line: 9, quote: 'for (int j = i + 1; j < n; j++)' }, artifact(quote), artifact(quote)] }] },
    result: { reviewerId: 'reviewer', sessionId: 's', baselineHash: 'b'.repeat(64), verdict: 'needs_changes', findingIds: ['F1', 'F2'] } };
}
/** Exactly what `proposeRepairLessons` wrote before 12/11: header, reviewer JSON cut at 5000, the agent's reply. */
const legacyBody = (runId: string, findingId: string, payload: unknown) => `Review finding corrected in run ${runId}: ${findingId}\n\nOriginal review evidence:\n${JSON.stringify(payload).slice(0, 5000)}\n\nImplementation response:\n${'Đã sửa báo cáo. '.repeat(150)}\n\nThis is a proposed lesson from a completed repair. Review its applicability before sharing.`;
const expected = (runId: string) => `Giữ đúng tiêu chí review: R5 every claim backed by trace or run\nVấn đề: Báo cáo nói "O(n) thời gian" nhưng code thật là O(n²) vì vòng lặp lồng nhau.\nĐã sửa trong run ${runId} (bước audit). File: c/hash/0217-contains-duplicate/solution.c:9`;

test('old repair lessons compact to the criterion, explanation and file of their own finding, even when the JSON was cut', () => {
  const whole = legacyBody('run-whole', 'F2', reviewerOutput(2));
  assert.ok(JSON.stringify(reviewerOutput(2)).length < 5000, 'fixture: this evidence fits whole');
  assert.equal(compactLegacyLessonBody(whole)?.body, expected('run-whole'));
  // Cut inside F2's references: criterion, explanation and the complete source reference survive.
  const cut = reviewerOutput(9), text = JSON.stringify(cut), f2 = text.indexOf('{"id":"F2"');
  assert.ok(f2 > 0 && f2 < 5000 && text.indexOf('"quote":"for (int') < 5000 && text.length > 5000, 'fixture: the cut lands inside F2');
  const compacted = compactLegacyLessonBody(legacyBody('run-cut', 'F2', cut));
  assert.equal(compacted?.body, expected('run-cut')); assert.equal(compacted?.findingId, 'F2');
  assert.equal(compactLegacyLessonBody(legacyBody('run-cut', 'F1', cut))?.body.split('\n')[0], 'Giữ đúng tiêu chí review: R2 one hint per issue');
  // A finding cut before it starts, or text in any other format, is left alone.
  assert.equal(compactLegacyLessonBody(legacyBody('run-lost', 'F2', reviewerOutput(40))), undefined);
  assert.equal(compactLegacyLessonBody('Chạy npm test trước khi giao thay đổi.'), undefined);
  assert.equal(compactLegacyLessonBody(expected('run-whole')), undefined, 'compacting twice changes nothing');
  // A finding cut away from the text is recovered from the source run's journal: the output that requested the repair.
  const lost = legacyBody('run-lost', 'F2', reviewerOutput(40)), full = reviewerOutput(40);
  const events = [{ sequence: 7, type: 'reviewer_output', payload: full }, { sequence: 8, type: 'repair_round_started', payload: { findingIds: ['F1', 'F2'] } },
    { sequence: 12, type: 'reviewer_output', payload: { ...full, evidence: { criteria: [], findings: [{ id: 'F2', criterion: 'later review', explanation: 'not this one', references: [] }] } } }] as unknown as Parameters<typeof compactLegacyLesson>[1];
  assert.equal(compactLegacyLesson(lost, undefined), undefined, 'without the journal the lesson stays as it is');
  assert.equal(compactLegacyLesson(lost, events), expected('run-lost'));
  assert.equal(compactLegacyLesson(legacyBody('run-whole', 'F2', reviewerOutput(2)), []), expected('run-whole'), 'the text wins when it has the finding');
  assert.equal(compactLegacyLesson('Chạy npm test.', events), undefined);
});

test('lesson text helpers keep bodies short and give the UI a title, folded JSON and source runs', () => {
  const long = repairLessonBody({ runId: 'run-1', nodeId: 'verify', finding: { criterion: 'c'.repeat(500), explanation: 'e '.repeat(2000), references: [] } });
  assert.ok(long.length <= maxLessonBodyLength && long.split('\n').length === 3);
  const legacy = legacyBody('run-x', 'F2', reviewerOutput(9));
  assert.equal(memoryTitle(legacy).title, 'Review finding corrected in run run-x: F2');
  const parts = splitBodyParts(legacy);
  assert.deepEqual(parts.map(part => part.kind), ['text', 'json', 'text']);
  const json = parts.find(part => part.kind === 'json');
  assert.ok(json?.kind === 'json' && json.pretty === undefined && json.summary.startsWith('JSON bị cắt'));
  assert.ok(splitBodyParts(`Tiêu đề\n${JSON.stringify(reviewerOutput(2))}`).some(part => part.kind === 'json' && part.pretty?.includes('\n  "nodeId": "audit"')));
  assert.deepEqual(splitBodyParts('Một dòng\nHai dòng'), [{ kind: 'text', text: 'Một dòng\nHai dòng' }]);
  assert.deepEqual(sourceRunIds(['run:run-a', 'run:run-a/event:4', 'proposal:p', 'run:run-b/plan:p@1', 'compacted']), ['run-a', 'run-b']);
});

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-')), repo = path.join(root, 'r');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n'); await mkdir(path.join(repo, 'neomind'));
  await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify(structuredClone(defaultProject)));
  git('add', '.'); git('commit', '-qm', 'baseline');
  const manager = await RunManager.open(repo, path.join(root, 's'), new RunnerRegistry([]));
  return { repo, manager, api: createEditorApi(repo, async () => manager) };
}

test('memory compact rewrites old approved lessons and pending proposals, dry-run writes nothing, other records stay', async () => {
  const f = await project();
  try {
    const { projectId } = await readProject(f.repo);
    // An approved lesson in the old format, scoped to the project id like old repair lessons, and an ordinary note.
    const proposed = await f.manager.proposeMemory({ type: 'lesson', scope: projectId, tags: ['repair', 'review'], body: legacyBody('run-old', 'F2', reviewerOutput(9)), sources: ['run:run-old', 'run:run-old/event:191'], reason: 'fixture' }, 'user_note');
    assert.ok(proposed.created);
    const approved = (await f.manager.approveMemoryProposal({ runId: null, proposalId: proposed.proposalId, proposalHash: proposed.proposalHash })).record;
    const note = (await f.manager.addMemoryNote({ type: 'lesson', body: 'Chạy npm test trước khi giao.' })).record;
    const pending = await f.manager.proposeMemory({ type: 'lesson', body: legacyBody('run-pending', 'F1', reviewerOutput(2)), sources: ['run:run-pending'], reason: 'fixture' }, 'user_note');
    assert.ok(pending.created);
    const files = async () => Promise.all((await readdir(path.join(f.repo, 'neomind/memory/lessons'))).sort().map(file => readFile(path.join(f.repo, 'neomind/memory/lessons', file), 'utf8')));
    const before = await files(), queue = async () => (await f.manager.memoryProposals()).proposals.find(item => item.proposal.proposalId === pending.proposalId)!;

    const dry = await f.api({ method: 'POST', path: '/api/memory/compact', body: { dryRun: true } });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    const preview = dry.body as { dryRun: boolean; changes: { kind: string; key: string; after: string; applied: boolean }[] };
    assert.deepEqual(preview.changes.map(change => [change.kind, change.key, change.applied]), [['record', `lesson/${approved.header.id}`, false], ['proposal', `project/${pending.proposalId}`, false]]);
    assert.equal(preview.changes[0]!.after, expected('run-old'));
    assert.deepEqual(await files(), before, 'dry-run leaves the records'); assert.equal((await queue()).version, 1, 'and the proposals');

    const result = await f.manager.compactMemory({ source: 'cli' });
    assert.deepEqual(result.changes.map(change => change.applied), [true, true]);
    const record = f.manager.getMemory('lesson', approved.header.id).record;
    assert.equal(record.body, expected('run-old')); assert.equal(record.header.scope, 'project');
    assert.deepEqual(record.header.sources.slice(0, 4), approved.header.sources, 'provenance is kept');
    assert.ok(record.header.sources.includes('compacted') && record.header.sources.some(source => source.startsWith('user-confirmation:')));
    assert.equal(f.manager.getMemory('lesson', note.header.id).record.revision, note.revision, 'a record in another format is not touched');
    const revised = await queue();
    assert.equal(revised.version, 2); assert.match(revised.proposal.record.body, /^Giữ đúng tiêu chí review: R2 one hint per issue\n/);
    assert.equal((await f.manager.compactMemory({ dryRun: true })).changes.length, 0, 'compacting again finds nothing');

    // One item at a time, as the UI does it.
    const single = await f.manager.proposeMemory({ type: 'lesson', body: legacyBody('run-one', 'F2', reviewerOutput(2)), sources: ['run:run-one'], reason: 'fixture' }, 'user_note');
    assert.ok(single.created);
    const targeted = await f.api({ method: 'POST', path: '/api/memory/compact', body: { target: { runId: null, proposalId: single.proposalId } } });
    assert.equal(targeted.status, 200, JSON.stringify(targeted.body));
    assert.deepEqual((targeted.body as { changes: { key: string }[] }).changes.map(change => change.key), [`project/${single.proposalId}`]);
  } finally { await f.manager.close(); }
});

test('an AI session proposal must be a short note, not a pasted log', async () => {
  const f = await project();
  try {
    await assert.rejects(f.manager.proposeMemory({ type: 'lesson', body: 'x'.repeat(1501), sources: ['session:s'], reason: 'r' }, 'ai_session'), /viết gọn dưới 1500 ký tự/);
    assert.ok((await f.manager.proposeMemory({ type: 'lesson', body: 'Chạy build:ui sau khi sửa giao diện.', sources: ['session:s'], reason: 'r' }, 'ai_session')).created);
  } finally { await f.manager.close(); }
});
