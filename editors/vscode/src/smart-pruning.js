async function setSmartPruning(rpc,root,enabled){
  if(typeof enabled!=='boolean')throw Error('Choose Smart Pruning on or off.');
  const data=await rpc.request('config/read',{cwd:root,includeLayers:true});
  const user=data.layers?.find(layer=>layer.name?.type==='user'&&!layer.name.profile);
  if(!user?.version)throw Error('Reload configuration before changing Smart Pruning: no configuration version.');
  return rpc.request('config/batchWrite',{edits:[{keyPath:'features.automatic_context_pruning',value:enabled,mergeStrategy:'replace'}],expectedVersion:user.version,reloadUserConfig:true});
}
function ledgerSnapshot(usage,smart=usage?.smartPrune){
  const number=value=>Number.isFinite(value)&&value>=0?value:null;
  const used=number(usage?.last?.totalTokens),window=number(usage?.modelContextWindow);
  return {used,window,percent:used!==null&&window>0?Math.round(used/window*100):null,
    enabled:typeof smart?.enabled==='boolean'?smart.enabled:null,
    saved:number(smart?.approxSavedTokens),optimizerTokens:number(smart?.optimizerUsage?.totalTokens),
    admitted:number(smart?.admittedOutputs),failures:number(smart?.failedBatches),
    optimizerRequests:number(smart?.optimizerRequests),optimizerUsageReports:number(smart?.optimizerUsageReports),
    attribution:usage?.contextAttribution??null,latestAttempt:smart?.latestAttempt??null};
}
module.exports={setSmartPruning,ledgerSnapshot};
