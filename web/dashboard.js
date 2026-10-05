// @ts-check
/** @typedef {import('../src/dashboard-observe.ts').DashboardSnapshot} Snapshot */
/** @typedef {import('../src/dashboard-observe.ts').DashboardNode} Node */
/** @typedef {import('../src/dashboard-observe.ts').DashboardDetail} Detail */
const root = document.getElementById('crew-dashboard');
const el = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** @type {Snapshot} */
let snapshot = { nodes: [], workstreams: [], warnings: [] };
/** @type {Detail | null} */
let detail = null;
const state = { stream: '', node: '', tab: 'output', expanded: false, follow: true, query: '' };
let events;
let detailHash = '';
let snapshotHash = '';
let wanted = new URLSearchParams(location.search).get('run') || '';

const node = () => snapshot.nodes.find(n => n.id === state.node);
const group = () => snapshot.workstreams.find(w => w.id === state.stream);
const hostName = host => ({codex:'Codex',claude:'Claude Code',opencode:'OpenCode'}[host] || host);
const elapsed = at => {
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms)) return 'Unknown';
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? 'Just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m/60)}h ago` : `${Math.floor(m/1440)}d ago`;
};
const time = at => at && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';
const status = n => n.waitingSince ? 'Needs attention' : ({running:'Running',done:'Result ready',blocked:'Blocked',failed:'Failed',stalled:'Stalled',stopped:'Stopped',untracked:'Root session'}[n.state] || n.state);
const attention = n => n.waitingSince || ['blocked','failed','stalled'].includes(n.state);
const badge = n => `<span class="cw-status ${attention(n) ? 'attention' : n.state === 'running' ? '' : 'waiting'}"><span class="cw-dot"></span>${esc(status(n))}</span>`;
const host = n => `<span class="cw-host ${n.host==='claude' ? 'claude' : ''}" aria-label="${esc(hostName(n.host))}">${n.host==='claude' ? '✳' : n.host==='codex' ? '›_' : 'o'}</span>`;

function setConnection(ok, label) {
  el('connection').textContent = label;
  el('connection').classList.toggle('cw-disconnected', !ok);
}

function connect() {
  events?.close();
  setConnection(false, 'Connecting…');
  const selection = state.node;
  const source = new EventSource('/api/events' + (selection ? `?node=${encodeURIComponent(selection)}` : ''));
  events = source;
  source.onopen = () => { if (events === source) setConnection(true, '● Following local output'); };
  source.onerror = () => { if (events === source) setConnection(false, 'Disconnected · retrying…'); };
  source.addEventListener('unavailable', () => { if (events === source) setConnection(false, 'Data unavailable · retrying…'); });
  source.addEventListener('update', event => {
    if (events !== source) return;
    try {
      const update = JSON.parse(event.data);
      const nextHash = JSON.stringify(update.snapshot);
      snapshot = update.snapshot;
      if (!snapshot.nodes.some(n => n.id === state.node)) {
        const preferred = snapshot.nodes.find(n => n.id === wanted || n.name === wanted);
        wanted = '';
        const stream = preferred?.workstreamId || snapshot.workstreams[0]?.id || '';
        const first = preferred || snapshot.nodes.filter(n => n.workstreamId === stream && n.role !== 'root').sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0] || snapshot.nodes.find(n=>n.id===stream);
        if (first) { select(first.id); return; }
      }
      setConnection(true, '● Following local output');
      if (nextHash !== snapshotHash) { snapshotHash=nextHash; renderSnapshot(); }
      const nextDetail = update.detail && update.detail.id === state.node ? update.detail : null;
      const hash = JSON.stringify(nextDetail);
      if (hash !== detailHash) { detailHash=hash; detail=nextDetail; renderDetail(); }
      el('observed').textContent = 'Refreshed '+new Date().toLocaleTimeString();
    } catch { setConnection(false, 'Could not read update · retrying…'); }
  });
}

function select(id) {
  const n = snapshot.nodes.find(n=>n.id===id);
  if(!n)return;
  state.node=n.id;state.stream=n.workstreamId;
  detail=null;detailHash='';snapshotHash='';
  const url=new URL(location.href);url.searchParams.set('run',id);history.replaceState(null,'',url);
  renderSnapshot();renderDetail();connect();
}

function renderStreams() {
  const q=state.query.toLowerCase();
  const groups=snapshot.workstreams.filter(w=>!q || (w.name+' '+w.project).toLowerCase().includes(q) || snapshot.nodes.some(n=>n.workstreamId===w.id && n.name.toLowerCase().includes(q)));
  el('workstreams').innerHTML=groups.length ? groups.map(w=>`<button type="button" class="cw-stream" data-stream="${esc(w.id)}" aria-pressed="${w.id===state.stream}"><span class="cw-stream-name">${esc(w.name)}</span><span class="cw-stream-meta ${w.attention?'cw-attn':''}"><span class="cw-dot"></span>${w.attention ? `${w.attention} need attention` : w.running ? `${w.running} recorded running` : `${w.runs} runs`} · ${esc(elapsed(w.updatedAt))}</span></button>`).join('') : '<p class="cw-sidebar-note">No matching workstreams.</p>';
}

function nodeCard(n) {
  const children=snapshot.nodes.filter(c=>c.parentId===n.id).length;
  const summary=n.role==='root' ? `${children} direct ${children===1?'member':'members'} · ${hostName(n.host)}` : n.status || `${hostName(n.host)} · ${n.launcher==='herdr'?'Herdr pane':n.launcher==='bg'?'Background session':'Captured process'}`;
  return `<button type="button" class="cw-node" data-node="${esc(n.id)}" aria-pressed="${state.node===n.id}" aria-label="${esc(n.name)}, ${esc(status(n))}"><span class="cw-node-head">${host(n)}<span class="cw-role">${esc(n.role==='root'?'Advisor session':n.role)}</span>${badge(n)}</span><span class="cw-node-title">${esc(n.name)}</span><span class="cw-node-summary">${esc(summary)}</span><span class="cw-node-foot"><span>${esc(n.model || hostName(n.host))}</span><span>${esc(elapsed(n.updatedAt))}</span></span></button>`;
}

function renderSnapshot() {
  const active=document.activeElement;
  const focusedNode=active?.getAttribute('data-node');
  const focusedStream=active?.getAttribute('data-stream');
  renderStreams();
  const w=group(), n=node();
  el('warnings').hidden=!snapshot.warnings.length;
  el('warnings').textContent=snapshot.warnings.join(' ');
  if(!w){
    el('stream-title').textContent='No Crew workstreams yet';
    el('stream-subtitle').textContent='Start a workstream with Crew in Claude Code or Codex. Its members will appear here.';
    el('attention').textContent='Waiting for local Crew records.';
    el('map').innerHTML='';return;
  }
  el('project').textContent=w.project+' / workstream';
  el('stream-title').textContent=w.name;
  el('stream-age').textContent='Updated '+elapsed(w.updatedAt);
  el('stream-subtitle').textContent=`${w.runs} Crew ${w.runs===1?'member':'members'} · Status comes from recorded Crew state.`;
  el('cwd').textContent=snapshot.nodes.find(n=>n.id===w.id)?.cwd || '';
  el('count').textContent=w.runs+' members';
  const needs=snapshot.nodes.filter(n=>n.workstreamId===w.id && attention(n));
  el('attention').classList.toggle('cw-clear',!needs.length);
  el('attention').innerHTML=needs.length ? `<span class="cw-attention-copy"><strong>${esc(needs[0].name)}</strong> · ${esc(status(needs[0]))}${needs.length>1 ? ` · ${needs.length-1} more` : ''}</span><button type="button" data-node="${esc(needs[0].id)}">Inspect agent ↗</button>` : '<span class="cw-attention-copy">No recorded blockers. Select a member to follow its actual output.</span>';
  const list=snapshot.nodes.filter(n=>n.workstreamId===w.id);
  const rendered=new Set();
  function tree(n) {
    if(rendered.has(n.id))return '';
    rendered.add(n.id);
    const children=list.filter(c=>c.parentId===n.id && !rendered.has(c.id));
    return nodeCard(n)+(children.length?`<div class="cw-children">${children.map(c=>`<div class="cw-child">${tree(c)}</div>`).join('')}</div>`:'');
  }
  const first=list.find(n=>n.id===w.id);
  let map=first?tree(first):'';
  for(const orphan of list)if(!rendered.has(orphan.id))map+=tree(orphan);
  el('map').innerHTML=map;
  if(n)el('inspect-head').innerHTML=`<div class="cw-inspect-top">${host(n)}<span class="cw-role">${esc(n.role==='root'?'Advisor session':n.role)}</span>${badge(n)}</div><h2>${esc(n.name)}</h2><p class="cw-model">${esc(n.model || hostName(n.host))}${n.effort?' · '+esc(n.effort)+' effort':''}</p><p class="cw-run-id">${esc(n.id)}${n.checks?' · reviews '+esc(n.checks):''}</p>`;
  if(focusedNode || focusedStream) [...root.querySelectorAll('button')].find(b=>focusedNode?b.dataset.node===focusedNode:b.dataset.stream===focusedStream)?.focus({preventScroll:true});
}

function renderDetail() {
  const n=node();
  root.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===state.tab)));
  el('stage').classList.toggle('cw-expanded',state.expanded && state.tab==='output');
  if(!n)return;
  if(!detail){el('details').innerHTML='<p class="cw-subtitle">Reading agent output…</p>';return;}
  const old=el('terminal-text');
  const scroll=old?.scrollTop || 0;
  const source=({'codex-session':'Codex transcript','claude-session':'Claude transcript','exec-log':'Captured process output',unavailable:'No output source'})[detail.source];
  const freshness=detail.updatedAt?'Last write '+elapsed(detail.updatedAt):'No recorded output';
  const warnings=detail.warnings.length?`<p class="cw-detail-warning">${esc(detail.warnings.join(' '))}</p>`:'';
  if(state.tab==='output') {
    const raw=detail.events.map(e=>`${e.at?'['+time(e.at)+'] ':''}${e.title}\n${e.text}`).join('\n\n');
    const bounded=raw.length>100_000 ? '[Earlier output omitted]\n'+raw.slice(-100_000) : raw;
    el('details').innerHTML=warnings+`<div class="cw-output-toolbar"><span>${esc(source)}</span><button type="button" data-expand class="cw-output-action">${state.expanded?'↙ Back to crew':'↗ Expand'}</button></div><div class="cw-terminal"><div class="cw-terminal-brand"><span>${esc(hostName(n.host))} / ${esc(n.role)}</span><span>Read only</span></div><pre id="terminal-text" aria-label="Agent output">${esc(bounded || (detail.source==='unavailable'?'No saved transcript or captured output was found for this session. Existing agents are not restarted or attached to obtain output.':'Waiting for public messages or tool output.'))}</pre><div class="cw-terminal-end">${esc(freshness)}${detail.truncated?' · Recent output only':''}</div></div><div class="cw-output-controls"><button type="button" class="cw-play" data-follow aria-pressed="${state.follow}">${state.follow?'↓ Following output':'↓ Follow output'}</button><span class="cw-replay-status">Public transcript · not a TUI screen</span></div>`;
    const terminal=el('terminal-text');
    terminal.scrollTop=state.follow ? terminal.scrollHeight : scroll;
    terminal.addEventListener('scroll',()=>{
      if(terminal.scrollHeight-terminal.clientHeight-terminal.scrollTop>30 && state.follow){state.follow=false;const b=root.querySelector('[data-follow]');b.textContent='↓ Follow output';b.setAttribute('aria-pressed','false');}
    },{passive:true});
  } else if(state.tab==='activity') {
    el('details').innerHTML=warnings+`<p class="cw-source-note">${esc(source)} · ${esc(freshness)}</p><div class="cw-activity-list">${detail.events.length?detail.events.slice(-35).reverse().map(e=>`<div class="cw-event"><span class="cw-time">${esc(e.at?time(e.at):e.kind)}</span><strong>${esc(e.title)}</strong>${e.kind==='message'?`<p>${esc(e.text)}</p>`:`<details><summary>Show ${esc(e.kind==='result'?'output':'details')}</summary><pre class="cw-code">${esc(e.text)}</pre></details>`}</div>`).join(''):'<p class="cw-subtitle">No public activity recorded yet.</p>'}</div>`;
  } else if(state.tab==='messages') {
    el('details').innerHTML=warnings+'<p class="cw-source-note">Mail history · reading here does not consume it.</p>'+(detail.messages.length?detail.messages.slice().reverse().map(m=>`<div class="cw-event"><span class="cw-time">${esc(time(m.at))} · ${esc(m.kind)}</span><strong>${esc(m.from)}</strong><p>${esc(m.text)}</p></div>`).join(''):'<div class="cw-empty"><h3>No messages yet</h3><p>Messages received by this agent will appear here.</p></div>');
  } else {
    const value=detail[state.tab];
    el('details').innerHTML=warnings+(value?`<pre class="cw-document">${esc(value)}</pre>`:`<div class="cw-empty"><h3>${state.tab==='packet'?'No Crew packet':'No result yet'}</h3><p>${state.tab==='packet'?'Root sessions receive their instructions in the host app. Select a Crew member to inspect its packet.':'The agent’s recorded result will appear here when it writes one.'}</p></div>`);
  }
}

root.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.dataset.node){select(b.dataset.node);return;}
  if(b.dataset.stream){
    state.expanded=false;
    const id=snapshot.nodes.find(n=>n.workstreamId===b.dataset.stream && n.role!=='root' && n.state==='running')?.id || b.dataset.stream;
    select(id);return;
  }
  if(b.dataset.tab)state.tab=b.dataset.tab;
  else if(b.hasAttribute('data-expand'))state.expanded=!state.expanded;
  else if(b.hasAttribute('data-follow'))state.follow=!state.follow;
  else return;
  const focus=b.hasAttribute('data-expand')?'[data-expand]':b.hasAttribute('data-follow')?'[data-follow]':null;
  renderDetail();if(focus)root.querySelector(focus)?.focus({preventScroll:true});
});
el('workstream-search').addEventListener('input',event=>{state.query=event.target.value;renderStreams();});
window.addEventListener('pagehide',()=>events?.close());
window.addEventListener('pageshow',event=>{if(event.persisted)connect();});
connect();
