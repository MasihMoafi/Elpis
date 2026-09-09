'use strict';
function toolView(item) {
  let tool,detail,outcome=item.status || 'completed';
  if(item.type==='dynamicToolCall') {
    tool=item.tool;detail=(item.contentItems || []).map(part=>part.text || '').join('\n');
    outcome=item.success===false?'failed':outcome;
    try {const value=JSON.parse(detail);if(value.applied===false)outcome='not applied';detail=JSON.stringify(value,null,2);}catch{}
  }else if(item.type==='commandExecution') {
    tool='Run command';detail=[item.command,item.aggregatedOutput].filter(Boolean).join('\n\n');
  }else if(item.type==='fileChange') {
    tool='Change files';detail=JSON.stringify(item.changes,null,2);
  }else if(item.type==='mcpToolCall') {
    tool=`${item.server} · ${item.tool}`;detail=JSON.stringify(item.error || item.result,null,2);
  }else if(item.type==='reasoning' && item.summary?.length) {
    tool='Thinking';detail=item.summary.join('\n');outcome='summary';
  }else return null;
  detail=detail || '';
  if(detail.length>20000)detail=detail.slice(0,20000)+'\n… Display truncated';
  return {role:'Tool',tool,detail,outcome,text:`${tool}: ${outcome}`};
}
module.exports={toolView};
