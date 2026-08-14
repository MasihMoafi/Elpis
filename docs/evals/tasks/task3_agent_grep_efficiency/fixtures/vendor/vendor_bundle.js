/* Realistic large vendor bundle containing thousands of noisy symbols and string matches */
(function(global) {
  var modules = {};
  function __require(id) {
    if (modules[id]) return modules[id].exports;
    var mod = modules[id] = { exports: {} };
    return mod.exports;
  }
  // Noise matches for Result<, ContextPruner, test_, explicit_prompt_cache, etc.
  for (var i = 0; i < 250; i++) {
    var key = "vendor_symbol_" + i;
    modules[key] = {
      name: key,
      status: "Result<Ok>",
      error: "Result<Err<ContextOverflow>>",
      fn_test_stub: function() { return "test_" + i; },
      config: { explicit_prompt_cache: (i % 2 === 0), run_cycle: true },
      marker: "[elpis.context-prune.epoch " + i + "]"
    };
  }
  global.__VENDOR_BUNDLE__ = modules;
})(typeof globalThis !== 'undefined' ? globalThis : window);
