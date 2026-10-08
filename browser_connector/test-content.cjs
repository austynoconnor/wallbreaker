// Mocked DOM transport checks; never opens a browser or contacts Muse.
const {JSDOM} = require('../wallbreaker/dashboard/web/node_modules/jsdom');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const test = require('node:test');
const script = fs.readFileSync(__dirname + '/extension/content.js', 'utf8');

function fixture({approval=false, draft='', failure=false}={}) {
  const dom = new JSDOM(`<div aria-label="Chat messages"><div data-message-role="assistant" data-message-id="old">Old reply<button aria-label="Copy response"></button></div></div><textarea aria-label="Message"></textarea><button aria-label="Send">Send</button>${approval?'<button>Review</button>':''}`, {url:'https://muse.ai/thread/test',runScripts:'outside-only'});
  const w = dom.window;
  let listener, loop, job = {id:'one',url:w.location.href,prompt:'Reply OK',timeout:180}, clicks=0, result;
  w.Element.prototype.getClientRects = () => [1];
  w.setInterval = fn => {if (!loop) loop=fn;return 1;};
  w.clearInterval = () => {};
  let now=10000;
  w.Date.now=()=>now;
  w.setTimeout = fn => {now+=600;Promise.resolve().then(fn);return 1;};
  w.chrome={runtime:{onMessage:{addListener:fn=>listener=fn},sendMessage:async message=>{
    if(message.type==='poll'){const answer=job;job=null;return {ok:true,data:{job:answer}};}
    if(message.type==='result'){result=message;return {ok:true,data:{accepted:true}};}
  }}};
  w.document.querySelector('textarea').value=draft;
  w.document.querySelector('[aria-label="Send"]').onclick=()=>{
    clicks++;
    if(failure) {w.document.body.insertAdjacentHTML('beforeend','<button>Review</button>');return;}
    w.document.querySelector('[aria-label="Chat messages"]').insertAdjacentHTML('beforeend','<div data-message-role="user" data-message-id="new-user">Reply OK</div><div data-message-role="assistant" data-message-id="new-reply">OK<button aria-label="Copy response">Copy response</button><div data-copy-exclude>Actions</div></div>');
  };
  w.eval(script);
  return {w,dom,run:()=>loop(),msg:m=>{let r;listener(m,{},v=>r=v);return r;},result:()=>result,clicks:()=>clicks};
}
test('approval and user drafts prevent connection and sending',async()=>{
  for(const options of [{approval:true},{draft:'My unsent text'}]){
    const f=fixture(options);
    assert.equal(f.msg({type:'preflight'}).ok,false);
    f.msg({type:'arm',pair:{url:f.w.location.href}});
    await f.run();
    assert.equal(f.clicks(),0);
    assert.ok(f.result().error);
    f.dom.window.close();
  }
});
test('only new assistant reply is returned, with one click',async()=>{
  const f=fixture();
  assert.equal(f.msg({type:'preflight'}).ok,true);
  f.msg({type:'arm',pair:{url:f.w.location.href}});
  await f.run();
  assert.equal(f.clicks(),1);
  assert.equal(f.result().text,'OK');
  await f.run();
  assert.equal(f.clicks(),1);
  f.dom.window.close();
});
test('approval after send surfaces error without clicking Review',async()=>{
  const f=fixture({failure:true});
  f.msg({type:'arm',pair:{url:f.w.location.href}});
  await f.run();
  assert.equal(f.clicks(),1);
  assert.match(f.result().error,/human approval/);
  f.dom.window.close();
});
test('disarm does not claim or send a prompt',async()=>{
  const f=fixture();
  f.msg({type:'arm',pair:{url:f.w.location.href}});
  f.msg({type:'disarm'});
  await f.run();
  assert.equal(f.clicks(),0);
  assert.equal(f.result(),undefined);
  f.dom.window.close();
});
