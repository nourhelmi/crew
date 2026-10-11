/** Synthetic browser fixture. No Crew home, providers, agents or inboxes are touched.
 * Run: node test/fixtures/console-ui.ts; use printed loopback URL with an isolated browser.
 * /fixture exposes test-only controls; this server must never be a product server.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { ConsoleBootstrap, ConsoleCapabilities, ConsoleDetail, ConsoleEvent, ConsoleMutation, ConsoleSession } from '../../src/console-types.ts';
import type { DashboardSnapshot } from '../../src/dashboard-observe.ts';
const at = new Date().toISOString();
const capabilities: ConsoleCapabilities = {activeInput:'steer', interrupt:true, approvals:true, questions:true, accessModes:['default','workspace','full']};
const sessions: ConsoleSession[] = [{id:'session-1',title:'Ship the Crew console',cwd:'/fixture/crew',mode:'cos',host:'codex',model:'gpt-test',access:'workspace',state:'running',revision:1,createdAt:at,updatedAt:at,rootNodeId:'managed-root',capabilities,pendingRequests:0}];
const details = new Map<string, ConsoleDetail>();
const events: ConsoleEvent[] = Array.from({length:42}, (_,i) => ({id:'event-'+i,sequence:i,at,kind:i % 2 ? 'assistant' : 'user',text:i % 2 ? `Review ${i}: confirmed the API and delivery contract.\nKeep the selected member output alongside the root conversation.` : `Task ${i}: inspect the current implementation and report the evidence.`,...(i % 2 ? {streaming:false} : {})} as ConsoleEvent));
events.push({id:'tool-1',sequence:42,at,kind:'tool',title:'Inspect console contract',text:'src/console-types.ts\nConsoleSession, ConsoleMessage, ConsoleAnswer',state:'completed'});
events.push({id:'stream-1',sequence:43,at,kind:'assistant',text:'The conversation stays central. I delegated provider work and browser verification to the team.',streaming:true});
details.set('session-1',{session:sessions[0]!,events,requests:[]});
const snapshot: DashboardSnapshot = {nodes:[
{id:'managed-root',workstreamId:'managed-root',name:'Ship the Crew console',role:'root',host:'codex',cwd:'/fixture/crew',state:'running',createdAt:at,updatedAt:at},
{id:'core',parentId:'managed-root',workstreamId:'managed-root',name:'console-core',role:'advisor',host:'codex',model:'gpt-test',cwd:'/fixture/crew',state:'running',status:'Implementing durable delivery and provider control.',createdAt:at,updatedAt:at},
{id:'ui',parentId:'managed-root',workstreamId:'managed-root',name:'console-ui',role:'advisor',host:'claude',model:'claude-test',cwd:'/fixture/crew',state:'running',status:'Verifying root conversation and team inspection.',createdAt:at,updatedAt:at},
{id:'checker',parentId:'core',workstreamId:'managed-root',name:'delivery-checker',role:'checker',host:'codex',cwd:'/fixture/crew',state:'idle',waitingSince:at,createdAt:at,updatedAt:at,assignment:{id:'assignment-1',revision:1,createdAt:at,status:'accepted',submissions:[{ref:'submission-1',hash:'fixture',packetHash:'fixture-packet',revision:1,at,status:'PASS',result:'PASS: synthetic delivery proof',accepted:{submission:'submission-1',at,by:'parent'}}],accepted:{at,by:'parent',submission:'submission-1'}}},
{id:'external-root',workstreamId:'external-root',name:'Library cleanup',role:'root',host:'claude',cwd:'/fixture/library',state:'untracked',createdAt:at,updatedAt:at}],workstreams:[{id:'managed-root',name:'Ship the Crew console',project:'crew',runs:3,running:2,attention:1,updatedAt:at},{id:'external-root',name:'Library cleanup',project:'library',runs:0,running:0,attention:0,updatedAt:at}],warnings:[]};
const bootstrap: ConsoleBootstrap = {token:'synthetic-capability',providers:[{id:'codex',label:'Codex',available:true,defaultModel:'gpt-test',models:[{id:'gpt-test',label:'GPT fixture',efforts:['low','high']}],capabilities:capabilities as ConsoleSession['capabilities']},{id:'claude',label:'Claude Code',available:true,models:[{id:'claude-test',label:'Claude fixture'}],capabilities:{...capabilities,activeInput:'queue',accessModes:['default','full']} as ConsoleSession['capabilities']}],projects:[{cwd:'/fixture/crew',name:'Crew fixture'}],sessions};
const receipts = new Map<string,{body:string;result:ConsoleMutation}>();
const requests: {path:string;body:Record<string,unknown>;origin:string|undefined;token:boolean}[] = [];
const clients = new Map<import('node:http').ServerResponse, URL>();
let observerOnly = false, failNext = '', launchNumber = 1;
const server = createServer(async (req,res) => {
 const url = new URL(req.url || '/', 'http://127.0.0.1');
 const json = (status:number,body:unknown) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
 if (req.method === 'POST') {
  let text='';for await (const chunk of req) text+=String(chunk);
  const body = JSON.parse(text) as Record<string,unknown>;
  if (url.pathname === '/fixture') {
   if (body.observer !== undefined) observerOnly = !!body.observer;
   if (body.fail) failNext = String(body.fail);
   const d = details.get(String(body.session || 'session-1'))!;
   if (body.state) {d.session.state = body.state as ConsoleSession['state'];d.session.revision++;}
   if (body.requests) d.requests = body.requests as ConsoleDetail['requests'];
   if (body.event) d.events.push(body.event as ConsoleEvent);
   if (body.streaming !== undefined) { const e=d.events.find(e=>e.id==='stream-1');if(e?.kind==='assistant'){e.text=String(body.streaming);e.streaming=false;} }
   d.session.pendingRequests=d.requests.length;publish();return json(200,{fixture:true,requests});
  }
  requests.push({path:url.pathname,body,origin:req.headers.origin,token:req.headers['x-crew-token']===bootstrap.token});
  if(req.headers['x-crew-token']!==bootstrap.token || req.headers.origin!==origin)return json(403,{error:'Fixture origin or capability rejected',code:'FORBIDDEN'});
  if (failNext) {const failure=failNext;failNext='';if(failure==='transport'){res.destroy();return;}if(failure==='server')return json(503,{error:'Synthetic uncertain delivery'});return json(400,{error:'Synthetic rejection',code:'INVALID_INPUT'});}
  const old=receipts.get(String(body.requestId));
  if(old)return json(old.body===text?200:409,old.body===text?old.result:{error:'Request ID conflict',code:'REQUEST_ID_CONFLICT'});
  let s=sessions.find(s=>url.pathname.includes('/'+s.id+'/'));
  if(url.pathname==='/api/console/sessions'){
   const id='launched-'+(++launchNumber);s={...sessions[0]!,id,title:String(body.title||'New console session'),cwd:String(body.cwd),host:body.host as ConsoleSession['host'],mode:body.mode as ConsoleSession['mode'],model:String(body.model||''),access:body.access as ConsoleSession['access'],rootNodeId:'root-'+id,state:'running',capabilities:bootstrap.providers.find(p=>p.id===body.host)!.capabilities};sessions.unshift(s);
   details.set(id,{session:s,events:[{id:'launch-prompt',sequence:1,at,kind:'user',text:String(body.prompt)},{id:'reply',sequence:2,at,kind:'assistant',text:'I have the outcome and workspace. Starting the crew.',streaming:false}],requests:[]});
   snapshot.nodes.push({...snapshot.nodes[0]!,id:s.rootNodeId,workstreamId:s.rootNodeId,name:s.title});snapshot.workstreams.push({id:s.rootNodeId,name:s.title,project:'fixture',runs:0,running:0,attention:0,updatedAt:at});
  }
  if(!s)return json(404,{error:'No fixture session'});
  const d=details.get(s.id)!;
  const result:ConsoleMutation={session:s,command:{requestId:String(body.requestId),state:body.text && s.host==='claude' && s.state==='running' && !body.interrupt ? 'queued' : 'delivered'}};
  if(body.text){if(body.interrupt)s.state='running';d.events.push({id:String(body.requestId),sequence:d.events.length+60,at,kind:'user',text:String(body.text),command:result.command});}
  if(body.action){s.state=body.action==='close'?'closed':body.action==='interrupt'?'interrupted':'idle';if(body.action==='close')for(const event of d.events)if(event.kind==='user' && event.command?.state==='queued'){event.command.state='failed';event.command.error='Canceled: session closed before delivery';}}
  if(body.pendingRequestId){d.requests=d.requests.filter(r=>r.id!==body.pendingRequestId);s.pendingRequests=d.requests.length;}
  s.revision++;receipts.set(String(body.requestId),{body:text,result});publish();return json(200,result);
 }
 if(url.pathname==='/fixture')return json(200,{fixture:true,requests});
 if(url.pathname==='/api/console')return json(observerOnly?404:200,observerOnly?{error:'Observer only'}:bootstrap);
 if(url.pathname.startsWith('/api/console/sessions/')){
  const d=details.get(url.pathname.split('/').at(-1)!);if(!d)return json(404,{error:'Not found'});
  const limit=Number(url.searchParams.get('before')||d.events.length),begin=Math.max(0,limit-12);
  return json(200,{...d,events:d.events.slice(begin,limit),...(begin?{before:String(begin)}:{})});
 }
 if(url.pathname==='/api/events'){
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});clients.set(res,url);publish();req.on('close',()=>clients.delete(res));return;
 }
 const assets=new Map([['/','dashboard.html'],['/dashboard.js','dashboard.js'],['/dashboard.css','dashboard.css']]);
 const asset=assets.get(url.pathname);if(!asset)return json(404,{error:'Not found'});
 res.writeHead(200,{'Content-Type':asset.endsWith('js')?'text/javascript':asset.endsWith('css')?'text/css':'text/html'});res.end(readFileSync(new URL('../../web/'+asset,import.meta.url)));
});
let origin='';
function publish(){for(const [res,url] of clients){const d=details.get(url.searchParams.get('session')||'');const id=url.searchParams.get('node')||'';res.write('event: update\ndata: '+JSON.stringify({snapshot,detail:id?{id,source:'exec-log',updatedAt:at,truncated:false,events:[{id:'output',at,kind:'tool',title:'Verification',text:'Fixture output <script>window.injected=true</script>\nState remains private. No inbox consumed.'}],packet:'Outcome: prove delivery semantics.\nScope: synthetic fixture only.',result:'PASS: fixture submission',messages:[{at,from:'parent',kind:'message',text:'Verify the failure path.'}],warnings:[]}:null,...(!observerOnly?{console:{sessions,detail:d?{...d,events:d.events.slice(-12),...(d.events.length>12?{before:String(d.events.length-12)}:{})}:null}}:{})})+'\n\n');}}
server.listen(Number(process.env.CONSOLE_FIXTURE_PORT || 0),'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string')throw new Error('No address');origin='http://127.0.0.1:'+address.port;console.log(origin);});
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{for(const res of clients.keys())res.end();server.close();});
