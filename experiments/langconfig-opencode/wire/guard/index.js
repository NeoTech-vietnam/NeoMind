import { Plugin } from '@opencode/plugin';
import { appendFileSync, readFileSync } from 'node:fs';

const file = process.env.FIXTURE_GUARD_TRACE;
if (!file) throw new Error('fixture guard trace required');
const log = x => appendFileSync(file, JSON.stringify(x) + '\n');

export default Plugin.define({id:'fixture-wire-guard', async setup(ctx) {
 log({event:'setup'});
 await ctx.session.hook('title', e => { e.result='Fixture review'; log({event:'title'}); });
 await ctx.session.hook('compaction', e => {e.result={summary:'Fixture summary'};log({event:'compaction'});});
 await ctx.session.hook('retry', e => { e.decision={retry:false};log({event:'retry',attempt:e.attempt}); });
 await ctx.session.hook('experimental.ws.handshake', () => {log({event:'websocket-deny'});throw new Error('fixture websocket denied');});
 await ctx.session.hook('http.request', e => {
   // This experimental counter is not atomic across processes and is not a live guard.
   const prior=readFileSync(file,'utf8').split('\n').filter(x=>x.includes('"event":"dispatch"')).length;
   log({event:'dispatch',kind:e.kind,provider:e.model.providerID,model:e.model.id});
   if(e.model.providerID!=='fixture'||e.model.id!=='fake-review'||e.kind!=='primary'||prior>=10) throw new Error('fixture request denied');
 });
}});
