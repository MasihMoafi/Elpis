'use strict';
const { withRuntime } = require('./runtime-query');

// Adapted from zed-industries/codex-acp, thread.rs::handle_set_config_model.
// Copyright 2022-2025 Zed Industries, Inc. Apache-2.0; see NOTICE.
function effortForModel(preset, current) {
  if (!preset || !Array.isArray(preset.efforts)) return current;
  return preset.efforts?.includes(current) ? current : (preset.defaultEffort || '');
}

async function loadModels(root, options) {
  return withRuntime(root, options, async rpc => {
    const models = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await rpc.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}), ...(options.provider ? { modelProvider: options.provider } : {}) }, 15000);
      if (!Array.isArray(page.data)) throw new Error('Elpis returned an invalid model catalog.');
      for (const model of page.data) {
        if (!model.hidden && typeof model.model === 'string') models.push({ label: model.displayName || model.model, description: model.model, model: model.model, efforts:(model.supportedReasoningEfforts || []).map(e => e.reasoningEffort), defaultEffort:model.defaultReasoningEffort, isDefault:model.isDefault });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Elpis repeated a model catalog page.');
      cursors.add(cursor);
    } while (cursor);
    return models;
  });
}
async function configuredModel(root,options) {
  const {config}=await withRuntime(root,options,rpc=>rpc.request('config/read',{cwd:root,includeLayers:false}));
  const model=config.model || (await loadModels(root,options)).find(model=>model.isDefault)?.model;
  if(!model)throw new Error('Elpis did not identify a configured default model. Choose a model from the catalog.');
  return model;
}
module.exports = { loadModels, effortForModel, configuredModel };
