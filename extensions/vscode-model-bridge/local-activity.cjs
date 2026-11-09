'use strict';

// In-memory observations belong to this editor host. Persisted 'issued' work
// alone never establishes that a native invocation survived an editor restart.
const { EventEmitter } = require('node:events');
const { resolve } = require('node:path');
const events = new EventEmitter();
events.setMaxListeners(50);
const calls = new Map(), checks = new Map(), queued = new Map();
const key = root => process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
function changed(root) { events.emit('change', key(root)); }

function observeNativeCall(root, requestRef, assignmentRef, metadata) {
  if (!metadata?.invoked || typeof metadata.host_call_id !== 'string') throw new Error('Actual owned invocation required');
  const id = metadata.host_call_id;
  calls.set(id, { root: key(root), request_ref: requestRef, assignment_ref: assignmentRef,
    host_call_id: id, agentName: metadata.agentName, requested_model: structuredClone(metadata.requested_model),
    resolved_model: 'unknown', resolved_provider: 'unknown', started_at: new Date().toISOString() });
  changed(root);
  return () => { if (calls.delete(id)) changed(root); };
}

function observeNativeChecks(root, requestRef) {
  const id = Symbol('owned check execution');
  checks.set(id, { root: key(root), request_ref: requestRef });
  changed(root);
  return () => { if (checks.delete(id)) changed(root); };
}

function observeNativeQueue(root, requestRef, assignmentRef, agentName) {
  const id = Symbol('owned queued assignment');
  queued.set(id, { root: key(root), request_ref: requestRef, assignment_ref: assignmentRef, agentName });
  changed(root);
  return () => { if (queued.delete(id)) changed(root); };
}

function nativeActivity(root) {
  return { calls: structuredClone([...calls.values()].filter(call => call.root === key(root))),
    queued_calls: structuredClone([...queued.values()].filter(call => call.root === key(root))),
    check_requests: [...checks.values()].filter(check => check.root === key(root)).map(check => check.request_ref) };
}

function onNativeActivity(root, listener) {
  const handler = project => { if (project === key(root)) { try { listener(); } catch { /* Views never own execution. */ } } };
  events.on('change', handler);
  return { dispose: () => events.off('change', handler) };
}

module.exports = { observeNativeCall, observeNativeChecks, observeNativeQueue, nativeActivity, onNativeActivity };
