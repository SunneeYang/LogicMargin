// Development only: regenerate fixed vectors with Node >=22.18; Go never invokes Node.
import { writeFile, mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { parseReview, parseReviewBaseline, parseSourceFiles, rebaseReview } from '../../../src/model.ts'
import { logicIdentity, commentOrigin, submissionRound } from '../../../src/revisions.ts'
import { parseSessionOptions } from '../../../src/session-lifecycle.ts'
import { pendingFeedback } from '../../../src/workspace.ts'
import { validateEvidenceCode, validatePublication } from '../../../server/publication.ts'
import { currentSession } from '../../../server/session-view.ts'
import { SessionStore } from '../../../server/session-store.ts'
const clone = value => structuredClone(value)
const sha = value => createHash('sha256').update(value).digest('hex')
const review = {
 schemaVersion: 1, id:'review',title:'升级 &<> 😀',description:'源自代码\u2028line\u2029',revision:'v1',
 snapshot:{repository:'/vast',commit:'abc',fingerprint:'hash1',capturedAt:'2026-11-02T00:00:00Z',dirty:true},
 coverage:{included:['升级'],excluded:['重置'],note:'范围说明'},
 scenes:[{id:'level',title:'升级',description:''}],
 nodes:[{id:'check',sceneId:'level',title:'检查条件',kind:'action',summary:'',detail:'',input:'',output:'',position:{x:0,y:0},evidence:[{path:'skill.go',symbol:'LevelUp',startLine:1,endLine:10,digest:'abc'}]},
 {id:'result',sceneId:'level',title:'结果',kind:'result',summary:'',detail:'',input:'',output:'',position:{x:0,y:1},evidence:[]}],
 edges:[{id:'edge',sceneId:'level',source:'check',target:'result',label:'是',detail:''}],comments:[]
}
const comment = (id='c', target={kind:'node',id:'check'}) => ({id,body:'意见',targets:[target],status:'open',createdAt:'2026-11-02T00:00:00Z',revision:'v1'})
const reply = (id='r', author='reviewer') => ({id,author,body:'回复',createdAt:'2026-11-02T00:00:01Z',revision:'v1'})
const tests=[]
function vector(name,kind,input,fn,extra={}) {let result;try {result={output:fn(input)}}catch(error){result={error:error.message,status:error.status??400}}tests.push({name,kind,input,...extra,...result})}
const parse=(name,value)=>vector(name,'review',value,parseReview)
parse('valid review',review)
parse('unknown fields', {...review,unknown:1,nodes:review.nodes.map(n=>({...n,unknown:'drop'})),snapshot:{...review.snapshot,unknown:[]}})
for(const value of [null,[],{},'text'])parse('invalid top '+JSON.stringify(value),value)
// Vary each trust-boundary field independently, retaining the TS error text.
const parserFixture=clone(review);parserFixture.comments=[{...comment(),replies:[reply()]}]
const paths=[]
function walk(value,path=[]){if(Array.isArray(value)){if(value.length)walk(value[0],[...path,0]);return}if(value&&typeof value==='object'){for(const [key,item] of Object.entries(value)){paths.push([...path,key]);walk(item,[...path,key])}}}
walk(parserFixture)
for(const path of paths)for(const [index,value] of [null,[],{},false,0,''].entries()){
 const r=clone(parserFixture);let parent=r;for(const key of path.slice(0,-1))parent=parent[key];parent[path.at(-1)]=value;parse(`field ${path.join('.')} ${index}`,r)
}
const patches=[{schemaVersion:2},{title:'😀'.repeat(101)},{title:'😀'.repeat(100)},{title:'\ufeff'},{scenes:[]},{nodes:[review.nodes[0],review.nodes[0]]},{snapshot:{...review.snapshot,dirty:'true'}},{nodes:[{...review.nodes[0],position:{x:null,y:0}}]},{nodes:[{...review.nodes[0],sceneId:'missing'}]},{nodes:[{...review.nodes[0],kind:'script'}]},{edges:[{...review.edges[0],target:'missing'}]},{comments:[comment(),comment()]},{comments:[{...comment(),targets:[]}]},{comments:[{...comment(),targets:[{kind:'node',id:'check'},{kind:'node',id:'check'}]}]},{comments:[{...comment(),originRound:9007199254740991}]},{comments:[{...comment(),originRound:9007199254740992}]},{comments:[{...comment(),originRound:1.5}]},{comments:[{...comment(),revision:'old'}]},{comments:[{...comment(),revision:'old',reviewedRevision:'v1',status:'resolved'}]},{comments:[{...comment(),targets:[{kind:'node',id:'missing'}]}]},{comments:[{...comment(),status:'resolved',targets:[{kind:'node',id:'missing'}]}]},{comments:[{...comment(),replies:[reply(),reply()]}]},{comments:[{...comment(),basis:'baseline'}]}]
for(const [i,p] of patches.entries())parse('patch '+i,{...review,...p})
for(const value of ['bad','2026-11-02T00:00:00.000Z','2026-02-30','2026-11-02T24:00:00Z','2026-11-02T24:00:00.0001Z','2026-11-02t00:00:00z','2026-11-02T00:00:00+08:00','Mon, 02 Nov 2026 00:00:00 GMT','0','2026-11','2026',' 2026-11-02 ','2026-01-00','2026-13-01','+010000-01-01T00:00:00Z','+275760-09-13T00:00:00.001Z','0001','001','Jan 2, 2026','2026-2-30'])parse('date '+value,{...review,snapshot:{...review.snapshot,capturedAt:value}})
for(const file of [{path:'../secret',sha256:'a'.repeat(64)},{path:'C:/secret',sha256:'a'.repeat(64)},{path:'a//b',sha256:'a'.repeat(64)},{path:'a\\b',sha256:'a'.repeat(64)},{path:'a\0b',sha256:'a'.repeat(64)},{path:'a',sha256:'A'.repeat(64)}])vector('invalid source '+file.path,'files',[file],parseSourceFiles)
const duplicateFile={path:'a',sha256:'a'.repeat(64)}
vector('duplicates validate trailing file','files',[duplicateFile,duplicateFile,{}],parseSourceFiles)
parse('duplicates validate trailing target',{...review,comments:[{...comment(),targets:[{kind:'node',id:'check'},{kind:'node',id:'check'},{}]}]})
const files=['\ue000.ts','😀.ts','a&<>.ts','中.ts','\u2028.ts'].map(path=>({sha256:sha(path),path,ignored:true}))
vector('UTF16 source order','files',files,parseSourceFiles)
const sourceFiles=parseSourceFiles(files)
const sourced=clone(review);sourced.snapshot.files=sourceFiles;sourced.snapshot.fingerprint=sha(JSON.stringify(sourceFiles));sourced.nodes[0].evidence=[{path:'a&<>.ts',symbol:'升级😀',startLine:3,endLine:4,digest:sha('check😀 &<>\nrun()'),code:'check😀 &<>\nrun()'}]
parse('saved code',sourced)
for(const p of [{code:'one line'},{code:'check()\r\nrun()'},{code:'check()\n\0'},{digest:'legacy'},{code:'😀'.repeat(50001)}]){const r=clone(sourced);Object.assign(r.nodes[0].evidence[0],p);parse('snippet '+Object.keys(p).join(),r)}
vector('evidence digest','evidence',sourced,r=>{validateEvidenceCode(r);return true})
const forged=clone(sourced);forged.nodes[0].evidence[0].code='forged\ncode';vector('forged evidence','evidence',forged,r=>{validateEvidenceCode(r);return true})
const fp=clone(sourced);fp.snapshot.fingerprint='0'.repeat(64);vector('forged fingerprint','evidence',fp,r=>{validateEvidenceCode(r);return true})
const baseline=clone(review)
parse('fixed B',{...review,baseline,comments:[{...comment(),basis:'baseline'}]})
parse('nested B',{...review,baseline:{...baseline,baseline}})
parse('wrong B ID',{...review,baseline:{...baseline,id:'other'}})
parse('B with comments',{...review,baseline:{...baseline,comments:[comment()]}})
vector('parse baseline','baseline',baseline,parseReviewBaseline)
for(const input of [{scope:{purpose:'  独立审查  ',context:' thread '}},{scope:{purpose:'x',context:''}},{scope:[]},{cleanupPolicy:'invalid'},{baselineReview:false},{baselineReview:true}])vector('options '+JSON.stringify(input),'options',input,parseSessionOptions)
vector('logic identity','identity',sourced,logicIdentity)
vector('literal JSON escapes','identity',{...sourced,description:'literal \\u2028 \\u2029 \\" \\b \b \f \t \r \n \0 \u001f'},logicIdentity)
const sorted=clone(sourced);sorted.scenes.push({id:'😀',title:'a,b',description:'x'},{id:'\ue000',title:'z',description:'x'},{id:'level,0',title:'n',description:''});sorted.nodes[0].id='a,b';sorted.nodes[1].id='a';vector('tuple default sort','identity',sorted,logicIdentity)
const publication={baseRound:1,summary:'  调整条件  ',source:{algorithm:'sha256-path-content-v1',checkedAt:'2026-11-02T00:00:00Z',files:sourceFiles,fingerprint:sourced.snapshot.fingerprint}}
for(const [name,p] of [['valid',publication],['null',null],['bad round',{...publication,baseRound:0}],['bad source',{...publication,source:{...publication.source,fingerprint:'0'.repeat(64)}}],['reason',{...publication,unchangedReason:'  unchanged  '}],['blank reason',{...publication,unchangedReason:''}]])vector('publication '+name,'publication',p,v=>validatePublication(v,sourced),{review:sourced})
for(const [name,change] of [['unchanged',r=>r],['layout',r=>{r.nodes[0].position.x++}],['logic',r=>{r.nodes[0].output='changed'}],['metadata',r=>{r.title='new'}],['removed',r=>{r.nodes.shift();r.edges=[]}],['revision',r=>{r.revision='v2'}],['evidence',r=>{r.nodes[0].evidence[0].digest='changed'}],['agent reply',r=>{r.comments[0].replies=[reply('agent','agent')]}],['reply conflict',r=>{r.comments[0].replies=[{...reply(),body:'changed'}]}],['opinion conflict',r=>{r.comments[0].body='forged'}]]){const before={...clone(review),comments:[{...comment(),status:'resolved',reviewedRevision:'v1',replies:[reply()]},comment('scene',{kind:'scene',id:'level'}),comment('review',{kind:'review',id:'review'})]};const after=clone(before);change(after);vector('rebase '+name,'rebase',after,r=>rebaseReview(before,r),{before})}
const tmp=await mkdtemp(join(process.env.CODEX_AGENT_TMP,'oracle-'))
const store=new SessionStore(tmp);let state;const steps=[]
function normalized(value){const v=clone(value);const session=(s)=>{s.id='<session>';s.createdAt='<created>';s.updatedAt='<updated>';for(const r of s.history??[])r.createdAt='<record>';for(const sn of s.snapshots??[])sn.openedAt='<opened>'};if(v&&v.schemaVersion===1&&v.phase)session(v);if(v?.openedAt&&v.review)v.openedAt='<opened>';if(v?.kind?.startsWith('logic-margin-'))v.createdAt='<record>';if(v?.archivedAt)v.archivedAt='<archive>';return v}
async function step(op,input={},view=''){let output,error,status;try{if(op==='create')output=await store.create(input.review,view||undefined,input.options);else if(op==='get')output=await store.get(state.id,view||undefined);else if(op==='getBaseline')output=await store.getBaseline(state.id);else if(op==='getRecord')output=await store.getRecord(state.id,input.record);else if(op==='getSnapshot')output=await store.getSnapshot(state.id,input.round);else if(op==='getArchive')output=await store.getArchive(state.id);else output=await store[op](state.id,input,view||undefined);if(output?.phase&&view!=='current')state=output;output=normalized(output);if(output?.id===state?.id)output.id='<session>'}catch(e){error=e.message;status=e.status??400}steps.push({op,input,view,...error?{error,status}:{output}})}
const batch = mutations => ({revision:state.review.revision,fingerprint:state.review.snapshot.fingerprint,round:state.round,mutations})
await step('create',{review,options:{}})
await step('mutate',batch([{kind:'add-comment',comment:comment()}]))
await step('mutate',batch([{kind:'add-comment',comment:comment()}]))
await step('mutate',batch([{kind:'add-comment',comment:{...comment(),body:'conflict'}}]))
await step('mutate',batch([{kind:'add-comment',comment:comment('rollback')},{kind:'unknown'}]))
await step('finish',{kind:'feedback',expectedVersion:state.version,submissionId:'submission-1'})
await step('get',{},'current')
await step('finish',{kind:'feedback',expectedVersion:1,submissionId:'submission-1'})
await step('acknowledge',{submissionId:'submission-1'})
await step('acknowledge',{submissionId:'submission-1'})
await step('mutate',batch([{kind:'add-reply',commentId:'c',reply:reply('agent-reply','agent')}]))
await step('finish',{kind:'approval',expectedVersion:state.version,submissionId:'bad'})
const next=clone(sourced);next.revision='v2';next.nodes[0].output='changed';const pub={...publication,baseRound:state.round}
await step('revise',{expectedVersion:state.version,review:next,publication:pub})
await step('getSnapshot',{round:1})
await step('getRecord',{record:'submission-1'})
await step('get',{},'current')
await step('mutate',{...batch([{kind:'set-status',commentId:'c',from:'needs-review',status:'resolved',reviewedRevision:'v2'}]),expectedVersion:state.version})
await step('finish',{kind:'approval',expectedVersion:state.version,submissionId:'approved'})
await step('mutate',batch([{kind:'add-reply',commentId:'c',reply:reply('agent-reply','agent')}]))
await step('get',{},'current')
await step('cleanup',{expectedVersion:state.version,mode:'archive'})
await step('get')
await step('getArchive')
const archiveBytes=await readFile(join(tmp,'archive',state.id+'.json.gz'));await writeFile(new URL('./legacy-session.json.gz',import.meta.url),archiveBytes)
await step('restore',{expectedVersion:state.version})
await step('cleanup',{expectedVersion:state.version,mode:'delete'})
await step('get')
for(const sn of state.snapshots){vector('origin session round '+sn.round,'current',state,currentSession)}
await writeFile(new URL('./oracle.json',import.meta.url),JSON.stringify({review,sourceFiles,fingerprint:sourced.snapshot.fingerprint,vectors:tests,steps},null,2)+'\n')
await rm(tmp,{recursive:true,force:true})
console.log(`Generated ${tests.length} vectors and ${steps.length} lifecycle operations`)
