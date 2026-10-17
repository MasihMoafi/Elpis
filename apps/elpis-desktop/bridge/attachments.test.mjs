import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { attachmentInput, extractPdf, recordedMedia } from './attachments.mjs';
const root = process.env.ELPIS_MEDIA_BASELINE;
const { DesktopClient } = await import(root ? pathToFileURL(path.join(root, 'bridge/client.mjs')) : './client.mjs');
const { startDesktopServer } = await import(root ? pathToFileURL(path.join(root, 'bridge/server.mjs')) : './server.mjs');
const ID = '00000000-0000-0000-0000-000000000001';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const image = () => ({ id: 'image_1', name: 'image.png', type: 'image', mimeType: 'image/png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` });
function fixture({ content, item, continueAs = false } = {}) {
  const socket = new EventEmitter(); socket.sent = [];
  socket.close = () => socket.emit('close');
  socket.send = raw => {
    const row = JSON.parse(raw); socket.sent.push(row); if (!row.id) return;
    const thread = { id: ID, source: 'cli', modelProvider: 'openai', status: { type: 'idle' }, canAcceptDirectInput: !continueAs };
    const result = row.method === 'initialize' ? {} : row.method === 'thread/read' || row.method === 'thread/resume' ? { thread }
      : row.method === 'thread/items/list' ? { data: [{ turnId: 'turn', item: item ?? { id: 'user', type: 'userMessage', content } }], nextCursor: null }
      : row.method === 'turn/start' || row.method === 'turn/steer' ? { turn: { id: 'turn', status: 'inProgress' } } : {};
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: row.id, result })));
  };
  return { socket, client: new DesktopClient(socket) };
}
test('attachments retain ordinary text, UTF8 file ranges and image-only native input', () => {
  const files = [{ id: 'text_1', name: 'فارسی.txt', type: 'text', mimeType: 'text/plain', text: 'متن کامل' }, image()];
  const input = attachmentInput('read these', files);
  assert.equal(input[0].text, 'read these'); assert.equal(input[1].text, 'File: فارسی.txt\nمتن کامل');
  assert.equal(input[1].text_elements[0].byteRange.end, Buffer.byteLength(input[1].text));
  assert.equal(input[2].url, image().dataUrl);
  assert.deepEqual(attachmentInput('', [image()]), [{ type: 'image', url: image().dataUrl }]);
});
test('bad batches cannot produce partial native input', () => {
  for (const files of [[image(), image()], [{ ...image(), dataUrl: 'https://evil.example/image.png' }], [{ ...image(), mimeType: 'image/svg+xml' }], [{ ...image(), dataUrl: 'data:image/png;base64,aGVsbG8=' }], Array.from({length:4}, (_,i)=>({...image(),id:String(i)})), [{id:'text',name:'x',type:'text',mimeType:'text/plain',text:'x'.repeat(128*1024+1)}]]) {
    assert.throws(() => attachmentInput('keep draft', files));
  }
  assert.throws(() => attachmentInput(''));
});
test('send and steer deliver validated attachments, and rejection never mutates native state', async t => {
  const { socket, client } = fixture(); t.after(() => client.close()); await client.initialize();
  await client.send(ID, { text: '', attachments: [image()] });
  assert.deepEqual(socket.sent.findLast(r => r.method === 'turn/start').params.input, [{ type:'image',url:image().dataUrl }]);
  await client.steer(ID, { text: 'look', expectedTurnId: 'turn', attachments: [image()] });
  assert.equal(socket.sent.findLast(r => r.method === 'turn/steer').params.input[1].type, 'image');
  socket.sent.length = 0;
  await assert.rejects(client.send(ID, { text:'draft',attachments:[{...image(),dataUrl:'data:image/png;base64,aGVsbG8='}] }));
  assert.equal(socket.sent.length, 0);
});
test('owned recorded media preview validates exact thread/turn/item/input and refuses nonmedia', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-media-test-')); const file = path.join(dir,'image.png'); await fs.writeFile(file, PNG);
  const {client} = fixture({content:[{type:'localImage',path:file},{type:'text',text:file}]}); t.after(()=>client.close()); await client.initialize();
  assert.deepEqual((await client.media(ID,'turn','user',0)).bytes, PNG);
  await assert.rejects(client.media(ID,'turn','user',1)); await assert.rejects(client.media(ID,'turn','other',0));
  const link=path.join(dir,'link.png');await fs.symlink(file,link);await assert.rejects(recordedMedia({type:'localImage',path:link}));
});
test('an image the agent viewed is served as its item\'s one picture, and only that', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-media-test-')); const file = path.join(dir,'seen.png'); await fs.writeFile(file, PNG);
  const {client} = fixture({item:{id:'user',type:'imageView',path:file}}); t.after(()=>client.close()); await client.initialize();
  assert.deepEqual((await client.media(ID,'turn','user',0)).bytes, PNG);
  await assert.rejects(client.media(ID,'turn','user',1));
});
test('HTTP attachment body limit is separate from ordinary settings and media requires application session', async t => {
  const { client, socket }=fixture();await client.initialize();const app=await startDesktopServer({client});t.after(()=>app.close());
  const url=new URL(app.url),origin=url.origin,token=new URLSearchParams(url.hash.slice(1)).get('token');
  const post=(route,body,cookie)=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  const auth=await post('/api/session',{token});const cookie=auth.headers.get('set-cookie').split(';')[0];
  const attachment={id:'text',name:'notes.txt',type:'text',mimeType:'text/plain',text:'full source '.repeat(8000)};
  assert.equal((await post(`/api/threads/${ID}/turns`,{text:'read',attachments:[attachment]},cookie)).status,200);
  assert(socket.sent.findLast(r=>r.method==='turn/start').params.input[1].text.includes(attachment.text));
  assert.equal((await post('/api/settings',{oversized:'x'.repeat(70000)},cookie)).status,413);
  assert.equal((await fetch(origin+`/api/threads/${ID}/turns/turn/items/user/media/0`)).status,401);
  const rejected=await post('/api/attachments/extract',{name:'fake.pdf',mimeType:'application/pdf',dataUrl:'data:application/pdf;base64,aGVsbG8='},cookie);
  assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/not a PDF/);
});
function tinyPdf() {
  const stream='BT /F1 12 Tf 72 720 Td (Recovery code violet-7309) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(pdf);
}
test('PDF conversion extracts actual bounded text and refuses failed conversion', async()=>{
 const request={name:'recovery.pdf',mimeType:'application/pdf',dataUrl:`data:application/pdf;base64,${tinyPdf().toString('base64')}`};
 const {attachment}=await extractPdf(request);assert.equal(attachment.type,'text');assert.match(attachment.text,/Recovery code violet-7309/);
 await assert.rejects(extractPdf(request,{command:'/bin/false'}),/Could not extract/);
 await assert.rejects(extractPdf(request,{command:'/nonexistent-pdftotext'}),/unavailable/);
});

test('maximum-size base64 images validate without overflowing and oversized images are refused', () => {
  const bytes = Buffer.alloc(4*1024*1024);PNG.copy(bytes);
  const large = {...image(),dataUrl:`data:image/png;base64,${bytes.toString('base64')}`};
  assert.equal(attachmentInput('',[large])[0].url,large.dataUrl);
  const over = {...large,dataUrl:`data:image/png;base64,${Buffer.concat([bytes,Buffer.from([0])]).toString('base64')}`};
  assert.throws(()=>attachmentInput('',[over]),/large/);
});
test('mentions become native mention items after the text, never count as content or files, and are validated', () => {
  const mentions = [{ name: 'src/app.ts', path: '/work/src/app.ts' }, { name: 'Other chat', path: 'thread://abc' }];
  const input = attachmentInput('look at @src/app.ts', [image()], mentions);
  assert.deepEqual(input.map(part => part.type), ['text', 'mention', 'mention', 'image']);
  assert.deepEqual(input[1], { type: 'mention', name: 'src/app.ts', path: '/work/src/app.ts' });
  assert.deepEqual(attachmentInput('hi', [], undefined), [{ type: 'text', text: 'hi', text_elements: [] }]);
  assert.throws(() => attachmentInput('', [], mentions), /Write a message/);
  for (const bad of ['x', [{ name: '', path: '/a' }], [{ name: 'a' }], [{ name: 'a', path: '/a', extra: 1 }], [{ name: 'a\n', path: '/a' }], [{ name: 'a', path: 'x'.repeat(4097) }], Array.from({ length: 11 }, () => mentions[0])]) {
    assert.throws(() => attachmentInput('hi', [], bad), /mention/i);
  }
});
test('send and steer carry mentions to the native input', async t => {
  const { socket, client } = fixture(); t.after(() => client.close()); await client.initialize();
  const mentions = [{ name: 'src/app.ts', path: '/work/src/app.ts' }];
  await client.send(ID, { text: 'see @src/app.ts', mentions });
  assert.deepEqual(socket.sent.findLast(r => r.method === 'turn/start').params.input.map(part => part.type), ['text', 'mention']);
  await client.steer(ID, { text: 'and this', expectedTurnId: 'turn', mentions });
  assert.deepEqual(socket.sent.findLast(r => r.method === 'turn/steer').params.input.at(-1), { type: 'mention', name: 'src/app.ts', path: '/work/src/app.ts' });
  socket.sent.length = 0;
  await assert.rejects(client.send(ID, { text: 'draft', mentions: [{ name: 'a' }] }), /mention/i);
  assert.equal(socket.sent.length, 0);
});
