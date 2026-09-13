'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const syncFs=require('node:fs');
const path=require('node:path');
const execFile=require('node:util').promisify(require('node:child_process').execFile);

module.exports=function sharedCli({executable,root,home,socket,threadId}) {
  const configPath=path.join(home,'config.toml');
  const project=`[projects.${JSON.stringify(root)}]`;
  if(!syncFs.readFileSync(configPath,'utf8').includes(project))syncFs.appendFileSync(configPath,`\n${project}\ntrust_level="trusted"\n`);
  const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
  const connection=process.env.ELPIS_EDITOR_TEST_AUTO_SHARED==='1'?[]:['--remote',`unix://${socket}`];
  const command=[executable,'--no-alt-screen',...connection,...(threadId?['--resume',threadId]:[])].map(quote).join(' ');
  const child=spawn('script',['-q','-e','-c',`stty rows 40 cols 110; exec ${command}`,'/dev/null'],{
    cwd:root,detached:true,env:{...process.env,CODEX_HOME:home,ELPIS_HOME:home,TERM:'xterm-256color'},
  });
  let output='',exited=false,dismissedHooks=false;
  child.once('exit',()=>{exited=true;});
  child.stdout.on('data',chunk=>{
    const text=chunk.toString();output+=text;
    if(text.includes('\x1b[6n'))child.stdin.write('\x1b[1;1R');
    if(text.includes('\x1b]10;?'))child.stdin.write('\x1b]10;rgb:ffff/ffff/ffff\x1b\\');
    if(text.includes('\x1b]11;?'))child.stdin.write('\x1b]11;rgb:0000/0000/0000\x1b\\');
    if(!dismissedHooks&&output.includes('Hooks need review')){dismissedHooks=true;child.stdin.write('\x1b[B\x1b[B\r');}
  });
  child.stderr.on('data',chunk=>output+=chunk.toString());
  child.stdin.on('error',()=>{});
  return {
    text:()=>output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,''),
    async send(text){child.stdin.write('\x1b[200~'+text+'\x1b[201~');await new Promise(resolve=>setTimeout(resolve,100));child.stdin.write('\r');},
    async dispose(){
      let parents=[child.pid];
      for(let depth=0;depth<2;depth++){
        const children=[];
        for(const pid of parents){
          try{children.push(...(await execFile('pgrep',['-P',String(pid)])).stdout.trim().split('\n').filter(Boolean).map(Number));}catch{}
        }
        for(const pid of children){
          try{
            const command=await fs.readFile(`/proc/${pid}/cmdline`,'utf8');
            const env=await fs.readFile(`/proc/${pid}/environ`,'utf8');
            if(command.split('\0').includes('--serve-local')&&env.split('\0').includes(`ELPIS_HOME=${home}`))process.kill(pid,'SIGTERM');
          }catch{}
        }
        parents=children;
      }
      if(!exited)try{process.kill(-child.pid,'SIGTERM');}catch{}
      if(process.env.ELPIS_SHARED_CLI_LOG)await fs.writeFile(process.env.ELPIS_SHARED_CLI_LOG,output);
    },
  };
};
