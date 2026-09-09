'use strict';
const markdown=window.markdownit({html:false,linkify:false});
let copyCounter=0;
markdown.validateLink=link=>/^(https?:|mailto:|#)/i.test(link);
markdown.renderer.rules.image=(tokens,index)=>markdown.utils.escapeHtml(tokens[index].content);
function renderAssistant(body,text) {
  body.dataset.source=text;
  body.className='chat-bubble break-words [&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-base-300 [&_blockquote]:pl-3 [&_h1]:text-lg [&_h2]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h1]:my-3 [&_h2]:my-3 [&_h3]:my-3 [&_a]:text-primary [&_a]:underline [&_table]:text-sm [&_td]:border [&_th]:border [&_td]:border-base-300 [&_th]:border-base-300 [&_td]:p-2 [&_th]:p-2 [&_code]:font-mono [&_code]:text-xs';
  body.innerHTML=markdown.render(text);
  for(const pre of body.querySelectorAll('pre')) {
    const code=pre.querySelector('code');
    const card=document.createElement('div');card.className='card card-border bg-base-200 my-3 overflow-hidden min-w-0';
    const header=document.createElement('div');header.className='flex items-center justify-between gap-2 px-3 py-1 border-b border-base-300 text-xs';
    const language=document.createElement('span');language.textContent=code.className.replace(/^language-/,'') || 'Code';
    const copy=document.createElement('button');copy.className='btn btn-xs btn-ghost';copy.type='button';copy.dataset.copyCode='';copy.textContent='Copy';copy.setAttribute('aria-label','Copy code');
    copy.onclick=()=>{copy.dataset.copyId=String(++copyCounter);api.postMessage({type:'copy',id:copyCounter,text:code.textContent});};
    header.append(language,copy);pre.before(card);card.append(header,pre);pre.className='overflow-x-auto p-3 whitespace-pre text-xs';
  }
}
function toolMessage(data) {
  const labels={editor_documents:'List open files',editor_read:'Read file',editor_diagnostics:'Check diagnostics',editor_definition:'Find definition',editor_references:'Find references',editor_propose_edit:'Prepare edit',editor_apply_edit:'Apply edit'};
  const details=document.createElement('details');details.className='my-2 rounded-lg border border-base-300 text-xs';
  details.dataset.tool=data.tool || '';
  const summary=document.createElement('summary');summary.className='cursor-pointer px-3 py-2';summary.textContent=`${labels[data.tool] || data.tool || 'Tool'} · ${data.outcome || (data.success===false?'failed':'completed')}`;
  const result=document.createElement('pre');result.className='max-h-48 overflow-auto whitespace-pre-wrap break-words p-3 border-t border-base-300';result.textContent=data.detail || data.text;
  details.append(summary,result);messages.append(details);document.getElementById('welcome').classList.add('hidden');
}
