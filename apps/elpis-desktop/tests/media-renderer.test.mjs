import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url), root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const modules = new Map();
function load(file) {
 if (modules.has(file)) return modules.get(file).exports;
 const source=fs.readFileSync(file,'utf8'),module={exports:{}};
 modules.set(file, module);
 const result=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const stub=tag=>({children,...props})=>React.createElement(tag,props,children);
 const icon=()=>null,imports=id=>id==='@/components/elpis-icons'?new Proxy({},{get:()=>icon}):id==='@/components/ui/button'?{Button:stub('button')}:id==='@/components/ui/textarea'?{Textarea:stub('textarea')}:id==='@/components/markdown-text'?{CopyButton:()=>null,MarkdownText:({text})=>React.createElement('span',null,text)}:id==='@/lib/attachments'?load(path.join(root,'lib/attachments.ts')):id==='@/lib/api'?{taskFromPath:()=>'',title:()=>''}:local(id);
 function local(id) {
  if (id.endsWith('.css')) return {};
  if (!id.startsWith('@/') && !id.startsWith('.')) return require(id);
  const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(file),id);
  const target=['','.ts','.tsx','.js','.cjs'].map(ext=>base+ext).find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());
  if (!target) throw new Error(`Missing local source: ${id}`);
  return load(target);
 }
 vm.runInNewContext(result,{require:imports,module,exports:module.exports,TextEncoder,TextDecoder,URL,console});return module.exports;
}
const {ChatMessage}=load(path.join(root,'components/chat-message.tsx'));
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const render=content=>renderToStaticMarkup(React.createElement(ChatMessage,{item:{id:'input',type:'userMessage',content},mediaBase:'/api/threads/chat/turns/turn/items/input/media'}));
test('recorded image and audio use indexed owned media, bounded inline data and explicit playback',()=>{
 const html=render([{type:'text',text:'Look here'},{type:'localImage',path:'/private/image.png'},{type:'localAudio',path:'/private/audio.wav'},{type:'image',url:png}]);
 assert.match(html,/<img[^>]+src="\/api\/threads\/chat\/turns\/turn\/items\/input\/media\/1"/);
 assert.match(html,/<audio[^>]+preload="none"/);assert.match(html,/media\/2/);assert.doesNotMatch(html,/autoPlay|autoplay/);
 assert(html.includes(`src="${png}"`));assert.match(html,/Look here/);assert.doesNotMatch(html,/aria-label="Edit message"/);
});
test('remote and unsupported media never load automatically; file IDs stay descriptive',()=>{
 const html=render([{type:'image',url:'https://example.invalid/picture.png'},{type:'audio',url:'https://example.invalid/audio.mp3'},{type:'image',url:'data:image/svg+xml;base64,PHN2Zz4='},{type:'image',fileId:'private-provider-file-id'}]);
 assert.doesNotMatch(html,/<img|<audio|<iframe/);assert.match(html,/href="https:\/\/example.invalid\/picture.png"/);assert.doesNotMatch(html,/private-provider-file-id/);
});
test('file text uses a collapsed expandable attachment and keeps UTF8 contents exact',()=>{
 const text='File: فارسی.txt\nمتن کامل\n<not-html>',byteLength=new TextEncoder().encode(text).length;
 const html=render([{type:'text',text:'Read this'},{type:'text',text,text_elements:[{byteRange:{start:0,end:byteLength},placeholder:'Attachment: فارسی.txt'}]}]);
 assert.match(html,/<details[^>]*>/);assert.match(html,/<summary[^>]*>.*فارسی.txt/);assert.match(html,/متن کامل\n&lt;not-html&gt;/);assert.doesNotMatch(html,/<not-html>/);
 assert.doesNotMatch(html,/aria-label="Edit message"/);
});
test('ordinary text stays readable and malformed attachment markers never hide it',()=>{
 const html=render([{type:'text',text:'ordinary instructions',text_elements:[{byteRange:{start:0,end:2},placeholder:'Attachment: fake.txt'}]}]);
 assert.match(html,/ordinary instructions/);assert.doesNotMatch(html,/<details/);
});

const note=name=>body=>{const text=`File: ${name}\n${body}`,byteLength=new TextEncoder().encode(text).length;return {type:'text',text,text_elements:[{byteRange:{start:0,end:byteLength},placeholder:`Attachment: ${name}`}]};};
test('the note the browser panel attaches for the model is not shown: comments appear as the user wrote them, a drawing note not at all',()=>{
 const comments='# Browser comments:\n\n## User Comment 1\nBrowser\nUntrusted page evidence (from the page)\nComment:\nMake this the accent colour\n\n## User Comment 2\nBrowser\nComment:\nand wider\n\nThe attached image shows the page when each comment was made.';
 const html=render([note('Browser comments')(comments),note('Page drawing context')('The attached image "Page drawing.jpg" is a screenshot of the browser page'),{type:'image',url:png}]);
 assert.match(html,/<ol[^>]*aria-label="Browser comments"[^>]*><li[^>]*>Make this the accent colour<\/li><li[^>]*>and wider<\/li><\/ol>/);
 assert.doesNotMatch(html,/<details|<summary|# Browser comments|User Comment|Untrusted page evidence|Page drawing context|screenshot of the browser page|The attached image/);
});
