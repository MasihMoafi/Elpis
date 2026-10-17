'use strict';
// Real TUI in an isolated tmux terminal. OSC10/11 replies come from pane colors;
// changing those colors simulates a terminal theme change without touching GNOME.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {Provider,message}=require('./lib/mock-provider.js');
const binary=process.argv[2];assert(binary&&path.isAbsolute(binary),'absolute Elpis binary required');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'elpis-terminal-theme-')),home=path.join(root,'home'),cwd=path.join(root,'workspace'),socket=path.join(root,'tmux.sock');fs.mkdirSync(home);fs.mkdirSync(cwd);
const provider=new Provider(),pause=ms=>new Promise(r=>setTimeout(r,ms));let server,log='';
const tm=(...args)=>execFileSync('tmux',['-S',socket,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const type=text=>tm('send-keys','-t','test','-l',text),key=name=>tm('send-keys','-t','test',name);
const capture=(ansi=false)=>tm('capture-pane','-p',...(ansi?['-e']:[]),'-t','test');
async function until(predicate,label){let text='';for(let i=0;i<150;i++){text=capture();if(predicate(text))return text;await pause(100);}fs.writeFileSync(path.join(root,label+'.txt'),text);throw Error('Timed out '+label+'; '+root);}
function shot(label){const text=capture(),ansi=capture(true);fs.writeFileSync(path.join(root,label+'.txt'),text);fs.writeFileSync(path.join(root,label+'.ansi'),ansi);return ansi;}
function rgbIndex(n){if(n>=232)return Array(3).fill(8+(n-232)*10);if(n>=16){n-=16;const level=[0,95,135,175,215,255];return[level[Math.floor(n/36)],level[Math.floor(n/6)%6],level[n%6]];}return null;}
function styleAt(ansi,marker,defaultFg,defaultBg){let fg=defaultFg,bg=defaultBg;for(const chunk of ansi.split(/(\x1b\[[0-9;]*m)/)){if(chunk.startsWith('\x1b[')){const codes=chunk.slice(2,-1).split(';').map(Number);for(let i=0;i<codes.length;i++){const c=codes[i];if(c===0){fg=defaultFg;bg=defaultBg;}if(c===39)fg=defaultFg;if(c===49)bg=defaultBg;if((c===38||c===48)&&codes[i+1]===2){const rgb=codes.slice(i+2,i+5);if(c===38)fg=rgb;else bg=rgb;i+=4;}else if((c===38||c===48)&&codes[i+1]===5){const rgb=rgbIndex(codes[i+2]);if(c===38)fg=rgb;else bg=rgb;i+=2;}}}else if(chunk.includes(marker))return{fg,bg};}throw Error('No marker '+marker);}
function contrast({fg,bg}){assert(fg&&bg);const lum=rgb=>rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);const a=lum(fg),b=lum(bg);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
(async()=>{try{
 await provider.start();const catalog=require('../codex-rs/models-manager/models.json');fs.writeFileSync(path.join(home,'models.json'),JSON.stringify({models:catalog.models.filter(m=>m.slug==='gpt-5.5')}));
 fs.writeFileSync(path.join(home,'config.toml'),`model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home,'models.json'))}\napproval_policy="on-request"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\n[model_providers.fixture]\nname="Theme fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[tui]\nanimations=false\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
 const env={...process.env,HOME:home,CODEX_HOME:home,CODEX_AUTH_HOME:home,ELPIS_HOME:home,ELPIS_SHARED_BRIDGE:'',ELPIS_BRIDGE_SOCKET:'',TERM:'xterm-256color',COLORTERM:'truecolor'};
 server=spawn(binary,['app-server','--listen','ws://127.0.0.1:0'],{cwd,env,stdio:['ignore','pipe','pipe']});for(const stream of[server.stdout,server.stderr])stream.on('data',b=>{log+=b;fs.appendFileSync(path.join(root,'server.log'),b);});
 for(let i=0;i<100&&!/ws:\/\/127\.0\.0\.1:\d+/.test(log);i++)await pause(100);const address=log.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];assert(address,'server address');
 tm('new-session','-d','-s','test','-x','110','-y','45','bash --noprofile --norc');tm('set-option','-p','-t','test','window-style','fg=#111111,bg=#ffffff');
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";const cmd=['env','-u','NO_COLOR',...Object.entries(env).filter(([k])=>['HOME','CODEX_HOME','CODEX_AUTH_HOME','ELPIS_HOME','ELPIS_SHARED_BRIDGE','ELPIS_BRIDGE_SOCKET','TERM','COLORTERM'].includes(k)).map(([k,v])=>k+'='+v),binary,'--remote',address,'-C',cwd].map(quote).join(' ');await pause(200);type(cmd);key('Enter');
 await until(s=>{if(s.includes('Hooks need review'))key('Escape');return s.includes('Elpis')&&/gpt-5[.]5/i.test(s);},'startup');
 provider.actions.push(message('THEME_REPLY'));type('THEME_HISTORY');await pause(200);key('Enter');await until(s=>s.includes('THEME_REPLY')&&!s.includes('esc to interrupt'),'reply');
 type('THEME_DRAFT');await until(s=>s.includes('THEME_DRAFT'),'draft');const light=styleAt(shot('light'),'THEME_DRAFT',[17,17,17],[255,255,255]);
 tm('set-option','-p','-t','test','window-style','fg=#eeeeee,bg=#111111');type('\x1b[O');await pause(100);type('\x1b[I');await pause(800);
 const darkAnsi=shot('dark'),dark=styleAt(darkAnsi,'THEME_DRAFT',[238,238,238],[17,17,17]),history=styleAt(darkAnsi,'THEME_HISTORY',[238,238,238],[17,17,17]);
 key('C-u');provider.actions.push({hang:true});type('Keep this local fixture busy.');await pause(200);key('Enter');await until(s=>s.includes('esc to interrupt'),'busy');type('/theme');await pause(200);key('Enter');await pause(600);const picker=shot('busy-theme').includes('Select Syntax Theme');
 const checks={root,binary,light:{...light,contrast:contrast(light)},dark:{...dark,contrast:contrast(dark)},history:{...history,contrast:contrast(history)},busyThemePicker:picker,providerRequests:provider.requests.length};fs.writeFileSync(path.join(root,'checks.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify(checks));
 assert(contrast(light)>=4.5,'light composer readable');assert(contrast(dark)>=4.5,'dark composer readable after live switch');assert(contrast(history)>=4.5,'retained prompt repaints after live switch');assert(picker,'/theme must open during active turn');assert.equal(provider.requests.length,2,'theme does not invoke model');
 }finally{try{tm('kill-server');}catch{}provider.close();if(server&&server.exitCode===null){server.kill('SIGTERM');const stop=setTimeout(()=>server.kill('SIGKILL'),3000);stop.unref();await new Promise(resolve=>server.once('exit',resolve));clearTimeout(stop);}}})().catch(e=>{console.error(e);process.exitCode=1;});
