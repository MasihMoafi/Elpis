'use strict';
// Real TUI in an isolated tmux terminal. Raw SGR wheel events go through the terminal input path.
// Slow notches move about three rows each; a fast burst builds momentum, as in Claude Code.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {Provider,message}=require('./lib/mock-provider.js');
const binary=process.argv[2];assert(binary&&path.isAbsolute(binary),'absolute Elpis binary required');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'elpis-terminal-wheel-')),home=path.join(root,'home'),cwd=path.join(root,'workspace'),socket=path.join(root,'tmux.sock');fs.mkdirSync(home);fs.mkdirSync(cwd);
const provider=new Provider(),pause=ms=>new Promise(r=>setTimeout(r,ms));let server,log='';
const tm=(...args)=>execFileSync('tmux',['-S',socket,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const type=text=>tm('send-keys','-t','test','-l',text),key=name=>tm('send-keys','-t','test',name);
const capture=(ansi=false)=>tm('capture-pane','-p',...(ansi?['-e']:[]),'-t','test');
async function until(predicate,label){let text='';for(let i=0;i<150;i++){text=capture();if(predicate(text))return text;await pause(100);}fs.writeFileSync(path.join(root,label+'.txt'),text);throw Error('Timed out '+label+'; '+root);}
function shot(label){const text=capture();fs.writeFileSync(path.join(root,label+'.txt'),text);return text;}
const top=s=>Math.min(...[...s.matchAll(/WHEEL_LINE_(\d{3})/g)].map(m=>Number(m[1])));
const wheelUp=count=>type('\x1b[<64;30;12M'.repeat(count));
(async()=>{try{
 await provider.start();const catalog=require('../codex-rs/models-manager/models.json');fs.writeFileSync(path.join(home,'models.json'),JSON.stringify({models:catalog.models.filter(m=>m.slug==='gpt-5.5')}));
 fs.writeFileSync(path.join(home,'config.toml'),`model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home,'models.json'))}\napproval_policy="on-request"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\n[model_providers.fixture]\nname="Wheel fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[tui]\nanimations=false\nfullscreen_transcript=true\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
 const env={...process.env,HOME:home,CODEX_HOME:home,CODEX_AUTH_HOME:home,ELPIS_HOME:home,ELPIS_SHARED_BRIDGE:'',ELPIS_BRIDGE_SOCKET:'',TERM:'xterm-256color',COLORTERM:'truecolor'};
 server=spawn(binary,['app-server','--listen','ws://127.0.0.1:0'],{cwd,env,stdio:['ignore','pipe','pipe']});for(const stream of[server.stdout,server.stderr])stream.on('data',b=>{log+=b;fs.appendFileSync(path.join(root,'server.log'),b);});
 for(let i=0;i<100&&!/ws:\/\/127\.0\.0\.1:\d+/.test(log);i++)await pause(100);const address=log.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];assert(address,'server address');
 tm('new-session','-d','-s','test','-x','110','-y','45','bash --noprofile --norc');
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";const cmd=['env','-u','NO_COLOR',...Object.entries(env).filter(([k])=>['HOME','CODEX_HOME','CODEX_AUTH_HOME','ELPIS_HOME','ELPIS_SHARED_BRIDGE','ELPIS_BRIDGE_SOCKET','TERM','COLORTERM'].includes(k)).map(([k,v])=>k+'='+v),binary,'--remote',address,'-C',cwd].map(quote).join(' ');await pause(200);type(cmd);key('Enter');
 await until(s=>{if(s.includes('Hooks need review'))key('Escape');return s.includes('Elpis')&&/gpt-5[.]5/i.test(s);},'startup');
 const lines=Array.from({length:300},(_,i)=>'WHEEL_LINE_'+String(i+1).padStart(3,'0'));
 provider.actions.push(message('```\n'+lines.join('\n')+'\n```'));type('Print the wheel fixture.');await pause(200);key('Enter');
 await until(s=>s.includes('WHEEL_LINE_300')&&!s.includes('esc to interrupt'),'reply');await pause(400);
 const start=top(capture());wheelUp(6);await pause(3000);const afterBurst=top(capture());
 for(let i=0;i<3;i++){wheelUp(1);await pause(3000);}await pause(400);const afterSlow=top(capture());shot('after');
 const bar=capture().split('\n').slice(0,12).map(line=>[...line.padEnd(110)].at(-1)).join('');
 type('\x1b[<0;110;1M\x1b[<0;110;1m');await pause(700);const jumped=shot('scrollbar-top');
 const trackRows=jumped.split('\n').map((line,index)=>({index,cell:[...line][109]})).filter(({cell})=>cell==='│'||cell==='┃').map(({index})=>index);
 assert(trackRows.length>2,'visible scrollbar track');const middleRow=trackRows[Math.floor((trackRows.length-1)/2)]+1;
 type(`\x1b[<0;110;${middleRow}M\x1b[<0;110;${middleRow}m`);await pause(700);const middle=shot('scrollbar-middle');
 const thumbRow=middle.split('\n').findIndex(line=>[...line][109]==='┃')+1;
 assert(thumbRow>0,'visible scrollbar thumb for dragging');const bottomRow=trackRows.at(-1)+1;
 type(`\x1b[<0;110;${thumbRow}M`);await pause(100);type(`\x1b[<32;110;${bottomRow}M`);await pause(500);
 const dragBottom=top(shot('scrollbar-held-drag'));
 type(`\x1b[<0;110;${bottomRow}m`);await pause(100);type(`\x1b[<35;110;${trackRows[0]+1}M`);await pause(500);
 const afterRelease=top(shot('scrollbar-released-move'));
 const checks={root,binary,flags:tm('display','-p','-t','test','alt=#{alternate_on} any=#{mouse_any_flag} sgr=#{mouse_sgr_flag} std=#{mouse_standard_flag} btn=#{mouse_button_flag}').trim(),start,afterBurst,afterSlow,burstRows:start-afterBurst,slowRows:afterBurst-afterSlow,scrollbar:bar,dragBottom,afterRelease,scrollbarTopShowsPrompt:jumped.includes('Print the wheel fixture.')&&!jumped.includes('WHEEL_LINE_300')};fs.writeFileSync(path.join(root,'checks.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify(checks));
 assert(checks.slowRows>=9&&checks.slowRows<=10,'slow notches move about three rows each');assert(checks.burstRows>=40,'a fast burst of six notches builds momentum');
 assert(/^[│┃]+$/.test(bar)&&bar.includes('┃'),'long reply shows a scrollbar in the last column');assert(checks.scrollbarTopShowsPrompt,'clicking the scrollbar top jumps to the start');
 const middleLine=Number((middle.match(/WHEEL_LINE_(\d+)/)||[])[1]);
 assert(middleLine>80&&middleLine<240,`clicking midway through one long answer reaches its middle (got ${middleLine})`);
 assert(dragBottom>middleLine+60,`holding and dragging the thumb reaches lower content (got ${dragBottom})`);
 assert.equal(afterRelease,dragBottom,'moving after releasing the thumb does not scroll');
 }finally{try{tm('kill-server');}catch{}provider.close();if(server&&server.exitCode===null){server.kill('SIGTERM');const stop=setTimeout(()=>server.kill('SIGKILL'),3000);stop.unref();await new Promise(resolve=>server.once('exit',resolve));clearTimeout(stop);}}})().catch(e=>{console.error(e);process.exitCode=1;});
