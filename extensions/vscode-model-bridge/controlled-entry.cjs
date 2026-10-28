const { createHash, randomUUID } = require('node:crypto');
const { existsSync, lstatSync, readFileSync, realpathSync } = require('node:fs');

const messages = {
  INTAKE_PENDING: 'A previous intake has an unknown response. Retry that saved request or refresh its receipt before starting different work.',
  INTAKE_IDENTITY_CHANGED: 'This intake is already bound to different content. Choose Start another request for a new request.',
  INTAKE_RECEIPT_INVALID: 'The saved intake receipt could not be reconciled. Its identity was preserved; no replacement workflow was created.',
  INTAKE_RESPONSE_UNKNOWN: 'The intake response is unknown. Retry the same request; WorkForce retains its saved request identity.',
  INTAKE_NEW_CONTEXT_REQUIRED: 'An identical new task needs a fresh client turn context. Use Start another request in WorkForce Universe if this client cannot provide one.',
  INTAKE_CONTEXT_REQUIRED: 'Several intentional intakes contain this same request. Select the saved workflow or retry from its original client context; WorkForce will not guess which intake you mean.',
  INTAKE_ACK_REQUIRED: 'Render and acknowledge the saved receipt before choosing Start another request.',
  INTAKE_STORE_INVALID: 'The local intake journal is invalid or unavailable. Restore it before submitting again; no identity was replaced.',
};
class ControlledEntryError extends Error {
  constructor(code) { super(messages[code] ?? messages.INTAKE_STORE_INVALID); this.code = code; }
}
const fail = code => { throw new ControlledEntryError(code); };
const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const inflight = new Map();

/** Extension-host identities; no platform invocation token or credential is serialized. */
function createControlledEntryReceipts({ runtime, root, surface }) {
  if (!['panel', 'lm'].includes(surface) || ['withOperationLock', 'atomicWrite', 'safePath'].some(name => typeof runtime?.[name] !== 'function'))
    fail('INTAKE_STORE_INVALID');
  root = realpathSync.native(root);
  const rootHash = sha(process.platform === 'win32' ? root.toLowerCase() : root);
  const path = runtime.safePath(root, `.workforce/controlled/entrypoints/${surface}.json`);
  const lock = action => runtime.withOperationLock(root, `controlled-entry-${surface}`, action);
  const save = data => runtime.atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
  function load() {
    if (!existsSync(path)) return { schema_version: 1, root_hash: rootHash, surface, entries: [] };
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) fail('INTAKE_STORE_INVALID');
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (data.schema_version !== 1 || data.root_hash !== rootHash || data.surface !== surface || !Array.isArray(data.entries) ||
          data.entries.length > 16384 || data.entries.some(entry => !uuid(entry.generation) || !uuid(entry.request_id) ||
            !['prepared', 'unknown', 'accepted', 'acknowledged', 'rejected'].includes(entry.state)) ||
          new Set(data.entries.map(entry => entry.generation)).size !== data.entries.length ||
          (data.current && !data.entries.some(entry => entry.generation === data.current))) fail('INTAKE_STORE_INVALID');
      return data;
    } catch { fail('INTAKE_STORE_INVALID'); }
  }
  function fresh(data, context) {
    if (data.entries.length >= 16384) fail('INTAKE_STORE_INVALID');
    const entry = { generation: randomUUID(), request_id: randomUUID(), state: 'prepared', created_at: new Date().toISOString(),
      ...(context ? { context } : {}) };
    data.entries.push(entry); data.current = entry.generation; return entry;
  }
  function projection(entry) {
    return entry && { generation: entry.generation, state: entry.state, payload_sha256: entry.payload_sha256,
      ...(entry.workflow_id ? { workflow_id: entry.workflow_id } : {}),
      ...(entry.payload ? { requirement: entry.payload.requirement, ...(entry.payload.title ? { title: entry.payload.title } : {}) } : {}) };
  }
  function payloadFor(input) {
    if (typeof input?.requirement !== 'string' || !input.requirement.trim() || input.requirement.length > 20000 ||
        input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 256)) fail('INTAKE_IDENTITY_CHANGED');
    return { requirement: input.requirement.trim(), ...(input.title ? { title: input.title.trim() } : {}) };
  }
  function accepted(generation, workflow) {
    if (!workflow || typeof workflow.workflow_id !== 'string' || typeof workflow.epoch_id !== 'string') fail('INTAKE_RECEIPT_INVALID');
    return lock(() => {
      const data = load(), entry = data.entries.find(entry => entry.generation === generation);
      if (!entry || workflow.request_id !== entry.request_id || entry.workflow_id && entry.workflow_id !== workflow.workflow_id) fail('INTAKE_RECEIPT_INVALID');
      entry.workflow_id = workflow.workflow_id; entry.epoch_id = workflow.epoch_id;
      if (entry.state !== 'acknowledged') entry.state = 'accepted';
      entry.accepted_at ??= new Date().toISOString(); save(data); return entry;
    });
  }
  async function find(entry, knownWorkflows) {
    const values = knownWorkflows ?? await runtime.controlledStatus(root);
    const matches = (Array.isArray(values) ? values : values?.workflow_id ? [values] : []).filter(value => value.request_id === entry.request_id);
    if (matches.length > 1 || matches.some(value => value.requirement !== entry.payload?.requirement && entry.payload)) fail('INTAKE_RECEIPT_INVALID');
    return matches[0];
  }
  async function recover(knownWorkflows) {
    let entry = lock(() => { const data = load(); return data.entries.find(entry => entry.generation === data.current); });
    if (!entry) return { intake: null, workflow: undefined };
    let workflow;
    if (entry.payload_sha256) {
      workflow = await find(entry, knownWorkflows);
      if (workflow) entry = accepted(entry.generation, workflow);
      else if (entry.workflow_id) fail('INTAKE_RECEIPT_INVALID');
    }
    return { intake: projection(entry), workflow };
  }
  function acknowledge(generation, workflowId) {
    return lock(() => {
      const data = load(), entry = data.entries.find(entry => entry.generation === generation);
      if (!entry || data.current !== generation || !entry.workflow_id || entry.workflow_id !== workflowId) return false;
      entry.state = 'acknowledged'; delete entry.payload; save(data); return true;
    });
  }
  function acknowledgeWorkflow(workflowId) {
    return lock(() => {
      const data = load(), entry = data.entries.find(entry => entry.generation === data.current);
      if (!entry || entry.workflow_id !== workflowId) return false;
      entry.state = 'acknowledged'; delete entry.payload; save(data); return true;
    });
  }
  function newIntent(generation) {
    return lock(() => {
      const data = load(), current = data.entries.find(entry => entry.generation === data.current);
      const prior = data.entries.find(entry => entry.generation === generation);
      if (prior?.next_generation) {
        const next = data.entries.find(entry => entry.generation === prior.next_generation);
        if (!next) fail('INTAKE_STORE_INVALID'); return projection(next);
      }
      if (!current || current.generation !== generation || current.state !== 'acknowledged') fail('INTAKE_ACK_REQUIRED');
      const entry = fresh(data); current.next_generation = entry.generation; save(data); return projection(entry);
    });
  }
  async function submit(input, { generation, newTask = false, context, beforeDispatch } = {}) {
    const payload = payloadFor(input), digest = sha(JSON.stringify(payload));
    // Reconcile the previous pending outcome before deciding that different input
    // can start another intake. A lost response never implies failed execution.
    await recover();
    const entry = lock(() => {
      const data = load(), current = data.entries.find(entry => entry.generation === data.current);
      let entry = generation ? data.entries.find(entry => entry.generation === generation)
        : context ? data.entries.find(entry => entry.context === context && entry.payload_sha256 === digest) : undefined;
      if (generation && !entry) fail('INTAKE_IDENTITY_CHANGED');
      const matches = [...data.entries].reverse().filter(entry => entry.payload_sha256 === digest);
      if (!entry && !newTask && matches.length > 1) fail('INTAKE_CONTEXT_REQUIRED');
      const same = matches[0];
      if (!entry && same) {
        if (!newTask || same.state !== 'acknowledged') entry = same;
        else {
          const owner = typeof context === 'string' ? context.split(':')[0] : undefined;
          const previousOwner = typeof same.context === 'string' ? same.context.split(':')[0] : undefined;
          if (!uuid(owner) || owner !== previousOwner) fail('INTAKE_NEW_CONTEXT_REQUIRED');
        }
      }
      if (!entry && current?.payload_sha256 && ['prepared', 'unknown'].includes(current.state)) fail('INTAKE_PENDING');
      if (!entry) entry = current && !current.payload_sha256 ? current : fresh(data, context);
      if (entry.payload_sha256 && entry.payload_sha256 !== digest) fail('INTAKE_IDENTITY_CHANGED');
      entry.payload_sha256 = digest; if (!entry.workflow_id) entry.payload ??= payload; if (context) entry.context ??= context;
      save(data); return entry;
    });
    const key = `${rootHash}:${surface}:${entry.request_id}`;
    const existing = inflight.get(key); if (existing) return existing;
    const job = (async () => {
      let workflow = await find(entry);
      if (!workflow) {
        if (entry.workflow_id) fail('INTAKE_RECEIPT_INVALID');
        try { beforeDispatch?.(); }
        catch (error) {
          lock(() => { const data = load(), saved = data.entries.find(value => value.generation === entry.generation);
            if (saved && !saved.workflow_id) { saved.state = 'rejected'; save(data); } });
          throw error;
        }
        try { workflow = await runtime.startControlledWorkflow(root, { ...payload, request_id: entry.request_id }); }
        catch (error) {
          workflow = await find(entry).catch(() => undefined);
          if (!workflow) {
            lock(() => { const data = load(), saved = data.entries.find(value => value.generation === entry.generation);
              if (saved && !saved.workflow_id) { saved.state = error?.code === 'CONTINUATION_PILOT_UNSUPPORTED' ? 'rejected' : 'unknown'; save(data); } });
            if (error?.code === 'CONTINUATION_PILOT_UNSUPPORTED') throw error;
            fail('INTAKE_RESPONSE_UNKNOWN');
          }
        }
      }
      const saved = accepted(entry.generation, workflow);
      return { workflow, intake: projection(saved) };
    })();
    inflight.set(key, job);
    try { return await job; } finally { if (inflight.get(key) === job) inflight.delete(key); }
  }
  return { recover, submit, acknowledge, acknowledgeWorkflow, newIntent };
}
module.exports = { createControlledEntryReceipts, ControlledEntryError };
