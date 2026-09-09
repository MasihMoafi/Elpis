const assert=require('node:assert/strict');const {spawn}=require('node:child_process');const fs=require('node:fs/promises');
const {message}=require('./runtime-eval');
module.exports=async({root,home,provider,sentinel,eventually,evidence,data})=>{
 const executable=process.env.ELPIS_IDE_TEST_CLI;if(!executable)return;
 await fs.appendFile(require('node:path').join(home,'config.toml'),`\n[projects.${JSON.stringify(root.fsPath)}]\ntrust_level = "trusted"\n`);
 const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
 for(const enabled of [true,false]){
  let output='',dismissedHooks=false;const child=spawn('script',['-q','-e','-c',`stty rows 40 cols 100; exec ${quote(executable)} --no-alt-screen -m gpt-5.6-luna -c 'check_for_update_on_startup=false'`,'/dev/null'],{cwd:root.fsPath,detached:true,env:{...process.env,CODEX_HOME:home,ELPIS_HOME:home,TERM:'xterm-256color'}});
  child.stdout.on('data',chunk=>{const text=chunk.toString();output+=text;if(text.includes('\x1b[6n'))child.stdin.write('\x1b[1;1R');if(text.includes('\x1b]10;?'))child.stdin.write('\x1b]10;rgb:0000/0000/0000\x1b\\');if(text.includes('\x1b]11;?'))child.stdin.write('\x1b]11;rgb:ffff/ffff/ffff\x1b\\');if(!dismissedHooks&&output.includes('Hooks need review')){dismissedHooks=true;child.stdin.write('\x1b[B\x1b[B\r');}});child.stderr.on('data',chunk=>output+=chunk.toString());
  const plain=()=>output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'');
  const submit=async text=>{child.stdin.write('\x1b[200~'+text+'\x1b[201~');await new Promise(resolve=>setTimeout(resolve,100));child.stdin.write('\r');};
  try{
   await eventually(async()=>/model:\s+gpt-5\.6-luna/.test(plain()),'actual CLI startup');
   await submit(`/ide ${enabled?'on':'off'}`);
   await eventually(async()=>plain().includes(`IDE context is ${enabled?'on':'off'}.`),'actual CLI /ide acknowledgement');
   let seen=false;provider.actions.push(request=>{assert.equal(JSON.stringify(request.input).includes(sentinel),enabled);seen=true;return message('CLI_IDE_CONTEXT_CONFIRMED');});
   await submit('Report whether editor context is available.');
   await eventually(async()=>seen,'actual CLI provider request with context control');
   await eventually(async()=>plain().includes('CLI_IDE_CONTEXT_CONFIRMED'),'actual CLI response');
  }finally{try{process.kill(-child.pid,'SIGTERM');}catch{}await fs.writeFile(require('node:path').join(data,`cli-ide-${enabled?'on':'off'}.log`),output);}
 }
 evidence.results.push({name:'Actual Elpis CLI /ide on sends unsaved IDE-only sentinel to provider; fresh /ide off does not',passed:true});
};
