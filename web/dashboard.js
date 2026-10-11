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
const state = { stream: '', node: '', session: '', tab: ['output','activity','packet','result','messages'].includes(new URLSearchParams(location.search).get('view')) ? new URLSearchParams(location.search).get('view') : 'output', expanded: false, follow: true, query: '', conversationFollow: true };
let events;
let detailHash = '';
let snapshotHash = '';
let wanted = new URLSearchParams(location.search).get('run') || '';

const node = () => snapshot.nodes.find(n => n.id === state.node);
const group = () => snapshot.workstreams.find(w => w.id === state.stream);
const roleName = n => n.role === 'root' ? (bootstrap?.sessions.find(s => s.rootNodeId === n.id)?.mode === 'cos' ? 'Chief of staff' : bootstrap?.sessions.some(s => s.rootNodeId === n.id) ? 'Advisor' : 'Root session · view only') : n.role;
const hostName = host => ({codex:'Codex',claude:'Claude Code',opencode:'OpenCode'}[host] || host);
const elapsed = at => {
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms)) return 'Unknown';
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? 'Just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m/60)}h ago` : `${Math.floor(m/1440)}d ago`;
};
const time = at => at && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';
const status = n => n.consoleState ? ({starting:'Starting',running:'Running',idle:'Idle',waiting:'Needs your answer',interrupted:'Interrupted',disconnected:'Disconnected',failed:'Failed',closed:'Closed'}[n.consoleState] || n.consoleState) : n.waitingSince ? 'Needs attention' : ({idle:n.assignment?.status === 'accepted' ? 'Idle · accepted' : n.assignment?.status === 'submitted' ? 'Idle · submitted' : 'Retained idle',running:'Running',done:'Result ready',blocked:'Blocked',failed:'Failed',stalled:'Stalled',stopped:'Stopped',untracked:'Root session'}[n.state] || n.state);
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
  const params = new URLSearchParams();
  if (state.node) params.set('node', state.node);
  if (state.session) params.set('session', state.session);
  const source = new EventSource('/api/events' + (params.size ? '?' + params : ''));
  events = source;
  source.onopen = () => { if (events === source) setConnection(true, '● Connected locally'); };
  source.onerror = () => { if (events === source) setConnection(false, 'Disconnected · retrying…'); };
  source.addEventListener('unavailable', () => { if (events === source) setConnection(false, 'Data unavailable · retrying…'); });
  source.addEventListener('update', event => {
    if (events !== source) return;
    try {
      const update = JSON.parse(event.data);
      const nextHash = JSON.stringify(update.snapshot);
      snapshot = update.snapshot;
      if (update.console && bootstrap) {
        bootstrap.sessions = update.console.sessions;
        renderSessions();
        if (update.console.detail?.session.id === state.session) acceptConsoleDetail(update.console.detail);
        else renderSession();
      }
      const current = selectedSession();
      if (!snapshot.nodes.some(n => n.id === state.node)) {
        const preferred = snapshot.nodes.find(n => n.id === (current?.rootNodeId || wanted) || n.name === wanted);
        wanted = '';
        const stream = preferred?.workstreamId || snapshot.workstreams[0]?.id || '';
        const first = preferred || snapshot.nodes.find(n => n.id === stream);
        if (first) { select(first.id); return; }
      }
      setConnection(true, '● Connected locally');
      if (nextHash !== snapshotHash) { snapshotHash = nextHash; renderSnapshot(); }
      const nextDetail = update.detail && update.detail.id === state.node ? update.detail : null;
      const hash = JSON.stringify(nextDetail);
      if (hash !== detailHash) { detailHash = hash; detail = nextDetail; renderDetail(); }
      el('observed').textContent = 'Refreshed ' + new Date().toLocaleTimeString();
    } catch { setConnection(false, 'Could not read update'); }
  });
}

function select(id) {
  const n = snapshot.nodes.find(n=>n.id===id);
  if(!n)return;
  state.node=n.id;state.stream=n.workstreamId;
  detail=null;detailHash='';snapshotHash='';
  const url=new URL(location.href);url.searchParams.set('run',id);history.replaceState(null,'',url);
  renderSnapshot();renderDetail();if(!state.session)renderSession();connect();
}

function renderStreams() {
  const q=state.query.toLowerCase();
  const managedRoots=new Set(bootstrap?.sessions.map(s=>s.rootNodeId) || []);
  const groups=snapshot.workstreams.filter(w=>!managedRoots.has(w.id)).filter(w=>!q || (w.name+' '+w.project).toLowerCase().includes(q) || snapshot.nodes.some(n=>n.workstreamId===w.id && n.name.toLowerCase().includes(q)));
  el('workstreams').innerHTML=groups.length ? groups.map(w=>`<button type="button" class="cw-stream" data-stream="${esc(w.id)}" aria-pressed="${w.id===state.stream}"><span class="cw-stream-name">${esc(w.name)}</span><span class="cw-stream-meta ${w.attention?'cw-attn':''}"><span class="cw-dot"></span>${w.attention ? `${w.attention} need attention` : w.running ? `${w.running} recorded running` : `${w.runs} runs`} · ${esc(elapsed(w.updatedAt))}</span></button>`).join('') : '<p class="cw-sidebar-note">No matching workstreams.</p>';
}

function nodeCard(n) {
  const children=snapshot.nodes.filter(c=>c.parentId===n.id).length;
  const summary=n.role==='root' ? `${children} direct ${children===1?'member':'members'} · ${hostName(n.host)}` : n.status || `${hostName(n.host)} · ${n.launcher==='herdr'?'Herdr pane':n.launcher==='bg'?'Background session':'Captured process'}`;
  return `<button type="button" class="cw-node" data-node="${esc(n.id)}" aria-pressed="${state.node===n.id}" aria-label="${esc(n.name)}, ${esc(status(n))}"><span class="cw-node-head">${host(n)}<span class="cw-role">${esc(roleName(n))}</span>${badge(n)}</span><span class="cw-node-title">${esc(n.name)}</span><span class="cw-node-summary">${esc(summary)}</span><span class="cw-node-foot"><span>${esc(n.model || hostName(n.host))}</span><span>${esc(elapsed(n.updatedAt))}</span></span></button>`;
}

function renderSnapshot() {
  const active=document.activeElement;
  const focusedNode=active?.getAttribute('data-node');
  const focusedStream=active?.getAttribute('data-stream');
  renderStreams();renderSessions();
  const w=group(), n=node();
  el('warnings').hidden=!snapshot.warnings.length;
  el('warnings').textContent=snapshot.warnings.join(' ');
  if(!w){
    el('stream-title').textContent='No Crew workstreams yet';
    el('stream-subtitle').textContent='Delegations appear here when the root creates them.';
    el('attention').textContent='Waiting for local Crew records.';
    el('map').innerHTML='';el('inspect-head').innerHTML='<h3>No member selected</h3>';el('details').innerHTML='<p class="cw-subtitle">The team’s work will appear here.</p>';return;
  }
  el('project').textContent=w.project+' / workstream';
  el('stream-title').textContent=w.name;
  el('stream-age').textContent='Updated '+elapsed(w.updatedAt);
  el('stream-subtitle').textContent=`${w.runs} Crew ${w.runs===1?'member':'members'} · Status comes from recorded Crew state.`;
  el('cwd').textContent=snapshot.nodes.find(n=>n.id===w.id)?.cwd || '';
  el('count').textContent=w.runs+' members';
  const needs=snapshot.nodes.filter(n=>n.workstreamId===w.id && attention(n));
  el('attention').classList.toggle('cw-clear',!needs.length);
  el('attention').innerHTML=needs.length ? `<span class="cw-attention-copy"><strong>${esc(needs[0].name)}</strong> · ${esc(needs[0].waitingSince ? 'Needs attention in its host' : status(needs[0]))}${needs.length>1 ? ` · ${needs.length-1} more` : ''}</span><button type="button" data-node="${esc(needs[0].id)}">Inspect agent ↗</button>` : '<span class="cw-attention-copy">No recorded blockers. Select a member to inspect its work.</span>';
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
  if(n)el('inspect-head').innerHTML=`<div class="cw-inspect-top">${host(n)}<span class="cw-role">${esc(roleName(n))}</span>${badge(n)}</div><h2>${esc(n.name)}</h2><p class="cw-model">${esc(n.model || hostName(n.host))}${n.effort?' · '+esc(n.effort)+' effort':''}</p><p class="cw-run-id">${esc(n.id)}${n.checks?' · reviews '+esc(n.checks):''}</p>`;
  if(focusedNode || focusedStream) [...root.querySelectorAll('button')].find(b=>focusedNode?b.dataset.node===focusedNode:b.dataset.stream===focusedStream)?.focus({preventScroll:true});
}

let inspectorSelection = '';
function renderDetail() {
  const signature = state.node + '/' + state.tab;
  const preserve = signature === inspectorSelection;
  const selectors = ['.cw-document','.cw-activity-list'];
  const scrolls = preserve ? selectors.map(selector => el('details').querySelector(selector)?.scrollTop || 0) : [];
  const expandedTools = preserve ? [...el('details').querySelectorAll('.cw-event details')].map(d => d.open) : [];
  renderDetailContent();
  if (preserve) {
    selectors.forEach((selector,i) => { const e = el('details').querySelector(selector); if(e)e.scrollTop = scrolls[i]; });
    el('details').querySelectorAll('.cw-event details').forEach((d,i) => d.open = !!expandedTools[i]);
  }
  inspectorSelection = signature;
}

function renderDetailContent() {
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
    const assignments = n?.assignment ? [...(n.assignmentHistory || []), n.assignment] : [];
    const history = state.tab === 'result' && assignments.length ? `<div class="cw-source-note">${assignments.map(a => `<p>Assignment ${esc(a.id)} · revision ${esc(a.revision)} · ${esc(a.status)}${a.accepted ? ` · accepted by ${esc(a.accepted.by)}` : ''}</p>${a.submissions.map(s => `<p>Submission ${esc(s.ref)}${s.accepted ? ' · accepted by '+esc(s.accepted.by)+' at '+esc(s.accepted.at) : ''}<br>Revision ${esc(s.revision)} · ${esc(s.status)}<br><code>${esc(s.hash)}</code><br><code>${esc(s.result)}</code></p>`).join('')}`).join('')}</div>` : '';
    el('details').innerHTML=warnings+history+(value?`<pre class="cw-document">${esc(value)}</pre>`:`<div class="cw-empty"><h3>${state.tab==='packet'?'No Crew packet':'No result yet'}</h3><p>${state.tab==='packet'?'Root sessions receive their instructions in the host app. Select a Crew member to inspect its packet.':'The agent’s recorded result will appear here when it writes one.'}</p></div>`);
  }
}

root.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.dataset.node){select(b.dataset.node);return;}
  if(b.dataset.stream){
    state.session='';consoleDetail=null;updateSelectionUrl();renderSession();
    state.expanded=false;
    const id=snapshot.nodes.find(n=>n.workstreamId===b.dataset.stream && n.role!=='root' && n.state==='running')?.id || b.dataset.stream;
    select(id);return;
  }
  if(b.dataset.tab){state.tab=b.dataset.tab;const url=new URL(location.href);url.searchParams.set('view',state.tab);history.replaceState(null,'',url);}
  else if(b.hasAttribute('data-expand'))state.expanded=!state.expanded;
  else if(b.hasAttribute('data-follow'))state.follow=!state.follow;
  else return;
  const focus=b.hasAttribute('data-expand')?'[data-expand]':b.hasAttribute('data-follow')?'[data-follow]':null;
  renderDetail();if(focus)root.querySelector(focus)?.focus({preventScroll:true});
});
el('workstream-search').addEventListener('input',event=>{state.query=event.target.value;renderStreams();renderSessions();});
window.addEventListener('pagehide',()=>events?.close());
window.addEventListener('pageshow',event=>{if(event.persisted)connect();});

/** @type {import('../src/console-types.ts').ConsoleBootstrap | null} */
let bootstrap = null;
/** @type {import('../src/console-types.ts').ConsoleDetail | null} */
let consoleDetail = null;
let capability = 'loading';
let loadingHistory = false;
let sessionLoading = false;
let consoleLoad = 0;
let launchPending = null;
let actionBusy = false;
const historyBySession = new Map();
const historyCursor = new Map();
const commandLabels = {queued:'Queued · waiting for the current turn', delivered:'Delivered to the root', failed:'Failed', uncertain:'Delivery uncertain · check before sending again', sending:'Sending…'};
const storage = {
  get(key, fallback = '') { try { return sessionStorage.getItem('crew-console:' + key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { sessionStorage.setItem('crew-console:' + key, value); } catch { /* Private browsing can deny storage. Current drafts remain in the page. */ } }
};
const drafts = new Map();
const pending = new Map();
try { for (const item of JSON.parse(storage.get('pending', '[]'))) if (item?.body?.requestId && item.path) { if (item.state === 'sending') item.state = 'uncertain'; pending.set(item.body.requestId, item); } } catch { /* Ignore corrupt browser state. */ }
const persistPending = () => storage.set('pending', JSON.stringify([...pending.values()].slice(-100)));
const requestId = () => crypto.randomUUID();
const selectedSession = () => bootstrap?.sessions.find(s => s.id === state.session);
const activeTurn = s => s && ['running','starting','waiting'].includes(s.state);
const setError = (id, text) => { el(id).hidden = !text; el(id).textContent = text || ''; };

let capabilityRefresh = null;
async function refreshCapability() {
  if (!capabilityRefresh) capabilityRefresh = (async () => {
    const next = await api('/api/console');
    if (!next.token || !bootstrap) throw new Error('Reconnect to recover console controls.');
    bootstrap.token = next.token;
  })().finally(() => { capabilityRefresh = null; });
  return capabilityRefresh;
}

async function api(path, body, refreshed = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(path, {method:body ? 'POST' : 'GET', credentials:'same-origin', cache:'no-store', signal:controller.signal,
      headers:body ? {'Content-Type':'application/json', 'X-Crew-Token':bootstrap.token} : {}, ...(body ? {body:JSON.stringify(body)} : {})});
    let value;
    try { value = await response.json(); } catch { throw Object.assign(new Error('The server returned an unreadable response.'), {uncertain:!!body}); }
    if (body && response.status === 403 && value.code === 'FORBIDDEN' && !refreshed) {
      // Rejection precedes controller effects. Recover a rotated listener token
      // and retry exactly this durable operation, including its original ID.
      await refreshCapability();
      return await api(path, body, true);
    }
    if (!response.ok) throw Object.assign(new Error(value.error || `Request failed (${response.status}).`), {code:value.code, status:response.status, uncertain:!!body && response.status >= 500});
    return value;
  } catch (error) {
    if (!error.status) error.uncertain = !!body;
    throw error;
  } finally { clearTimeout(timeout); }
}

async function loadBootstrap() {
  try {
    const value = await api('/api/console');
    if (!value.token || !Array.isArray(value.sessions) || !Array.isArray(value.providers)) throw new Error('The server’s console contract is incomplete.');
    bootstrap = value;
    capability = 'ready';
    el('capability-note').textContent = 'Launch and talk to managed roots here.';
    el('new-session').disabled = !value.providers.some(p => p.available);
    root.querySelectorAll('[data-new-session]').forEach(b => b.disabled = el('new-session').disabled);
    el('projects').innerHTML = value.projects.map(p => `<option value="${esc(p.cwd)}">${esc(p.name)}</option>`).join('');
    el('launch-host').innerHTML = value.providers.map(p => `<option value="${esc(p.id)}" ${p.available ? '' : 'disabled'}>${esc(p.label)}${p.available ? '' : ' · unavailable'}</option>`).join('');
    el('launch-host').value = value.providers.find(p => p.available)?.id || '';
    updateModels();
    if (!value.providers.some(p => p.available)) el('capability-note').textContent = value.providers.map(p => `${p.label}: ${p.reason || 'unavailable'}`).join(' · ') || 'No local providers available.';
    setError('console-error', '');
    renderSessions();
    return true;
  } catch (error) {
    capability = error.status === 404 ? 'observer' : 'error';
    el('capability-note').textContent = capability === 'observer' ? 'Observer-only server. Launch controls are unavailable.' : 'Console controls unavailable. Reconnect to retry.';
    el('new-session').disabled = true;
    root.querySelectorAll('[data-new-session]').forEach(b => b.disabled = true);
    if (capability !== 'observer') setError('console-error', error.message);
    renderSession();
    return false;
  }
}

function updateSelectionUrl() {
  const url = new URL(location.href);
  if (state.session) url.searchParams.set('session', state.session); else url.searchParams.delete('session');
  if (state.node) url.searchParams.set('run', state.node); else url.searchParams.delete('run');
  history.replaceState(null, '', url);
}

function saveDraft() {
  if (state.session) { drafts.set(state.session, el('message').value); storage.set('draft:' + state.session, el('message').value); }
}

async function selectSession(id) {
  saveDraft();
  const priorSession = state.session, priorNode = state.node;
  const s = bootstrap?.sessions.find(s => s.id === id);
  if (!s) return;
  state.session = id; state.stream = s.rootNodeId;
  state.node = priorSession === id && snapshot.nodes.some(n => n.id === priorNode && n.workstreamId === s.rootNodeId) ? priorNode : (!snapshot.nodes.length && wanted && new URLSearchParams(location.search).get('session') === id ? wanted : s.rootNodeId);
  wanted = '';
  state.expanded = false; state.conversationFollow = true;
  consoleDetail = null; detail = null; detailHash = ''; snapshotHash = ''; setError('console-error', '');
  sessionLoading = true;
  el('message').value = drafts.get(id) ?? storage.get('draft:' + id);
  el('conversation').replaceChildren(); el('requests').replaceChildren();
  updateSelectionUrl(); renderSessions(); renderSession(); renderSnapshot(); renderDetail(); connect();
  const load = ++consoleLoad;
  try { const d = await api(`/api/console/sessions/${encodeURIComponent(id)}`); if (load === consoleLoad && state.session === id) { sessionLoading = false; acceptConsoleDetail(d); } }
  catch (error) { if (load === consoleLoad) { sessionLoading = false; setError('console-error', error.message); renderSession(); } }
}

function renderSessions() {
  const active = document.activeElement?.dataset?.session;
  const q = state.query.toLowerCase();
  const sessions = (bootstrap?.sessions || []).filter(s => !q || `${s.title} ${s.cwd} ${s.host}`.toLowerCase().includes(q));
  el('sessions').innerHTML = sessions.length ? sessions.map(s => `<button type="button" class="cw-stream" data-session="${esc(s.id)}" aria-pressed="${s.id === state.session}"><span class="cw-stream-name">${esc(s.title)}</span><span class="cw-stream-meta ${s.pendingRequests || s.error ? 'cw-attn' : ''}"><span class="cw-dot"></span>${esc(s.state)}${s.pendingRequests ? ` · ${s.pendingRequests} request${s.pendingRequests === 1 ? '' : 's'}` : ''} · ${esc(hostName(s.host))}</span></button>`).join('') : `<p class="cw-sidebar-note">${q ? 'No matching sessions.' : 'Your managed sessions will stay here.'}</p>`;
  if (active) [...el('sessions').querySelectorAll('button')].find(b => b.dataset.session === active)?.focus({preventScroll:true});
}

function renderSession() {
  const s = selectedSession();
  el('composer').hidden = !s;
  el('pause-notice').hidden = s?.state !== 'interrupted';
  el('view-only').hidden = !!s || !state.stream;
  el('conversation-title').textContent = s?.title || (state.stream ? group()?.name || 'External workstream' : 'What are we building?');
  el('conversation-context').textContent = s ? `${s.mode === 'cos' ? 'Chief of staff' : 'Advisor'} / ${hostName(s.host)}` : state.stream ? 'External · view only' : 'Crew console';
  el('conversation-meta').textContent = s ? `${s.model || 'Host default'}${s.effort ? ' · ' + s.effort : ''} · ${s.cwd}` : state.stream ? 'Observe the team here. Talk to this root in its host app.' : 'Launch a root. Talk here. Follow the whole team alongside it.';
  el('session-state').textContent = s ? `${s.state}${s.pendingRequests ? ' · needs your answer' : ''}` : '';
  el('older').hidden = !s || !consoleDetail?.before;
  el('older').disabled = loadingHistory;
  if (!s) {
    el('requests').replaceChildren(); el('outbox').replaceChildren(); el('session-actions').replaceChildren();
    if (state.stream) el('conversation').innerHTML = '<div class="cw-welcome"><span class="cw-welcome-mark" aria-hidden="true">↗</span><h2>Following an external root.</h2><p>This workstream was launched outside the console. Select a member in the team pane to inspect its output, mission, result, and mail.</p></div>';
    return;
  }
  el('message').disabled = s.state === 'closed';
  el('send').disabled = ['closed','failed','disconnected','starting'].includes(s.state) || capability !== 'ready';
  el('send').textContent = activeTurn(s) && s.capabilities.activeInput === 'queue' ? 'Queue message' : activeTurn(s) ? 'Send steering' : 'Send';
  el('interrupt-send').hidden = !activeTurn(s) || !s.capabilities.interrupt;
  el('interrupt-send').disabled = s.state === 'starting' || capability !== 'ready';
  el('send-hint').textContent = s.state === 'closed' ? 'Closed · saved conversation' : s.state === 'interrupted' ? 'Root paused; members keep working. Send or resume to continue.' : ['failed','disconnected'].includes(s.state) ? 'Resume the session before sending.' : activeTurn(s) ? s.capabilities.activeInput === 'queue' ? 'Queued input waits for the current turn.' : 'Steering joins the current turn.' : '⌘ / Ctrl + Enter to send';
  const actions = [];
  if (activeTurn(s) && s.capabilities.interrupt) actions.push(['interrupt','Interrupt']);
  if (['idle','interrupted','disconnected','failed'].includes(s.state)) actions.push(['resume','Resume']);
  if (s.state !== 'closed') actions.push(['close','Close']);
  const html = actions.map(([action,label]) => `<button type="button" class="cw-text-button" data-action="${action}" ${actionBusy || capability !== 'ready' ? 'disabled' : ''}>${label}</button>`).join('');
  if (el('session-actions').innerHTML !== html) el('session-actions').innerHTML = html;
  if (s.error) setError('console-error', s.error);
  if (!consoleDetail && sessionLoading) el('conversation').innerHTML = '<p class="cw-subtitle">Loading conversation…</p>';
  renderOutbox();
}

function acceptConsoleDetail(next) {
  if (next.session.id !== state.session || (consoleDetail && next.session.revision < consoleDetail.session.revision)) return;
  const index = bootstrap.sessions.findIndex(s => s.id === next.session.id);
  if (index >= 0) bootstrap.sessions[index] = next.session; else bootstrap.sessions.unshift(next.session);
  const cache = historyBySession.get(state.session) || new Map();
  for (const event of next.events) cache.set(event.id, event);
  historyBySession.set(state.session, cache);
  if (!historyCursor.has(state.session)) historyCursor.set(state.session, next.before);
  consoleDetail = {...next, before:historyCursor.get(state.session)};
  sessionLoading = false;
  for (const event of next.events) if (event.command && pending.has(event.command.requestId)) {
    Object.assign(pending.get(event.command.requestId), {state:event.command.state, error:event.command.error});
  }
  for (const command of next.commands || []) if (pending.has(command.requestId)) {
    Object.assign(pending.get(command.requestId), {state:command.state, error:command.error});
  }
  persistPending();
  renderSession(); renderSessions(); renderConversation(); renderRequests();
}

function renderConversation() {
  if (!consoleDetail) return;
  const thread = el('conversation');
  const scroll = thread.scrollTop, height = thread.scrollHeight;
  const cached = historyBySession.get(state.session);
  const rows = [...cached.values()].sort((a,b) => a.sequence - b.sequence);
  if (!rows.length) { thread.innerHTML = '<p class="cw-subtitle">Waiting for the root’s first message…</p>'; return; }
  thread.querySelectorAll(':scope > :not([data-event])').forEach(e => e.remove());
  const existing = new Map([...thread.children].map(e => [e.dataset.event,e]));
  for (const event of rows) {
    let item = existing.get(event.id);
    if (!item) { item = document.createElement('article'); item.dataset.event = event.id; }
    let html;
    if (event.kind === 'tool') {
      item.className = 'cw-tool';
      const opened = item.querySelector('details')?.open;
      html = `<details ${opened ? 'open' : ''}><summary>${esc(event.title)} <span class="cw-tool-state">· ${esc(event.state)}</span></summary><pre>${esc(event.text)}</pre></details>`;
    } else if (event.kind === 'status') {
      item.className = 'cw-status-event'; html = esc(event.text);
    } else {
      item.className = 'cw-message cw-' + event.kind;
      html = `<div class="cw-message-header"><strong>${event.kind === 'user' ? 'You' : 'Root'}</strong><time datetime="${esc(event.at)}">${esc(time(event.at))}</time>${event.streaming ? '<span class="cw-streaming">Writing…</span>' : ''}</div><div class="cw-message-text">${esc(event.text)}</div>${event.command ? `<div class="cw-delivery">${esc(commandLabels[event.command.state])}${event.command.error ? ' · ' + esc(event.command.error) : ''}</div>` : ''}`;
    }
    if (item._html !== html) { item.innerHTML = html; item._html = html; }
    // Insert only new nodes or out-of-order history; existing selection and tool expansion survive updates.
    if (!item.isConnected) {
      const successor = [...thread.children].find(e => (cached.get(e.dataset.event)?.sequence ?? Infinity) > event.sequence);
      thread.insertBefore(item, successor || null);
    }
  }
  if (loadingHistory) thread.scrollTop = scroll + thread.scrollHeight - height;
  else thread.scrollTop = state.conversationFollow ? thread.scrollHeight : scroll;
  el('follow-conversation').hidden = state.conversationFollow;
}

function renderRequests() {
  if (!consoleDetail) return;
  const container = el('requests');
  const ids = new Set(consoleDetail.requests.map(r => r.id));
  container.querySelectorAll('[data-request]').forEach(e => { if (!ids.has(e.dataset.request)) e.remove(); });
  for (const r of consoleDetail.requests) {
    if ([...container.children].some(e => e.dataset.request === r.id)) continue;
    const card = document.createElement('form'); card.className = 'cw-request'; card.dataset.request = r.id;
    const heading = `<div class="cw-eyebrow">${r.kind === 'approval' ? 'Approval needed' : 'Your input needed'}</div><h3>${esc(r.title)}</h3>`;
    if (r.kind === 'approval') card.innerHTML = heading + `<p>${esc(r.description)}</p><div class="cw-request-actions">${r.options.map(o => `<button type="submit" name="option" value="${esc(o.id)}" aria-label="${esc(o.label)}" class="cw-secondary">${esc(o.label)}</button>`).join('')}</div>`;
    else card.innerHTML = heading + r.questions.map((q, qi) => `<fieldset data-question="${esc(q.id)}"><legend>${esc(q.question)}</legend>${(q.options || []).map((o, oi) => `<label class="cw-question-option"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q-${qi}" value="${esc(o.label)}"><span>${esc(o.label)}${o.description ? `<br><span class="cw-muted">${esc(o.description)}</span>` : ''}</span></label>`).join('')}<label class="cw-sr-only" for="answer-${esc(r.id)}-${qi}">Written answer: ${esc(q.question)}</label><textarea id="answer-${esc(r.id)}-${qi}" name="text-${qi}" rows="2" placeholder="${q.options?.length ? 'Or write your answer…' : 'Your answer…'}"></textarea></fieldset>`).join('') + '<div class="cw-request-actions"><button type="submit" class="cw-primary">Send answers</button></div>';
    card.insertAdjacentHTML('beforeend','<p class="cw-request-status" role="status"></p>');
    container.append(card);
    card.addEventListener('submit', async event => {
      event.preventDefault();
      if (capability !== 'ready') { card.querySelector('.cw-request-status').textContent = 'Console controls unavailable. Reconnect before answering.'; return; }
      const body = {requestId:requestId(), pendingRequestId:r.id};
      if (r.kind === 'approval') body.option = event.submitter?.value;
      else {
        body.answers = Object.create(null);
        for (const [qi,q] of r.questions.entries()) {
          const fields = card.querySelectorAll('fieldset')[qi];
          const picks = [...fields.querySelectorAll('input:checked')].map(i => i.value);
          const written = fields.querySelector('textarea').value.trim();
          const answer = q.multiSelect ? [...picks, ...(written ? [written] : [])] : written || picks[0];
          if (!answer || (Array.isArray(answer) && !answer.length)) { card.querySelector('.cw-request-status').textContent = 'Answer every question before sending.'; fields.querySelector('textarea').focus(); return; }
          body.answers[q.id] = answer;
        }
      }
      card.querySelectorAll('button,input,textarea').forEach(e => e.disabled = true);
      const sessionId = state.session;
      const item = await mutate(`/api/console/sessions/${encodeURIComponent(sessionId)}/answers`, body, sessionId, r.kind === 'approval' ? 'Approval answer' : 'Question answers');
      if (item.state === 'failed') card.querySelectorAll('button,input,textarea').forEach(e => e.disabled = false);
      card.querySelector('.cw-request-status').textContent = commandLabels[item.state];
    });
  }
}

function renderOutbox() {
  const visible = [...pending.values()].filter(item => item.sessionId === state.session && item.state !== 'delivered');
  const focusId = document.activeElement?.dataset?.retry;
  el('outbox').innerHTML = visible.map(item => `<div class="cw-pending"><strong>${esc(commandLabels[item.state])}</strong><p>${esc(item.label)}${item.body.text ? ': ' + esc(item.body.text) : ''}${item.error ? '\n' + esc(item.error) : ''}</p>${['failed','uncertain'].includes(item.state) && selectedSession()?.state !== 'closed' ? `<button type="button" class="cw-text-button" data-retry="${esc(item.body.requestId)}">${item.state === 'uncertain' ? 'Check delivery' : 'Retry ' + esc(item.label.toLowerCase())}</button>` : ''}</div>`).join('');
  if (focusId) [...el('outbox').querySelectorAll('button')].find(b => b.dataset.retry === focusId)?.focus({preventScroll:true});
}

async function mutate(path, body, sessionId, label, previous) {
  const item = previous || {path, body, sessionId, label};
  item.state = 'sending'; item.error = ''; pending.set(body.requestId, item); persistPending(); renderOutbox();
  try {
    const result = await api(path, body);
    item.state = result.command.state; item.error = result.command.error || '';
    const index = bootstrap.sessions.findIndex(s => s.id === result.session.id);
    if (index < 0) bootstrap.sessions.unshift(result.session); else if (bootstrap.sessions[index].revision <= result.session.revision) bootstrap.sessions[index] = result.session;
    renderSessions();
    if (state.session === sessionId) { setError('console-error', ''); renderSession(); }
  } catch (error) { item.state = error.uncertain ? 'uncertain' : 'failed'; item.error = error.message; }
  persistPending(); renderOutbox();
  return item;
}

async function sendMessage(interrupt = false) {
  const s = selectedSession(), text = el('message').value.trim();
  if (!s || !text || el('send').disabled) return;
  const body = {requestId:requestId(), text, ...(interrupt ? {interrupt:true} : {})};
  // The durable outbox owns this text before the network call; keep edits typed during delivery intact.
  el('message').value = ''; saveDraft();
  await mutate(`/api/console/sessions/${encodeURIComponent(s.id)}/messages`, body, s.id, 'Message');
  // Failed text stays in the outbox with an explicit retry; do not put a second copy in the composer.
}

async function action(action) {
  const s = selectedSession();
  if (!s || actionBusy) return;
  if (action === 'close') {
    const confirmed = await confirmAction('Close this session?', 'This stops the root and its Crew team. Saved conversations, results, and workspaces stay available.', 'Close session');
    if (!confirmed || selectedSession()?.id !== s.id) return;
  }
  actionBusy = true; renderSession();
  await mutate(`/api/console/sessions/${encodeURIComponent(s.id)}/actions`, {requestId:requestId(), action, revision:s.revision}, s.id, action[0].toUpperCase() + action.slice(1));
  actionBusy = false; renderSession();
}

function confirmAction(title, copy, button) {
  el('confirm-title').textContent = title; el('confirm-copy').textContent = copy; el('confirm-action').textContent = button; el('confirm-action').setAttribute('aria-label',button);
  const dialog = el('confirm-dialog'); dialog.returnValue = ''; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {once:true}));
}

function updateModels() {
  const provider = bootstrap?.providers.find(p => p.id === el('launch-host').value);
  if (!provider) { el('launch-submit').disabled = true; return; }
  el('launch-submit').disabled = !provider.available;
  const accessLabels = {default:'Host default', workspace:'Workspace writes', full:'Full access'};
  const accessModes = provider.capabilities.accessModes || (provider.id === 'claude' ? ['default','full'] : ['default','workspace','full']);
  const access = el('launch-access').value;
  el('launch-access').innerHTML = accessModes.map(a => `<option value="${esc(a)}">${esc(accessLabels[a])}</option>`).join('');
  el('launch-access').value = accessModes.includes(access) ? access : 'default';
  el('launch-model').innerHTML = '<option value="">Host default</option>' + provider.models.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
  el('launch-model').value = provider.models.some(m => m.id === provider.defaultModel) ? provider.defaultModel : '';
  el('provider-note').textContent = !provider.available ? provider.reason || 'Provider unavailable.' : `${provider.capabilities.activeInput === 'queue' ? 'Active messages queue until the turn ends.' : 'Active messages steer the current turn.'}${provider.capabilities.interrupt ? ' Interruption is available.' : ''}`;
  updateEfforts();
}
function updateEfforts() {
  const provider = bootstrap?.providers.find(p => p.id === el('launch-host').value);
  const model = provider?.models.find(m => m.id === el('launch-model').value);
  el('launch-effort').innerHTML = '<option value="">Host default</option>' + (model?.efforts || []).map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  el('launch-effort').disabled = !model?.efforts?.length;
}
function openLaunch() {
  if (capability !== 'ready' || el('new-session').disabled) return;
  if (!el('launch-cwd').value) el('launch-cwd').value = selectedSession()?.cwd || bootstrap.projects[0]?.cwd || '';
  el('launch-dialog').showModal();
}

el('launch-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = el('launch-form');
  const data = new FormData(form);
  const payload = launchPending || {requestId:requestId(), cwd:String(data.get('cwd')).trim(), host:data.get('host'), mode:data.get('mode'), prompt:String(data.get('prompt')).trim(), access:data.get('access'),
    ...(data.get('title') ? {title:String(data.get('title')).trim()} : {}), ...(data.get('model') ? {model:data.get('model')} : {}), ...(data.get('effort') ? {effort:data.get('effort')} : {})};
  if (!payload.prompt || !payload.cwd.startsWith('/')) { setError('launch-error','Enter an outcome and an absolute project directory.'); return; }
  form.querySelectorAll('input,textarea,select,button').forEach(e => e.disabled = true);
  setError('launch-error',''); el('launch-submit').textContent = 'Launching…';
  try {
    const result = await api('/api/console/sessions', payload);
    const index = bootstrap.sessions.findIndex(s => s.id === result.session.id);
    if (index < 0) bootstrap.sessions.unshift(result.session); else bootstrap.sessions[index] = result.session;
    launchPending = null; storage.set('launch-pending','');
    el('launch-dialog').close();
    form.reset(); updateModels();
    if (result.command.state !== 'delivered') {
      pending.set(payload.requestId, {path:'/api/console/sessions', body:payload, sessionId:result.session.id, label:'Session launch', state:result.command.state, error:result.command.error || ''}); persistPending();
    }
    await selectSession(result.session.id);
  } catch (error) {
    launchPending = error.uncertain ? payload : null;
    storage.set('launch-pending', launchPending ? JSON.stringify(launchPending) : '');
    setError('launch-error', error.message + (error.uncertain ? ' The launch may have reached the host. Check this same launch before starting another.' : ''));
  } finally {
    form.querySelectorAll('input,textarea,select,button').forEach(e => e.disabled = !!launchPending);
    form.querySelectorAll('[data-close-dialog]').forEach(e => e.disabled = false);
    el('launch-submit').disabled = false;
    el('launch-submit').textContent = launchPending ? 'Check launch' : 'Launch session';
    if (!launchPending) el('launch-effort').disabled = !el('launch-effort').options.length || el('launch-effort').options.length === 1;
  }
});

root.addEventListener('click', async event => {
  const b = event.target.closest('button'); if (!b) return;
  if (b.dataset.session) { await selectSession(b.dataset.session); return; }
  if (b.hasAttribute('data-new-session') || b.id === 'new-session') { openLaunch(); return; }
  if (b.hasAttribute('data-close-dialog')) { el('launch-dialog').close(); return; }
  if (b.dataset.action) { await action(b.dataset.action); return; }
  if (b.dataset.retry) {
    if (b.disabled) return; b.disabled = true;
    const previous = pending.get(b.dataset.retry); if (!previous) return;
    const body = previous.state === 'uncertain' ? previous.body : {...previous.body, requestId:requestId()};
    if (body.revision !== undefined && previous.state !== 'uncertain') body.revision = selectedSession()?.revision ?? body.revision;
    pending.delete(previous.body.requestId);
    await mutate(previous.path, body, previous.sessionId, previous.label, {...previous,body});
  }
});
el('composer').addEventListener('submit', event => { event.preventDefault(); sendMessage(); });
el('message').addEventListener('input',saveDraft);
el('message').addEventListener('keydown',event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); sendMessage(); } });
el('interrupt-send').addEventListener('click', async () => {
  if (!el('message').value.trim()) { el('message').focus(); return; }
  if (await confirmAction('Interrupt and send?', 'Interrupt the root’s current turn and start a new turn with your message. Delegated members keep working.', 'Interrupt & send')) await sendMessage(true);
});
el('launch-host').addEventListener('change',updateModels);
el('launch-model').addEventListener('change',updateEfforts);
el('conversation').addEventListener('scroll', () => {
  const t = el('conversation');
  state.conversationFollow = t.scrollHeight - t.scrollTop - t.clientHeight < 35;
  el('follow-conversation').hidden = state.conversationFollow;
}, {passive:true});
el('follow-conversation').addEventListener('click', () => { state.conversationFollow = true; el('conversation').scrollTop = el('conversation').scrollHeight; el('follow-conversation').hidden = true; });
el('older').addEventListener('click', async () => {
  if (loadingHistory || !consoleDetail?.before) return;
  const id = state.session, cursor = consoleDetail.before;
  loadingHistory = true; renderSession(); el('older').textContent = 'Loading history…';
  try {
    const older = await api(`/api/console/sessions/${encodeURIComponent(id)}?before=${encodeURIComponent(cursor)}`);
    if (state.session !== id) return;
    const cache = historyBySession.get(id);
    for (const event of older.events) if (!cache.has(event.id)) cache.set(event.id,event);
    historyCursor.set(id, older.before); consoleDetail.before = older.before;
    renderConversation();
  } catch (error) { if (state.session === id) setError('console-error',error.message); }
  finally { loadingHistory = false; el('older').textContent = '↑ Load older messages'; renderSession(); }
});
el('reconnect').addEventListener('click', async () => {
  const ok = await loadBootstrap();
  if (ok && state.session) await selectSession(state.session); else connect();
});
window.addEventListener('pagehide',saveDraft);

(async () => {
  await loadBootstrap();
  try {
    launchPending = JSON.parse(storage.get('launch-pending','null'));
    if (launchPending) {
      el('launch-host').value = launchPending.host; updateModels();
      el('launch-model').value = launchPending.model || ''; updateEfforts();
      for (const [field,value] of Object.entries(launchPending)) { const control = el('launch-form').elements.namedItem(field); if (control && field !== 'model' && field !== 'host') control.value = value; }
      el('advanced').open = true;
      el('launch-submit').textContent = 'Check launch'; el('launch-form').querySelectorAll('input,textarea,select').forEach(e => e.disabled = true); setError('launch-error','A previous launch has uncertain delivery. Check it before starting another.');
    }
  } catch { launchPending = null; }
  const requested = new URLSearchParams(location.search).get('session');
  const selected = bootstrap?.sessions.find(s => s.id === requested) || (!wanted ? bootstrap?.sessions[0] : null);
  if (selected) await selectSession(selected.id); else connect();
})();
