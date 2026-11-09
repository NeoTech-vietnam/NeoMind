'use strict';

const { createLocalDelegator } = require('./local-delegation.cjs');
const { observeNativeCall, observeNativeChecks, observeNativeQueue } = require('./local-activity.cjs');
const roles = ['WF.FnD', 'WF.Reviewer', 'WF.Tester'];
const issue = (code, category, message) => ({ code, category, message });
const backendIssue = () => issue('NATIVE_BACKEND_FAILED', 'backend', 'The runtime could not confirm the next operation. Verified delivery is not claimed.');
const editorRecoveryIssue = error => {
  const messages = {
    EDITOR_EFFECTS_UNCONFIRMED: 'The prior editor did not retain a settled native outcome or drained checker checkpoint. Existing effects are uncertain; no work was replayed.',
    EDITOR_INPUTS_CHANGED: 'Source, products, checker inputs or selected guidance changed after the editor stopped. Retained work needs reconciliation; no evidence was reused or files overwritten.',
    EDITOR_CHECK_RECONCILIATION_REQUIRED: 'The interrupted checker has unresolved non-cancellation findings or stale independent inspections. No check or model was replayed.',
    NATIVE_REPAIR_ALLOWANCE_EXHAUSTED: 'The configured implementation repair allowance is spent. Retained products and findings were preserved; no new worker was started.',
    EDITOR_OWNERSHIP_CHANGED: 'A newer controller owns the retained request. This earlier call did not change its current work or acceptance.',
    NATIVE_CHECK_CANCELLED: 'The checker was explicitly cancelled. Its actual result and products were retained; editor recovery did not restart it.',
    NATIVE_CANCELLED_EFFECTS_UNCONFIRMED: 'The cancelled native call does not retain a bound, unchanged ended outcome. Existing work was preserved; no call was replayed.',
    NATIVE_CANCELLED_INPUTS_CHANGED: 'Products, inputs or selected guidance changed after the cancelled native call. Retained work needs reconciliation before explicit continuation.',
    NATIVE_CANCELLED_ROLE_RECONCILIATION_REQUIRED: 'Explicit native-call continuation requires an unfinished observed role and no started checks. Existing results were retained; no work was replayed.',
  };
  return Object.hasOwn(messages, error?.code) ? issue(error.code,
    error.code === 'NATIVE_REPAIR_ALLOWANCE_EXHAUSTED' ? 'product-repair' : 'interruption', messages[error.code]) : undefined;
};
const selectedSkillIssue = error => error?.code === 'NATIVE_PACKAGE_CHANGED'
  ? issue('NATIVE_PACKAGE_CHANGED', 'capability', 'Selected pinned package source changed before dispatch. Existing products and native observations were retained; no modified package code was invoked.')
  : ['SELECTED_SKILL_UNAVAILABLE', 'SELECTED_SKILL_CHANGED'].includes(error?.code)
  ? issue(error.code, 'capability', error.code === 'SELECTED_SKILL_UNAVAILABLE'
    ? 'An explicitly selected workspace skill is missing, disabled, ambiguous or unavailable. Select an installed current skill, or omit optional skills to use ordinary project tools.'
    : 'An explicitly selected workspace skill or its receipt changed. Existing work is retained; restore the selected component or explicitly choose a current selection.') : undefined;

function completedRoles(state) {
  return roles.every(role => {
    const job = state?.assignments?.findLast(job => job.agentName === role);
    return job?.state === 'completed' && job.report?.verdict === 'pass' && Array.isArray(job.report.findings) && job.report.findings.length === 0;
  });
}

function publicRequest(state) {
  if (!state) return;
  const currentRoles = roles.flatMap(role => {
    const job = state.assignments?.findLast(job => job.agentName === role);
    return job ? [job] : [];
  });
  return {
    request_key: state.request_key, title: state.title, transport: 'vscode-native', status: state.status,
    accepted: state.accepted === true,
    artifacts: (state.artifacts ?? []).map(file => ({ path: file.path, exists: file.exists === true })),
    roles: currentRoles.map(job => ({ role: job.agentName, state: job.state,
      ...(job.report ? { summary: job.report.summary, findings: job.report.findings } : {}) })),
    retained_attempts: Math.max(0, (state.assignments?.length ?? 0) - currentRoles.length),
    ...(state.input_reconciliation ? { input_reconciliation: { status: state.input_reconciliation.status,
      code: state.input_reconciliation.code, message: state.input_reconciliation.message } } : {}),
    ...(state.learning ? { tool_learning: { candidates: state.learning.candidates.length, issues: state.learning.issues } } : {}),
    checks: (state.checks ?? []).map(check => ({ title: check.title, level: check.level, state: check.state,
      ...(Number.isInteger(check.result?.exit_code) ? { exit_code: check.result.exit_code } : {}),
      ...(typeof check.log_path === 'string' ? { log_path: check.log_path } : {}) })),
  };
}

function createLocalRequestRunner(vscode, runtime, root, options = {}) {
  const delegator = createLocalDelegator(vscode, runtime.nativeWorkerProfiles, options.capabilities), active = new Set(), owners = new Map();
  let disposed = false, disposing;
  let workers = 0;
  const waiting = [];
  function admitWorkers() {
    while (waiting.length && workers < waiting[0].limit) {
      const entry = waiting.shift();
      entry.signal.removeEventListener('abort', entry.cancel);
      if (entry.signal.aborted) { entry.resolve(false); continue; }
      workers++; entry.resolve(true);
    }
  }
  async function invoke(job, token, operation, observe, requestRef, assignmentRef, preflight, preparedProfile) {
    const limit = runtime.readConfig?.(root)?.max_workers ?? 3;
    if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error('Invalid configured worker limit');
    const endWaiting = workers >= limit ? observeNativeQueue(root, requestRef, assignmentRef, job.agentName) : () => {};
    const admitted = await new Promise(resolve => {
      const entry = { resolve, limit, signal: operation.abort.signal };
      entry.cancel = () => {
        const index = waiting.indexOf(entry);
        if (index < 0) return;
        waiting.splice(index, 1); resolve(false); admitWorkers();
      };
      if (entry.signal.aborted) { resolve(false); return; }
      entry.signal.addEventListener('abort', entry.cancel, { once: true });
      waiting.push(entry); admitWorkers();
    });
    endWaiting();
    // The delegator returns a non-invoked cancellation observation when a queued
    // operation is cancelled. It never receives another request's ownership.
    try {
      if (admitted && !operation.source.token.isCancellationRequested) await preflight?.();
      const result = await delegator.invoke(job, token, operation.source.token, observe, preparedProfile);
      if (preparedProfile?.profile && !result.metadata.invoked && result.error?.code === 'NATIVE_MCP_BINDING_CHANGED' && !operation.source.token.isCancellationRequested) {
        await options.capabilities.fallback(requestRef, assignmentRef, operation.roleOnly);
        return await delegator.invoke(job, token, operation.source.token, observe);
      }
      return result;
    }
    finally { if (admitted) { workers--; admitWorkers(); } }
  }

  async function executeRoleJob(input, token, operation) {
    let state, phase = 'validate';
    const result = error => ({ status: error ? error.category === 'cancellation' ? 'cancelled' : 'uncertain' : state?.completion ?? 'rejected', accepted: false,
      delivery_scope: 'role-only', ...(state ? { job: { request_key: state.request_key, role: state.role,
        title: state.title, status: state.status, completion: state.completion, artifacts: state.artifacts,
        ...(state.report ? { summary: state.report.summary, findings: state.report.findings } : {}),
        ...(state.report_path ? { report_path: state.report_path } : {}) } } : {}), ...(error ? { error } : {}) });
    if (token == null) return result(issue('INVOCATION_TOKEN_REQUIRED', 'context', 'A current native tool invocation token is required.'));
    if (operation.source.token.isCancellationRequested) return result(issue('CANCELLED', 'cancellation', 'The direct role job was cancelled before dispatch.'));
    let parsed;
    try { parsed = runtime.nativeRoleJobSchema.parse(input); }
    catch { return result(issue('INVALID_REQUEST', 'input', 'Supply the selected role, professional requirement and scoped project paths.')); }
    try {
      phase = 'open';
      options.capabilities?.stage(parsed, true);
      state = await runtime.openNativeRoleJob(root, parsed);
      const capability = options.capabilities?.prepare(state, { assignment_ref: state.assignment_ref, agentName: state.role }, true);
      if (capability) state = capability.state;
      phase = 'delegate';
      const preference = await options.modelForRole?.(state.role);
      const outcome = await invoke({ agentName: state.role, prompt: state.prompt + (capability?.promptSuffix ?? ''), description: state.description,
        ...(preference ? { model: { id: preference.id, vendor: preference.vendor } } : {}) }, token, operation,
        metadata => observeNativeCall(root, state.request_ref, state.assignment_ref, metadata), state.request_ref, state.assignment_ref,
        () => { if (state.dispatch_capabilities) options.capabilities?.assertCurrent?.(state.request_ref, true);
          if (state.skill_contexts?.length) runtime.assertNativeRoleSkillsCurrent?.(root, state.request_ref); }, capability?.prepared);
      phase = 'save';
      const interrupted = operation.source.token.isCancellationRequested;
      const error = interrupted ? issue('CANCELLED', 'cancellation', 'The direct role job was cancelled; its actual returned report is retained without scoped completion.') : outcome.error;
      state = await runtime.recordNativeRoleResult(root, { request_ref: state.request_ref, assignment_ref: state.assignment_ref,
        ...(outcome.metadata.invoked ? { invocation: { ...outcome.metadata, status: interrupted ? 'cancelled' : outcome.status }, raw_result: outcome.raw_result } : {}),
        ...(error ? { error: { code: error.code, category: error.category } } : {}) });
      await options.capabilities?.settle(state, true);
      return result(error);
    } catch (error) {
      const capability = selectedSkillIssue(error);
      if (capability && state) {
        try {
          state = await runtime.recordNativeRoleResult(root, { request_ref: state.request_ref, assignment_ref: state.assignment_ref,
            error: { code: capability.code, category: capability.category } });
        } catch { return result({ ...backendIssue(), phase: 'save' }); }
      }
      return result({ ...(capability ?? backendIssue()), phase });
    }
  }

  async function execute(input, toolInvocationToken, operation, requestToResume, recheckOnly = false) {
    let parsed, state, requestRef;
    const privateValues = new Set();
    function remember(value, followNewOwner = false) {
      state = value;
      if (!state) return;
      if (!followNewOwner && operation.ownsGeneration !== undefined && operation.ownsGeneration !== (state.editor_generation ?? 0))
        throw Object.assign(new Error('A newer controller owns this request.'), { code: 'EDITOR_OWNERSHIP_CHANGED' });
      if (typeof state.request_ref === 'string' && !operation.requestRef) {
        operation.requestRef = state.request_ref; owners.set(state.request_ref, operation);
      }
      for (const id of [state.request_ref, state.task_id, state.final_report_id, ...(state.record_ids ?? [])])
        if (typeof id === 'string' && id) privateValues.add(id);
      for (const job of state.assignments ?? []) for (const value of [job.assignment_ref, job.prompt, job.report_record_id,
        job.invocation?.host_call_id, job.invocation?.native_context_id]) if (typeof value === 'string' && value) privateValues.add(value);
    }
    function sanitize(value) {
      if (typeof value === 'string') {
        for (const secret of privateValues) value = value.split(secret).join('[private]');
        return value;
      }
      if (Array.isArray(value)) return value.map(sanitize);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
      return value;
    }
    const result = error => sanitize({ status: state?.status ?? (error?.category === 'cancellation' ? 'cancelled' : 'rejected'),
      ...(state ? { request: publicRequest(state) } : {}), ...(error ? { error } : {}) });
    const cancellationIssue = () => issue(operation.reason === 'editor' ? 'EDITOR_CLOSED' : 'CANCELLED', 'cancellation',
      'Execution was cancelled; retained work is not a claim of verified delivery.');
    async function interrupt(error) {
      if (requestRef) {
        try { remember(await runtime.interruptNativeRequest(root, requestRef, { code: error.code, category: error.category,
          ...(operation.ownsGeneration === undefined ? {} : { editor_generation: operation.ownsGeneration }) })); }
        catch (failure) { if (failure?.code === 'EDITOR_OWNERSHIP_CHANGED') return result(editorRecoveryIssue(failure));
          return sanitize({ ...result(issue('NATIVE_STATE_UNAVAILABLE', 'backend', 'The latest saved state could not be confirmed. Existing work has not been reported as accepted.')),
          status: 'uncertain', saved_state_confirmed: false }); }
      }
      return result(error);
    }
    const cancelled = () => operation.abort.signal.aborted || operation.source.token.isCancellationRequested;
    let evidenceReassessment;
    async function reassessEvidence(explicit = false) {
      if ((!explicit && options.automaticRepair === false) || typeof runtime.reassessNativeTesterFindings !== 'function') return false;
      const tester = state?.assignments?.at(-1);
      if (tester?.agentName !== 'WF.Tester' || tester.state !== 'findings') return false;
      const endChecks = observeNativeChecks(root, requestRef);
      try { evidenceReassessment = await runtime.reassessNativeTesterFindings(root, requestRef, { signal: operation.abort.signal }); }
      finally { endChecks(); }
      remember(evidenceReassessment.state);
      return evidenceReassessment.outcome === 'tester' && state.status === 'working' && state.resume_role === 'WF.Tester';
    }
    const evidenceIssue = () => cancelled() ? cancellationIssue() : evidenceReassessment?.outcome === 'uncertain'
      ? issue(evidenceReassessment.code, 'verification', evidenceReassessment.message) : undefined;
    if (toolInvocationToken == null) return result(issue('INVOCATION_TOKEN_REQUIRED', 'context', 'A current native tool invocation token is required.'));
    if (cancelled()) return interrupt(cancellationIssue());
    if (!requestToResume) {
      try { parsed = runtime.nativeLocalRequestSchema.parse(input); }
      catch { return result(issue('INVALID_REQUEST', 'input', 'Supply the requirement, context paths and a professional plan matching the native contract.')); }
    }
    try {
      if (requestToResume) {
        remember(await runtime.getNativeRequest(root, requestToResume)); requestRef = state.request_ref;
        let evidencePrepared = false;
        if (!recheckOnly && typeof runtime.reassessNativeTesterFindings === 'function') {
          evidencePrepared = await reassessEvidence(true);
          if (cancelled()) return interrupt(cancellationIssue());
          if (!evidencePrepared && evidenceReassessment?.code !== 'TESTER_EVIDENCE_NOT_ELIGIBLE' && evidenceReassessment) {
            if (evidenceIssue()) return interrupt(evidenceIssue());
            remember(await runtime.prepareNativeRepair(root, requestRef));
            evidencePrepared = state.status === 'working' && roles.includes(state.resume_role);
            if (!evidencePrepared) return result();
          }
        }
        if (!evidencePrepared) remember(await (recheckOnly ? runtime.recheckNativeRequest(root, requestToResume) : runtime.resumeNativeRequest(root, requestToResume)));
      }
      else {
        const { plan, ...request } = parsed;
        options.capabilities?.stage(parsed);
        if (Object.values(plan.role_skills ?? {}).some(names => names.length)) {
          if (typeof runtime.assertNativePlanSkillsAvailable !== 'function')
            return result(issue('NATIVE_SKILL_CONTEXT_UNAVAILABLE', 'compatibility', 'The installed runtime does not support selected skill contexts. Update the matching runtime, or omit optional skills to use ordinary project tools.'));
          await runtime.assertNativePlanSkillsAvailable(root, plan);
        }
        remember(await runtime.openNativeRequest(root, request));
        requestRef = state.request_ref;
        if (cancelled()) return interrupt(cancellationIssue());
        remember(await runtime.planNativeRequest(root, requestRef, plan));
      }
      requestRef = state.request_ref;
      if (typeof requestRef !== 'string' || !requestRef) throw new Error('Invalid backend reference');
      if (cancelled()) return interrupt(cancellationIssue());
      if (state.accepted === true) {
        if (recheckOnly && typeof runtime.refreshNativeRequestLearning === 'function')
          remember(await runtime.refreshNativeRequestLearning(root, requestRef));
        return result();
      }
      if (typeof runtime.prepareNativeImplementation === 'function')
        remember(await runtime.prepareNativeImplementation(root, requestRef, { signal: operation.abort.signal }));
      if (cancelled()) return interrupt(cancellationIssue());
      operation.ownsGeneration = state.editor_generation ?? 0;
      let sequence = requestToResume ? state.resume_checks ? [] : roles.slice(roles.indexOf(state.resume_role)) : roles;
      if (requestToResume && !state.resume_checks && !roles.includes(state.resume_role)) return interrupt(backendIssue());
      async function repair() {
        if (await reassessEvidence()) { sequence = ['WF.Tester']; return true; }
        if (evidenceIssue()) return false;
        if (options.automaticRepair === false || typeof runtime.prepareNativeRepair !== 'function') return false;
        remember(await runtime.prepareNativeRepair(root, requestRef));
        if (state.status !== 'working' || !roles.includes(state.resume_role)) return false;
        sequence = roles.slice(roles.indexOf(state.resume_role));
        return true;
      }
      let inputReconciliation;
      async function reconcileInputs() {
        if (options.automaticRepair === false || typeof runtime.reconcileNativeInputChange !== 'function') return false;
        inputReconciliation = await runtime.reconcileNativeInputChange(root, requestRef);
        remember(inputReconciliation.state);
        if (inputReconciliation.outcome !== 'prepared' || state.status !== 'working') return false;
        sequence = state.resume_checks ? [] : roles.slice(roles.indexOf(state.resume_role));
        return state.resume_checks || roles.includes(state.resume_role);
      }
      const inputIssue = () => inputReconciliation?.outcome === 'exhausted'
        ? issue(inputReconciliation.code, 'concurrency', inputReconciliation.message) : undefined;
      attempts: while (true) {
      for (const role of sequence) {
        if (cancelled()) return interrupt(cancellationIssue());
        const job = await runtime.nextNativeAssignment(root, requestRef);
        if (!job) {
          remember(await runtime.getNativeRequest(root, requestRef));
          return ['working', 'planning'].includes(state.status)
            ? interrupt(issue('NATIVE_ASSIGNMENT_UNAVAILABLE', 'backend', 'The runtime did not issue the next specialist assignment.')) : result();
        }
        privateValues.add(job.assignment_ref); privateValues.add(job.prompt);
        if (job.agentName !== role) return interrupt(issue('NATIVE_ASSIGNMENT_ORDER', 'backend', 'The saved assignment does not match the current native role sequence.'));
        if (cancelled()) return interrupt(cancellationIssue());
        // The repair uses the actual Coordinator's chosen model, while leaving
        // its ordinary worker preference unchanged for subsequent requests.
        const preference = job.escalation === 'native-parent' ? undefined : await options.modelForRole?.(job.agentName);
        const capability = options.capabilities?.prepare(state, job);
        if (capability) remember(capability.state);
        const outcome = await invoke({ agentName: job.agentName, prompt: job.prompt + (capability?.promptSuffix ?? ''), description: job.description,
          ...(preference ? { model: { id: preference.id, vendor: preference.vendor } } : {}) },
          toolInvocationToken, operation, metadata => observeNativeCall(root, requestRef, job.assignment_ref, metadata), requestRef, job.assignment_ref,
          state.editor_recovery?.status === 'prepared'
            ? () => {
              if (state.dispatch_capabilities) options.capabilities?.assertCurrent?.(requestRef);
              if (typeof runtime.assertNativeEditorRecoveryCurrent !== 'function')
                throw Object.assign(new Error('Matching native editor recovery runtime required'), { code: 'EDITOR_EFFECTS_UNCONFIRMED' });
              return runtime.assertNativeEditorRecoveryCurrent(root, requestRef, job.assignment_ref);
            }
            : () => { if (state.dispatch_capabilities) options.capabilities?.assertCurrent?.(requestRef);
              if (Object.values(state.skill_contexts ?? {}).some(contexts => contexts.length)) runtime.assertNativeRequestSkillsCurrent?.(root, requestRef); }, capability?.prepared);
        if (outcome.metadata.host_call_id) privateValues.add(outcome.metadata.host_call_id);
        if (outcome.metadata.invoked) {
          remember(await runtime.recordNativeResult(root, { request_ref: requestRef, assignment_ref: job.assignment_ref,
            invocation: { ...outcome.metadata, status: outcome.status }, raw_result: outcome.raw_result,
            ...(outcome.error ? { adapter_error: { code: outcome.error.code, category: outcome.error.category } } : {}) }));
        } else {
          remember(await runtime.recordNativeDispatchFailure(root, { request_ref: requestRef, assignment_ref: job.assignment_ref,
            code: outcome.error?.code ?? 'NATIVE_DISPATCH_REJECTED', category: outcome.error?.category ?? 'unknown' }));
        }
        if (cancelled()) return interrupt(cancellationIssue());
        if (outcome.status !== 'returned') return result(outcome.error);
        const savedJob = state.assignments?.find(item => item.assignment_ref === job.assignment_ref);
        if (savedJob?.state !== 'completed' || state.status !== 'working') {
          if (await reconcileInputs() || await repair()) continue attempts;
          return state.status === 'working'
            ? interrupt(evidenceIssue() ?? issue('NATIVE_RESULT_UNCONFIRMED', 'backend', 'The specialist result was not confirmed as a completed current assignment.')) : result(inputIssue() ?? evidenceIssue());
        }
      }
      if (cancelled()) return interrupt(cancellationIssue());
      remember(await runtime.getNativeRequest(root, requestRef));
      if (state.status !== 'working') {
        if (await reconcileInputs() || await repair()) continue attempts;
        return result(inputIssue() ?? evidenceIssue());
      }
      if (!completedRoles(state)) return interrupt(issue('NATIVE_ROLES_INCOMPLETE', 'backend', 'The current request does not have all required independent specialist results.'));
      const endChecks = observeNativeChecks(root, requestRef);
      operation.checking = true;
      let checkFailure;
      try { remember(await runtime.runNativeChecks(root, requestRef, { signal: operation.abort.signal })); }
      catch (error) { checkFailure = error; }
      finally { operation.checking = false; endChecks(); }
      if (cancelled()) return interrupt(cancellationIssue());
      if (checkFailure) {
        if (checkFailure.code !== 'NATIVE_INPUT_REVISION_CHANGED') throw checkFailure;
        if (await reconcileInputs()) continue attempts;
        return interrupt(inputIssue() ?? issue('NATIVE_INPUT_REVISION_CHANGED', 'concurrency',
          'Current source/checker inputs no longer match their independent inspection; retained work was preserved.'));
      }
      if (state.status !== 'working') {
        if (await reconcileInputs() || await repair()) continue attempts;
        return result(inputIssue() ?? evidenceIssue());
      }
      if (!completedRoles(state) || !state.checks?.length || state.checks.some(check => check.state !== 'passed'))
        return interrupt(issue('NATIVE_CHECKS_UNCONFIRMED', 'backend', 'The actual check run did not confirm passing current-revision evidence.'));
      try { remember(await runtime.finishNativeRequest(root, requestRef)); }
      catch (error) {
        if (error.code !== 'NATIVE_INPUT_REVISION_CHANGED') throw error;
        if (await reconcileInputs()) continue attempts;
        return interrupt(inputIssue() ?? issue('NATIVE_INPUT_REVISION_CHANGED', 'concurrency',
          'Current source/checker inputs changed before acceptance; actual work and earlier evidence were preserved.'));
      }
      await options.capabilities?.settle(state);
      return result();
      }
    } catch (error) {
      const recovery = editorRecoveryIssue(error);
      if (recovery && ['NATIVE_REPAIR_ALLOWANCE_EXHAUSTED', 'EDITOR_OWNERSHIP_CHANGED', 'NATIVE_CHECK_CANCELLED'].includes(recovery.code)) {
        if (requestRef) { try { remember(await runtime.getNativeRequest(root, requestRef), true); } catch { /* No mutation or fallback replay. */ } }
        return result(recovery);
      }
      return interrupt(cancelled() ? cancellationIssue() : selectedSkillIssue(error) ?? recovery ?? backendIssue());
    }
  }

  function start(input, toolInvocationToken, cancellationToken, requestToResume, roleOnly = false, recheckOnly = false) {
    if (disposed) return Promise.resolve({ status: 'cancelled', error: issue('RUNNER_DISPOSED', 'cancellation', 'This native runner has been disposed.') });
    // Repeated controls observe the actual in-flight owner. They must not reset
    // lifecycle state or attach a second caller's cancellation to that owner.
    if (requestToResume && owners.has(requestToResume)) return owners.get(requestToResume).done;
    let source;
    try { source = new vscode.CancellationTokenSource(); }
    catch { return Promise.resolve({ status: 'rejected', error: issue('NATIVE_CANCELLATION_UNAVAILABLE', 'compatibility', 'Native cancellation support is unavailable.') }); }
    const operation = { source, abort: new AbortController(), reason: undefined, done: undefined, caller: undefined, requestRef: requestToResume, roleOnly };
    operation.cancel = reason => { operation.reason ??= reason; source.cancel(); operation.abort.abort(); };
    if (cancellationToken?.isCancellationRequested) operation.cancel('caller');
    else operation.caller = cancellationToken?.onCancellationRequested?.(() => operation.cancel('caller'));
    active.add(operation);
    if (requestToResume) owners.set(requestToResume, operation);
    operation.done = Promise.resolve().then(() => roleOnly ? executeRoleJob(input, toolInvocationToken, operation)
      : execute(input, toolInvocationToken, operation, requestToResume, recheckOnly)).finally(() => {
      active.delete(operation); operation.caller?.dispose(); source.dispose();
      if (owners.get(operation.requestRef) === operation) owners.delete(operation.requestRef);
    });
    return operation.done;
  }

  function dispose() {
    if (disposing) return disposing;
    disposed = true;
    const pending = [...active];
    for (const operation of pending) {
      if (operation.checking && !operation.reason && operation.requestRef) {
        try { runtime.interruptNativeRequest(root, operation.requestRef, { code: 'EDITOR_CLOSED', category: 'cancellation',
          ...(operation.ownsGeneration === undefined ? {} : { editor_generation: operation.ownsGeneration }) }); }
        catch { /* Cancellation still drains; missing durable intent never proves termination. */ }
      }
      operation.cancel('editor');
    }
    disposing = Promise.allSettled(pending.map(operation => operation.done)).then(() => {});
    return disposing;
  }

  async function control(input, toolInvocationToken, cancellationToken) {
    let parsed, saved;
    try { parsed = runtime.nativeRequestControlSchema.parse(input); saved = runtime.getNativeRequestByKey(root, parsed.request_key); }
    catch { return { status: 'rejected', error: issue('REQUEST_SELECTION_REQUIRED', 'input', 'Select a public request key from this workspace; no task or assignment identity is needed.') }; }
    if (parsed.action === 'status') return { status: saved.status, request: publicRequest(saved) };
    return start(undefined, toolInvocationToken, cancellationToken, saved.request_ref, false, parsed.action === 'recheck');
  }

  return { run: (input, toolInvocationToken, cancellationToken) => start(input, toolInvocationToken, cancellationToken),
    role: (input, toolInvocationToken, cancellationToken) => start(input, toolInvocationToken, cancellationToken, undefined, true), control,
    resume: (requestRef, toolInvocationToken, cancellationToken) => start(undefined, toolInvocationToken, cancellationToken, requestRef),
    recheck: (requestRef, toolInvocationToken, cancellationToken) => start(undefined, toolInvocationToken, cancellationToken, requestRef, false, true), dispose };
}

module.exports = { createLocalRequestRunner };
