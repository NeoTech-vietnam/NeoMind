// Explicit opt-in: this fixture consumes the signed-in Codex account quota.
if (!process.argv.includes('--real')) throw new Error('Use --real to run the disposable Luna 6 conflict acceptance fixture');
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { LocalRun } from '../dist/src/runtime/local-run.js';
import { templates, defaultProject } from '../dist/src/domain/templates.js';
import { builtinProfile } from '../dist/src/runtime/project.js';
import { materializeRun } from '../dist/src/domain/materialize.js';
import { WorkspaceCoordinator } from '../dist/src/storage/coordination.js';
const root = path.resolve('demo/workflow-acceptance', `real-${Date.now()}`), project = path.join(root, 'repo'), state = path.join(root, 'state');
await mkdir(project, {recursive:true}); await mkdir(path.join(state,'workspaces'), {recursive:true}); await mkdir(path.join(state,'runs'));
const git = (...args) => execFileSync('git',['-C',project,...args], {encoding:'utf8'}).trim();
git('init','-q'); git('config','user.name','NeoMind Acceptance'); git('config','user.email','acceptance@localhost'); git('config','core.autocrlf','false');
await writeFile(path.join(project,'value.txt'),'base\n'); await writeFile(path.join(project,'value.bin'),Buffer.from([0,0]));
await writeFile(path.join(project,'verify.cjs'),"const fs=require('node:fs'); const assert=require('node:assert/strict'); assert.equal(fs.readFileSync('value.txt','utf8'),'alpha+beta\\n'); assert.deepEqual([...fs.readFileSync('value.bin')],[0,65,66]); console.log('Conflict fixture passed');\n");
const role={runner:'codex',provider:'openai',model:'gpt-6-luna',reasoning:'low'};
const config={...structuredClone(defaultProject),policy:{...defaultProject.policy,allowAutoApproval:true,keepRunWorktrees:true},roleDefaults:{implementer:role,verifier:role}};
await mkdir(path.join(project,'neomind')); await writeFile(path.join(project,'neomind','project.json'),JSON.stringify(config)); git('add','.'); git('commit','-qm','conflict fixture baseline');
const flow=structuredClone(templates.parallel); flow.flowId='real-conflict-acceptance'; flow.definition.limits.activeTimeSeconds=240;
flow.definition.nodes.find(n=>n.type==='approval').mode='auto';
for(const node of flow.definition.nodes) { if(node.id==='implement-a') node.goal='Deliberate conflict fixture: replace value.txt with exactly alpha followed by newline, and value.bin with bytes [0,65]. Do not implement beta or combine anything.'; if(node.id==='implement-b') node.goal='Deliberate conflict fixture: replace value.txt with exactly beta followed by newline, and value.bin with bytes [0,66]. Do not implement alpha or combine anything.'; }
const snapshot=await materializeRun(flow,config,{'implementer@1':builtinProfile('implementer'),'verifier@1':builtinProfile('verifier')},project);
const coordinator=new WorkspaceCoordinator(path.join(state,'coordination.sqlite'));
let run;
try {
run=await LocalRun.create({projectRoot:project,stateRoot:state,task:'Run the deliberate merge-conflict acceptance fixture. implement-a writes value.txt=alpha\\n and value.bin bytes [0,65]; implement-b writes value.txt=beta\\n and value.bin bytes [0,66], each in its own worktree. Integration must resolve both conflicts into value.txt=alpha+beta\\n and value.bin bytes [0,65,66]. Keep verify.cjs unchanged. Use scope ["."] for both packets and run the check "node verify.cjs" after integration. Acceptance criterion: "both contributions preserved". This isolated fixture explicitly opts into automatic plan approval; preserve independent review and local commit.',snapshot,coordinator});
console.log(JSON.stringify({stage:'started',runId:run.runId,root,workspace:run.context.workspace})); run.launch(); await run.settled();
const report=await run.report(); await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({stage:'finished',runId:run.runId,phase:report.runtimeState.phase,reason:report.runtimeState.reason,usage:{totalTokens:report.usage.totalTokens,partial:report.usage.partial},conflicts:report.integrations.map(x=>({paths:x.conflicts,markerless:x.markerlessConflicts})),commits:report.commits.map(x=>x.commit),report:path.join(root,'report.json')}));
if(report.runtimeState.phase!=='completed') process.exitCode=1;
} finally {if(run) await run.close(); coordinator.close();}
