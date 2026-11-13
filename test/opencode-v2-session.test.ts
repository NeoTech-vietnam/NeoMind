import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenCodeV2Session, verifyOpenCodeV2Session, type OpenCodeV2SessionSpec } from '../src/runners/opencode-v2-session.js';
import { openCodeV2Rules } from '../src/runners/opencode-v2-contract.js';

const spec: OpenCodeV2SessionSpec = { logicalId: 'logical', workspace: '/workspace', provider: 'openai', model: 'model', variant: 'high', permissions: openCodeV2Rules(false, false) };
const session = () => ({ data: { id: 'ses_ABC123', agent: 'build', model: { id: spec.model, providerID: spec.provider, variant: spec.variant },
  metadata: { neomindSession: spec.logicalId }, location: { directory: spec.workspace }, permissions: spec.permissions } });

test('OpenCode V2 session create rereads and verifies identity and rules', async () => {
  const calls: string[] = [];
  const server = { request: async (method: 'GET' | 'POST', endpoint: string) => { calls.push(`${method} ${endpoint}`); return session(); } };
  assert.equal(await createOpenCodeV2Session(server, spec), 'ses_ABC123');
  assert.deepEqual(calls, ['POST /api/session', 'GET /api/session/ses_ABC123']);
});

test('OpenCode V2 session fails closed on changed identity or permissions', () => {
  const variants = [
    { ...session().data, id: 'ses_OTHER' }, { ...session().data, parentID: 'ses_PARENT' },
    { ...session().data, agent: 'other' }, { ...session().data, model: { id: 'other', providerID: spec.provider, variant: spec.variant } },
    { ...session().data, location: { directory: '/other' } }, { ...session().data, permissions: [] },
    { ...session().data, metadata: { neomindSession: 'other' } },
  ];
  for (const data of variants) assert.throws(() => verifyOpenCodeV2Session({ data }, spec, 'ses_ABC123'), /identity or permissions mismatch/);
});
