"""Synthetic interaction proof through an already-provisioned, isolated Jev browser.

Required: CONSOLE_EVIDENCE_DIR, BU_NAME, BU_CDP_WS.
Starts and cleans up its own synthetic fixture unless CONSOLE_FIXTURE_URL is set.
Run with installed Jev environment's Python. Never points at a real Crew server.
The fixture at console-ui.ts exposes /fixture to inject controlled failure/stream states.
"""
import base64
import json
import os
import subprocess
from pathlib import Path
from urllib.request import Request, urlopen

assert os.environ.get('BU_NAME') and os.environ.get('BU_CDP_WS'), 'Bind an owned Chrome endpoint before importing Jev'
os.environ['BH_REQUIRE_EXISTING_DAEMON'] = '1'
from jev_ultrafast import Browser
from jev_ultrafast.browser import StalePage

owned_server = None
url = os.environ.get('CONSOLE_FIXTURE_URL')
if not url:
    owned_server = subprocess.Popen(['node',str(Path(__file__).with_name('console-ui.ts'))],stdout=subprocess.PIPE,text=True)
    url = owned_server.stdout.readline().strip()
assert url.startswith('http://127.0.0.1:'), 'Synthetic loopback fixture only'
out = Path(os.environ['CONSOLE_EVIDENCE_DIR'])
out.mkdir(parents=True, exist_ok=True)
checks = []
try:
    with urlopen(url+'/fixture') as response:
        assert json.load(response).get('fixture') is True, 'Refuse non-fixture server'
    browser = Browser(url)
except BaseException:
    if owned_server:
        owned_server.terminate();owned_server.wait(timeout=10)
    raise

def evaluate(expr):
    return browser.evaluate(expr)

def wait(expr):
    result = browser.call('Runtime.evaluate', expression="""(() => new Promise(resolve => {
        const until=performance.now()+4000;
        const probe=()=>{if (%s) resolve(true); else if(performance.now()>until)resolve(false);else requestAnimationFrame(probe)};
        probe();
    }))()""" % expr, awaitPromise=True, returnByValue=True)
    assert result.get('result', {}).get('value'), 'Condition failed: ' + expr

def scroll_to(selector):
    doc = browser.call('DOM.getDocument')['root']['nodeId']
    node = browser.call('DOM.querySelector', nodeId=doc, selector=selector)['nodeId']
    assert node, selector
    browser.call('DOM.scrollIntoViewIfNeeded', nodeId=node)

def act(label, kind='click', text=None, contains=False):
    for _ in range(5):
        page = browser.observe(screenshot=False)
        matches = [a for a in page['actions'] if a['kind'] == kind and (label in ' '.join(a['label'].split()) if contains else ' '.join(a['label'].split()) == label)]
        assert matches, 'Missing observed action: ' + label + ' / ' + json.dumps([(a['kind'], a['label']) for a in page['actions']])
        try:
            browser.act(matches[-1], page, text=text)
            browser.observe(screenshot=False)
            return
        except StalePage:
            continue
    raise AssertionError('Control did not settle: ' + label)

def fixture(body=None):
    request = Request(url + '/fixture', data=json.dumps(body).encode() if body else None, headers={'Content-Type':'application/json'})
    with urlopen(request) as response:
        return json.load(response)

def check(label, condition=True):
    assert condition, label
    checks.append(label)
    print('PASS ' + label, flush=True)

def screenshot(name):
    (out / name).write_bytes(base64.b64decode(browser.call('Page.captureScreenshot', format='png')['data']))

try:
    browser.call('Emulation.setDeviceMetricsOverride', width=1440, height=1000, deviceScaleFactor=1, mobile=False)
    browser.call('Emulation.setEmulatedMedia', features=[{'name':'prefers-color-scheme','value':'light'}])
    wait("document.querySelector('#conversation-title').textContent==='Ship the Crew console' && document.querySelector('[data-event=\"stream-1\"]')")
    check('Managed session loads durable conversation and team', evaluate("document.querySelectorAll('#map [data-node]').length===4"))
    screenshot('console-desktop-light.png')
    check('Managed root role matches conversation', evaluate("document.querySelector('#inspect-head').textContent.includes('Chief of staff') && document.querySelector('[data-node=managed-root]').textContent.includes('Chief of staff')"))
    check('Output is escaped', evaluate("!window.injected && document.querySelector('#member-output').textContent.includes('Verification')"))
    fixture({'streaming':'# Root progress\n\nThe **plan** is ready.\n\n- Readable prose\n- Scoped controls\n\n```ts\nconst safe = true;'})
    wait("document.querySelector('#conversation [data-event=stream-1] h2')")
    check('Root markdown streams headings, lists, code and unclosed fences',evaluate("!!document.querySelector('#conversation [data-event=stream-1] ul') && !!document.querySelector('#conversation [data-event=stream-1] pre code')"))
    approval={'id':'shared-approval','kind':'approval','title':'Write scoped evidence','description':'Allow this synthetic member to save its fixture report.','options':[{'id':'allow','label':'Allow member write'},{'id':'deny','label':'Deny member write'}]}
    fixture({'child':'core','childRequests':[approval],'childState':'waiting','childWaiting':True})
    fixture({'child':'ui','childRequests':[approval],'childState':'waiting'})
    wait("document.querySelectorAll('#team-requests [data-node]').length===2")
    check('Team queue attributes each same-ID request to its exact host/member',evaluate("document.querySelector('#team-requests').textContent.includes('Claude Code') && document.querySelector('#team-requests').textContent.includes('Codex') && document.querySelector('#team-requests').textContent.includes('core')"))
    check('Managed member labels name the console connection and answer surface',evaluate("document.querySelector('#map [data-node=core] .cw-node-summary').textContent.includes('Managed console connection') && document.querySelector('#attention').textContent.includes('Needs your answer here') && !document.querySelector('#attention').textContent.includes('in its host')"))
    scroll_to('#team-requests');screenshot('readable-team-queue.png');act('Review approval for console-core (core)')
    wait("document.querySelector('#member-requests [data-request=shared-approval]') && document.querySelector('#member-output h2')")
    check('Queue review brings its exact request into view and keyboard focus',evaluate("(()=>{const e=document.querySelector('#member-requests [data-request=shared-approval]'),r=e.getBoundingClientRect();return e.contains(document.activeElement) && r.top>=0 && r.bottom<=innerHeight})()"))
    check('Selected managed member shows typed provider state and separate run/assignment state',evaluate("document.querySelector('#member-controls').textContent.includes('waiting') && document.querySelector('#member-controls').textContent.includes('Crew running') && document.querySelector('#member-controls').textContent.includes('assignment active')"))
    check('Member prose has structured paragraphs, lists, code and table',evaluate("!!document.querySelector('#member-output ul') && !!document.querySelector('#member-output table') && !!document.querySelector('#member-output pre code')"))
    scroll_to('#member-output [data-event=child-tool]');act('Verify request delivery',contains=True)
    wait("document.querySelector('#member-output details').open")
    check('Member tool output pretty-prints JSON',evaluate("document.querySelector('#member-output details pre').textContent.includes('\\n  \"path\"')"))
    scroll_to('#member-controls');screenshot('readable-member-approval.png')
    browser.evaluate("window.fixtureNode=document.querySelector('#member-output [data-event=child-prose]');window.fixtureTool=document.querySelector('#member-output [data-event=child-tool]')")
    page_scroll=evaluate('scrollY')
    fixture({'child':'core','childStreaming':'# Streamed member\n\n**Still safe** <script>window.injected=true</script>\n\n[bad](javascript:alert) ![remote](https://example.com/tracker.png)\n\n```ts\nconst incomplete ='})
    wait("document.querySelector('#member-output h2').textContent==='Streamed member'")
    check('Routine member SSE preserves page scroll after queue navigation',abs(evaluate('scrollY')-page_scroll)<3)
    check('Streaming keeps DOM identity and expanded tool state',evaluate("window.fixtureNode===document.querySelector('#member-output [data-event=child-prose]') && window.fixtureTool===document.querySelector('#member-output [data-event=child-tool]') && document.querySelector('#member-output details').open"))
    check('Malicious member HTML, URLs and remote images remain literal',evaluate("!window.injected && !document.querySelector('#member-output script,#member-output img,#member-output a') && document.querySelector('#member-output').textContent.includes('<script>')"))
    scroll_to('#member-output details');act('Copy output')
    check('Tool copy reports its actual outcome',evaluate("['Copied','Copy unavailable. Select the output to copy.'].includes(document.querySelector('#member-output .cw-tool-actions [role=status]').textContent)"))
    scroll_to('[data-raw-output]');act('Raw view')
    wait("document.querySelector('#terminal-text')")
    check('Raw transcript remains available with source freshness',evaluate("document.querySelector('#terminal-text').textContent.includes('<script>') && document.querySelector('#output-freshness').textContent.includes('Last public event')"))
    act('Readable view');wait("document.querySelector('#member-output [data-event=child-prose]')")
    fixture({'child':'core','childEvent':{'id':'child-long','sequence':3,'at':'2026-10-12T10:00:00Z','kind':'assistant','streaming':False,'text':'# Long result\n\n'+('Evidence paragraph with /very/long/path/'+('directory/'*10)+'file.ts\n\n')*45}})
    wait("document.querySelector('#member-output [data-event=child-long]')")
    scroll_to('#member-output')
    box=evaluate("(()=>{const r=document.querySelector('#member-output').getBoundingClientRect();return {x:r.x+r.width/2,y:Math.min(innerHeight-20,r.y+Math.min(r.height/2,100))}})()")
    browser.call('Input.dispatchMouseEvent',type='mouseWheel',x=box['x'],y=box['y'],deltaX=0,deltaY=-400)
    wait("document.querySelector('[data-follow]').getAttribute('aria-pressed')==='false'")
    position=evaluate("document.querySelector('#member-output').scrollTop")
    fixture({'child':'core','childStreaming':'# Streamed member\n\nUpdated while paused.'})
    wait("document.querySelector('#member-output').textContent.includes('Updated while paused')")
    check('Member streaming preserves paused scroll position',abs(evaluate("document.querySelector('#member-output').scrollTop")-position)<3)
    scroll_to('[data-follow]');act('↓ Follow output')
    wait("document.querySelector('[data-follow]').getAttribute('aria-pressed')==='true'")
    check('Member follow control resumes tail scrolling',evaluate("(()=>{const e=document.querySelector('#member-output');return e.scrollHeight-e.scrollTop-e.clientHeight<3})()"))
    browser.call('Emulation.setDeviceMetricsOverride',width=390,height=844,deviceScaleFactor=1,mobile=True)
    wait("innerWidth===390")
    scroll_to('#member-requests')
    check('Member requests and long output paths fit narrow viewport',evaluate("document.documentElement.scrollWidth<=innerWidth && document.querySelector('#member-requests').scrollWidth<=innerWidth"))
    screenshot('readable-member-mobile.png')
    browser.call('Emulation.setDeviceMetricsOverride',width=1440,height=1000,deviceScaleFactor=1,mobile=False)
    wait("innerWidth===1440")
    scroll_to('#member-requests');act('Allow member write')
    wait("document.querySelectorAll('#team-requests [data-node]').length===1")
    log=fixture()['requests'][-1]
    check('Approval targets only selected member and typed request/option',log['path'].endswith('/children/core/answers') and log['body']['pendingRequestId']=='shared-approval' and log['body']['option']=='allow')
    scroll_to('#team-requests');act('Review approval for console-ui (ui)')
    wait("document.querySelector('#member-requests [data-request=shared-approval]')")
    scroll_to('#member-requests');act('Deny member write')
    wait("document.querySelector('#team-requests').hidden")
    check('Same request ID on another host can be independently denied',fixture()['requests'][-1]['path'].endswith('/children/ui/answers') and fixture()['requests'][-1]['body']['option']=='deny')
    question={'id':'child-question','kind':'question','title':'Evidence scope','questions':[{'id':'scope','question':'What should this member retain?'}]}
    fixture({'child':'ui','childRequests':[question]})
    wait("document.querySelector('#member-requests [data-request=child-question]')")
    scroll_to('#member-requests');act('Written answer: What should this member retain?','fill','Screenshots and receipts')
    fixture({'child':'ui','childStreaming':'Member is waiting for your draft.'})
    wait("document.querySelector('#member-output').textContent.includes('waiting for your draft')")
    check('Child answer draft survives streaming updates',evaluate("document.querySelector('#answer-ui-child-question-0').value==='Screenshots and receipts'"))
    scroll_to('#member-requests');act('Send answers')
    wait("!document.querySelector('#member-requests [data-request=child-question]')")
    check('Child question uses typed answer map',fixture()['requests'][-1]['body']['answers']=={'scope':'Screenshots and receipts'})
    fixture({'child':'ui','childRequests':[{**approval,'id':'uncertain-approval'}]})
    wait("document.querySelector('#member-requests [data-request=uncertain-approval]')")
    fixture({'fail':'server'})
    scroll_to('#member-requests');act('Allow member write')
    wait("document.querySelector('#outbox').textContent.includes('Delivery uncertain')")
    original=fixture()['requests'][-1]['body']['requestId']
    check('Uncertain child answer stays pending without success claim',evaluate("!!document.querySelector('#member-requests [data-request=uncertain-approval]') && document.querySelector('#member-requests button').disabled"))
    scroll_to('#outbox [data-retry]');act('Check delivery')
    wait("!document.querySelector('#member-requests [data-request=uncertain-approval]')")
    check('Child receipt retry preserves exact request ID and target',fixture()['requests'][-1]['body']['requestId']==original and fixture()['requests'][-1]['path'].endswith('/children/ui/answers'))
    fixture({'child':'ui','childRequests':[{**approval,'id':'stale-approval'}]})
    wait("document.querySelector('#member-requests [data-request=stale-approval]')")
    fixture({'fail':'stale'})
    scroll_to('#member-requests');act('Deny member write')
    wait("document.querySelector('#member-requests').textContent.includes('Request is no longer pending')")
    check('Stale child request exposes server rejection without claiming success',evaluate("document.querySelector('#member-requests .cw-request-status').textContent.startsWith('Failed')"))
    fixture({'child':'ui','childRequests':[]})
    wait("!document.querySelector('#member-requests [data-request]')")
    fixture({'child':'ui','childState':'running'})
    wait("document.querySelector('[data-child-action=interrupt]')")
    scroll_to('#member-controls');act('Interrupt member')
    wait("document.querySelector('#member-controls').textContent.includes('interrupted')")
    check('Interrupt acts on member while root stays running',fixture()['requests'][-1]['body']['action']=='interrupt' and evaluate("document.querySelector('#session-state').textContent==='running'"))
    act('Resume member')
    wait("document.querySelector('#member-controls').textContent.includes('idle')")
    check('Resume member binds current revision',isinstance(fixture()['requests'][-1]['body']['revision'],int))
    act('Stop member');wait("document.querySelector('#confirm-dialog').open")
    check('Stop confirmation names selected member',evaluate("document.querySelector('#confirm-title').textContent==='Stop console-ui?'"))
    act('Stop member');wait("document.querySelector('#member-controls').textContent.includes('closed')")
    check('Stop preserves root conversation and disables member actions',evaluate("!document.querySelector('[data-child-action]') && document.querySelector('#session-state').textContent==='running'"))
    scroll_to('[data-node=checker]');act('delivery-checker, Needs attention')
    wait("document.querySelector('#member-controls').textContent.includes('View only')")
    check('Pre-existing unmanaged member exposes honest control capability',evaluate("!document.querySelector('#member-controls button') && !document.querySelector('#member-requests button')"))
    scroll_to('[data-tab=packet]');act('Mission');wait("document.querySelector('#details h2')")
    check('Mission and result prose use same readable renderer',evaluate("!!document.querySelector('#details strong')"))
    act('Result');wait("document.querySelector('#details h2')")
    check('Result preserves acceptance history and formatted evidence',evaluate("document.querySelector('#details').textContent.includes('submission-1') && !!document.querySelector('#details code')"))
    act('Output')
    scroll_to('[data-node=managed-root]');act('Ship the Crew console, Running')
    wait("document.querySelector('#inspect-head').textContent.includes('Chief of staff')")
    screenshot('readable-team-desktop.png')
    act('Message the root','fill','Draft preserved across selection')
    act('Library cleanup',contains=True)
    wait("!document.querySelector('#view-only').hidden")
    check('External root is explicitly view-only', evaluate("document.querySelector('#composer').hidden"))
    act('Ship the Crew console running',contains=True)
    wait("!document.querySelector('#composer').hidden")
    check('Draft survives changing sessions', evaluate("document.querySelector('#message').value==='Draft preserved across selection'"))
    browser.call('Page.reload')
    wait("document.querySelector('#message').value==='Draft preserved across selection'")
    check('Draft and session selection survive reload')
    act('Message the root','fill','Steer with **literal** <script>alert(1)</script>')
    act('Send steering')
    wait("document.querySelector('#conversation').textContent.includes('Steer with **literal**')")
    log=fixture()['requests'][-1]
    check('Active Codex message uses capability header and same-origin Origin', log['token'] and log['origin']==url and log['body']['text']=='Steer with **literal** <script>alert(1)</script>')
    check('User Markdown remains literal',evaluate("document.querySelector('#conversation').textContent.includes('**literal**') && !document.querySelector('#conversation .cw-user .cw-message-text strong')"))
    check('User content is text, never HTML', evaluate("!document.querySelector('#conversation script')"))
    act('↑ Load older messages')
    wait("document.querySelector('[data-event=\"event-20\"]')")
    first=evaluate("document.querySelector('#conversation').firstElementChild.dataset.event")
    # Scroll with compositor input, inside the history pane.
    browser.call('Input.dispatchMouseEvent', type='mouseWheel', x=450, y=400, deltaX=0, deltaY=-600)
    wait("!document.querySelector('#follow-conversation').hidden")
    position=evaluate("document.querySelector('#conversation').scrollTop")
    fixture({'streaming':'Streaming is complete; delivery stays honest.'})
    wait("document.querySelector('[data-event=\"stream-1\"]').textContent.includes('Streaming is complete')")
    check('Streaming updates preserve history scroll', abs(evaluate("document.querySelector('#conversation').scrollTop")-position)<3)
    act('↑ Load older messages')
    wait("document.querySelector('#conversation').firstElementChild.dataset.event!=="+json.dumps(first))
    check('History cursor advances across SSE updates')
    scroll_to('#follow-conversation');act('↓ Latest messages')
    wait("document.querySelector('#follow-conversation').hidden")
    check('Follow-latest explicitly returns to newest output')
    act('Message the root','fill','Transport retry uses one ID')
    fixture({'fail':'server'})
    act('Send steering')
    wait("document.querySelector('#outbox').textContent.includes('Delivery uncertain')")
    original=fixture()['requests'][-1]['body']['requestId']
    scroll_to('[data-retry]');act('Check delivery')
    wait("document.querySelector('#conversation').textContent.includes('Transport retry uses one ID')")
    check('Uncertain server response retry reuses exact request ID', fixture()['requests'][-1]['body']['requestId']==original)
    act('Message the root','fill','Definitive rejection retries explicitly')
    fixture({'fail':'rejected'})
    act('Send steering')
    wait("document.querySelector('#outbox').textContent.includes('Synthetic rejection')")
    rejected=fixture()['requests'][-1]['body']['requestId']
    scroll_to('[data-retry]');act('Retry message')
    wait("!document.querySelector('#outbox').textContent.includes('Synthetic rejection')")
    check('Confirmed failure retry creates a new request ID', fixture()['requests'][-1]['body']['requestId']!=rejected)
    requests=[{'id':'approve-1','kind':'approval','title':'Allow the scoped write?','description':'Write only within the selected project.','options':[{'id':'allow','label':'Allow scoped write'},{'id':'deny','label':'Deny write'}]}, {'id':'question-1','kind':'question','title':'Choose the delivery plan','questions':[{'id':'lane','question':'Which delivery lane?','options':[{'label':'Local proof','description':'Verify without a provider.'},{'label':'Provider proof','description':'Use the test host.'}]},{'id':'notes','question':'What should we retain?'}]}]
    fixture({'requests':requests,'state':'waiting'})
    wait("document.querySelectorAll('[data-request]').length===2")
    scroll_to('[data-request="approve-1"]');act('Allow scoped write')
    wait("!document.querySelector('[data-request=\"approve-1\"]')")
    check('Approval uses typed pending request and option', fixture()['requests'][-1]['body']['pendingRequestId']=='approve-1' and fixture()['requests'][-1]['body']['option']=='allow')
    scroll_to('[data-request="question-1"]');act('Local proof',contains=True)
    scroll_to('#answer-root-question-1-1');act('Written answer: What should we retain?','fill','Keep the evidence files.')
    fixture({'streaming':'The root is waiting for your choices.'})
    wait("document.querySelector('[data-event=\"stream-1\"]').textContent.includes('waiting for your choices')")
    check('Question draft survives streaming updates',evaluate("document.querySelector('#answer-root-question-1-1').value==='Keep the evidence files.'"))
    scroll_to('[data-request="question-1"] button');act('Send answers')
    wait("!document.querySelector('[data-request=\"question-1\"]')")
    answers=fixture()['requests'][-1]['body']['answers']
    check('Question options and free text reach the typed answers contract', answers=={'lane':'Local proof','notes':'Keep the evidence files.'})
    fixture({'requests':[{'id':'multi-1','kind':'question','title':'Pick evidence','questions':[{'id':'deliverables','question':'Which artifacts?','multiSelect':True,'options':[{'label':'Screenshots'},{'label':'Logs'}]}]}]})
    wait("document.querySelector('[data-request=\"multi-1\"]')")
    scroll_to('[data-request=\"multi-1\"]');act('Screenshots');act('Logs')
    scroll_to('[data-request=\"multi-1\"] button');act('Send answers')
    wait("!document.querySelector('[data-request=\"multi-1\"]')")
    check('Multiselect answers preserve the typed array',fixture()['requests'][-1]['body']['answers']['deliverables']==['Screenshots','Logs'])
    fixture({'state':'running'})
    act('Message the root','fill','Interrupt this turn and inspect the result')
    act('Interrupt & send')
    wait("document.querySelector('#confirm-dialog').open")
    act('Interrupt & send')
    wait("!document.querySelector('#confirm-dialog').open")
    check('Interrupt-and-send is explicit and atomic', fixture()['requests'][-1]['body'].get('interrupt') is True)
    act('Interrupt')
    wait("document.querySelector('#session-state').textContent==='interrupted'")
    check('Interruption explains pending team mail', evaluate("!document.querySelector('#pause-notice').hidden && document.querySelector('#pause-notice').textContent.includes('stay pending')"))
    act('Resume')
    wait("document.querySelector('#session-state').textContent==='idle'")
    check('Interrupt and resume use revision-bound actions', fixture()['requests'][-1]['body']['action']=='resume' and isinstance(fixture()['requests'][-1]['body']['revision'],int))
    scroll_to('[data-node="checker"]');act('delivery-checker, Needs attention')
    wait("document.querySelector('#inspect-head').textContent.includes('delivery-checker')")
    browser.call('Page.reload')
    wait("document.querySelector('#inspect-head').textContent.includes('delivery-checker')")
    check('Selected team member survives reload')
    scroll_to('[data-tab="result"]');act('Result')
    wait("document.querySelector('#details').textContent.includes('submission-1')")
    check('Selected member exposes accepted submission evidence', 'accepted' in evaluate("document.querySelector('#details').textContent"))
    browser.call('Page.reload')
    wait("document.querySelector('#details').textContent.includes('submission-1')")
    check('Selected inspector view survives reload')
    scroll_to('[data-tab=\"messages\"]');act('Mail');wait("document.querySelector('#details').textContent.includes('does not consume')")
    act('Message the root','fill','Keyboard delivery proof')
    browser.call('Input.dispatchKeyEvent',type='keyDown',key='Enter',code='Enter',modifiers=4)
    browser.call('Input.dispatchKeyEvent',type='keyUp',key='Enter',code='Enter',modifiers=4)
    wait("document.querySelector('#conversation').textContent.includes('Keyboard delivery proof')")
    check('Command-Enter sends from the focused composer', fixture()['requests'][-1]['body'].get('text')=='Keyboard delivery proof')
    check('Unmanaged member remains read-only', all('/children/checker/' not in r['path'] for r in fixture()['requests']))
    scroll_to('#new-session');act('＋ New session')
    wait("document.querySelector('#launch-dialog').open")
    act('What should the crew accomplish?','fill','Build a synthetic daily workbench.')
    act('Project directory','fill','/fixture/new-project')
    act('Root role → Advisor','select')
    act('Host → Claude Code','select')
    act('Model & advanced options')
    wait("!document.querySelector('#launch-access option[value=workspace]')")
    check('Claude launch hides unsupported workspace access')
    scroll_to('#launch-title-input');act('Session name optional','fill','Claude queue verification')
    scroll_to('#launch-submit');act('Launch session')
    wait("document.querySelector('#conversation-title').textContent==='Claude queue verification'")
    created=fixture()['requests'][-1]['body']
    check('Launch carries project, role, host, access, title and prompt', created['cwd']=='/fixture/new-project' and created['mode']=='advisor' and created['host']=='claude' and created['access']=='default' and created['prompt']=='Build a synthetic daily workbench.')
    act('Message the root','fill','Wait until the current turn ends')
    act('Queue message')
    wait("document.querySelector('#outbox').textContent.includes('Queued')")
    check('Claude queue is visible, never labeled delivered', 'waiting for the current turn' in evaluate("document.querySelector('#outbox').textContent"))
    screenshot('console-queued.png')
    act('Close');wait("document.querySelector('#confirm-dialog').open");act('Keep session')
    check('Cancel close does not send an action', fixture()['requests'][-1]['body'].get('action') is None)
    act('Close');act('Close session');wait("document.querySelector('#session-state').textContent==='closed'")
    check('Closed session retains history and disables sending', evaluate("document.querySelector('#send').disabled && document.querySelectorAll('#conversation [data-event]').length>=2"))
    wait("document.querySelector('#outbox').textContent.includes('Canceled: session closed')")
    check('Closed queue is canceled without a retry/send control',evaluate("!document.querySelector('#outbox [data-retry]')"))
    # Mobile checks include the actual layout, native keyboard dialogs and dense team output.
    browser.call('Emulation.setDeviceMetricsOverride',width=390,height=844,deviceScaleFactor=1,mobile=True)
    wait("innerWidth===390")
    check('Mobile layout has no horizontal overflow', evaluate("document.documentElement.scrollWidth<=innerWidth"))
    screenshot('console-mobile.png')
    browser.call('Emulation.setDeviceMetricsOverride',width=1440,height=1000,deviceScaleFactor=1,mobile=False)
    scroll_to('#new-session');act('＋ New session')
    act('What should the crew accomplish?','fill','Recover an uncertain CoS launch.')
    act('Project directory','fill','/fixture/crew')
    if evaluate("document.querySelector('#launch-host').value")!='codex':act('Host → Codex','select')
    act('Reasoning effort → high','select')
    fixture({'fail':'server'})
    scroll_to('#launch-submit');act('Launch session')
    wait("document.querySelector('#launch-submit').textContent==='Check launch'")
    launch_id=fixture()['requests'][-1]['body']['requestId']
    check('Uncertain launch freezes its exact payload', evaluate("document.querySelector('#launch-prompt').disabled && document.querySelector('#launch-cwd').disabled"))
    browser.call('Page.reload')
    wait("document.querySelector('#launch-submit').textContent==='Check launch'")
    scroll_to('#new-session');act('＋ New session')
    check('Uncertain launch payload survives reload',evaluate("document.querySelector('#launch-prompt').value==='Recover an uncertain CoS launch.' && document.querySelector('#launch-effort').value==='high'"))
    scroll_to('#launch-submit');act('Check launch')
    wait("!document.querySelector('#launch-dialog').open")
    check('Launch recovery reuses the ID and CoS role',fixture()['requests'][-1]['body']['requestId']==launch_id and fixture()['requests'][-1]['body']['mode']=='cos' and fixture()['requests'][-1]['body']['effort']=='high')
    act('Close');wait("document.querySelector('#confirm-dialog').open")
    check('Close confirmation names root and Crew team',evaluate("document.querySelector('#confirm-copy').textContent.includes('root and its Crew team')"))
    fixture({'fail':'rejected'});act('Close session')
    wait("document.querySelector('#outbox').textContent.includes('Synthetic rejection')")
    check('Close rejection remains visible without claiming closure',evaluate("document.querySelector('#session-state').textContent!=='closed'"))
    fixture({'observer':True})
    browser.call('Page.navigate',url=url+'/?run=external-root')
    wait("document.querySelector('#capability-note').textContent.includes('Observer-only')")
    check('Bootstrap 404 keeps an honest observer-only app', evaluate("document.querySelector('#new-session').disabled && document.querySelector('#composer').hidden"))
    fixture({'observer':False})
    act('Reconnect');wait("!document.querySelector('#new-session').disabled")
    check('Reconnect restores console capability')
    check('All mutation requests use same-origin capability', all(r['token'] and r['origin']==url for r in fixture()['requests']))
    browser.call('Emulation.setEmulatedMedia', features=[{'name':'prefers-color-scheme','value':'dark'}])
    screenshot('console-desktop-dark.png')
finally:
    try:
        final_requests=fixture()['requests']
    except Exception:
        final_requests=[]
    try:
        browser.close()
    finally:
        if owned_server:
            owned_server.terminate()
            try:
                owned_server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                owned_server.kill();owned_server.wait(timeout=5)
        (out/'browser-checks.json').write_text(json.dumps({'checks':checks,'requests':final_requests},indent=2))
