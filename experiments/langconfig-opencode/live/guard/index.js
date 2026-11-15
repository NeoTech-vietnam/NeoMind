import { Plugin } from '@opencode/plugin';
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export default Plugin.define({ id: 'fixture-live-guard', async setup(ctx) {
  const o = ctx.options;
  if (!['fake', 'live'].includes(o.mode) || !o.database || !o.helper || !o.python || !o.trace || !o.origin) throw new Error('fixture guard configuration invalid');
  if (o.mode === 'live' && (o.origin !== 'https://opencode.ai' || o.testRetry === true)) throw new Error('invalid live mode');
  const selected = o.mode === 'fake' ? { provider: 'fixture', model: 'fake-review' } : { provider: 'opencode', model: 'deepseek-v4.1-flash-free' };
  const log = (event, fields = {}) => appendFileSync(o.trace, JSON.stringify({ event, ...fields }) + '\n');
  await ctx.model.transform(editor => {
    for (const model of editor.list()) if (model.providerID !== selected.provider || model.id !== selected.model) editor.remove(model.providerID, model.id);
    editor.default.set(selected.provider, selected.model);
  });
  await ctx.session.hook('context', e => {
    const sources = e.system.flatMap(part => part.metadata?.experimental?.instructions || []).map(source => source.key);
    log('instruction-sources', { sources });
    if (sources.length !== 2 || sources[0] !== 'core/date' || sources[1] !== 'core/environment') throw new Error('Unexpected fixture instruction source');
    e.system.splice(0, e.system.length, { type: 'text', text: 'Review only the synthetic fixture provided by the user. Return the requested JSON. Do not use tools.' });
    for (const key of Object.keys(e.tools)) delete e.tools[key];
  });
  await ctx.session.hook('title', e => { e.result = 'Fixture review'; log('title'); });
  await ctx.session.hook('compaction', e => { e.result = { summary: 'Synthetic fixture compaction.' }; log('compaction'); });
  await ctx.session.hook('retry', e => {
    e.decision = o.testRetry === true && e.attempt === 2 ? { retry: true, delay: 1 } : { retry: false };
    log('retry', { attempt: e.attempt, allowed: e.decision.retry });
  });
  for (const hook of ['experimental.ws.handshake', 'experimental.ws.send']) {
    await ctx.session.hook(hook, () => { log('websocket-deny', { hook }); throw new Error('Fixture websocket denied'); });
  }
  await ctx.session.hook('http.request', e => {
    const id = randomUUID();
    const model = e.model || {};
    const target = new URL(e.request.url);
    if (model.providerID !== selected.provider || model.id !== selected.model || model.variant !== 'high' || e.kind !== 'primary' || target.origin !== o.origin || (o.mode === 'live' && !target.pathname.startsWith('/inference/'))) {
      log('deny', { id, kind: e.kind, provider: model.providerID, model: model.id, variant: model.variant });
      throw new Error('Fixture dispatch denied');
    }
    e.request = new Request(e.request, { redirect: 'error' });
    try {
      execFileSync(o.python, [o.helper, 'reserve', o.database, e.sessionID, id], { timeout: 5000, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: o.home, TMPDIR: o.tmp } });
    } catch {
      log('reserve-deny', { id, sessionID: e.sessionID });
      throw new Error('Fixture quota unavailable');
    }
    log('reserved', { id, sessionID: e.sessionID, kind: e.kind, provider: model.providerID, model: model.id, variant: model.variant });
  });
  log('ready');
}});
