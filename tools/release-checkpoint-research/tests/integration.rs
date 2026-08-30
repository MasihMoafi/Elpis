#[path = "integration/ci.rs"]
mod ci;
#[path = "integration/report_pipeline.rs"]
mod report_pipeline;
// Explicit nested integration-test harness for committed checkpoint deltas.
#[path = "integration/artifacts.rs"]
mod artifacts;
#[path = "integration/git_delta.rs"]
mod git_delta;
