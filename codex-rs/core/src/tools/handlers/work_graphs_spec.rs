use codex_tools::JsonSchema;
use codex_tools::ResponsesApiTool;
use codex_tools::ToolSpec;
use std::collections::BTreeMap;

pub fn create_run_agent_work_graph_tool() -> ToolSpec {
    let task_properties = BTreeMap::from([
        (
            "id".to_string(),
            JsonSchema::string(Some(
                "Stable task id using letters, digits, hyphens, or underscores.".to_string(),
            )),
        ),
        (
            "title".to_string(),
            JsonSchema::string(Some("Short human-facing task title.".to_string())),
        ),
        (
            "instruction".to_string(),
            JsonSchema::string(Some(
                "Bounded worker instruction including non-goals and required checks.".to_string(),
            )),
        ),
        (
            "depends_on".to_string(),
            JsonSchema::array(
                JsonSchema::string(None),
                Some("Task ids that must succeed before this task starts.".to_string()),
            ),
        ),
        (
            "write_scopes".to_string(),
            JsonSchema::array(
                JsonSchema::string(None),
                Some(
                    "Repository-relative file or directory prefixes this task may modify. Empty means read-only."
                        .to_string(),
                ),
            ),
        ),
        (
            "acceptance_criteria".to_string(),
            JsonSchema::array(
                JsonSchema::string(None),
                Some("Observable criteria the worker must prove.".to_string()),
            ),
        ),
        (
            "environment_id".to_string(),
            JsonSchema::string(Some(
                "Optional pre-selected environment/worktree id. Omit for the primary environment."
                    .to_string(),
            )),
        ),
    ]);
    let task_schema = JsonSchema::object(
        task_properties,
        Some(vec![
            "id".to_string(),
            "title".to_string(),
            "instruction".to_string(),
            "depends_on".to_string(),
            "write_scopes".to_string(),
            "acceptance_criteria".to_string(),
        ]),
        Some(false.into()),
    );
    let properties = BTreeMap::from([
        (
            "name".to_string(),
            JsonSchema::string(Some("Human-facing graph name.".to_string())),
        ),
        (
            "tasks".to_string(),
            JsonSchema::array(task_schema, Some("Complete dependency graph.".to_string())),
        ),
        (
            "max_concurrency".to_string(),
            JsonSchema::number(Some(
                "Maximum concurrent workers, bounded by the session agent limit.".to_string(),
            )),
        ),
        (
            "max_runtime_seconds".to_string(),
            JsonSchema::number(Some(
                "Maximum runtime per task. Defaults to 1800 seconds.".to_string(),
            )),
        ),
    ]);

    ToolSpec::Function(ResponsesApiTool {
        name: "run_agent_work_graph".to_string(),
        description:
            "Run a persisted dependency-aware work graph. The engine validates the DAG, starts only dependency-ready tasks, prevents overlapping write scopes in one environment, bounds concurrency, authenticates worker reports, blocks descendants after prerequisite failure, and records an event trail. Environments/worktrees must already be selected; this tool never creates, merges, or deletes branches."
                .to_string(),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(
            properties,
            Some(vec!["name".to_string(), "tasks".to_string()]),
            Some(false.into()),
        ),
        output_schema: None,
    })
}

pub fn create_report_agent_work_task_tool() -> ToolSpec {
    let properties = BTreeMap::from([
        (
            "graph_id".to_string(),
            JsonSchema::string(Some("Assigned work graph id.".to_string())),
        ),
        (
            "task_id".to_string(),
            JsonSchema::string(Some("Assigned task id.".to_string())),
        ),
        (
            "outcome".to_string(),
            JsonSchema::string(Some("Either `succeeded` or `failed`.".to_string())),
        ),
        (
            "summary".to_string(),
            JsonSchema::string(Some("Concise result summary.".to_string())),
        ),
        (
            "changed_files".to_string(),
            JsonSchema::array(
                JsonSchema::string(None),
                Some("Repository-relative changed files.".to_string()),
            ),
        ),
        (
            "checks".to_string(),
            JsonSchema::array(
                JsonSchema::string(None),
                Some("Checks run and outcomes.".to_string()),
            ),
        ),
        (
            "evidence".to_string(),
            JsonSchema::array(
                JsonSchema::string(None),
                Some("Concrete acceptance evidence.".to_string()),
            ),
        ),
        (
            "risks".to_string(),
            JsonSchema::array(
                JsonSchema::string(None),
                Some("Known gaps or risks.".to_string()),
            ),
        ),
        (
            "failure_reason".to_string(),
            JsonSchema::string(Some("Required for a failed outcome.".to_string())),
        ),
    ]);

    ToolSpec::Function(ResponsesApiTool {
        name: "report_agent_work_task".to_string(),
        description:
            "Worker-only terminal report for an assigned work-graph task. Only the assigned thread is accepted; success requires evidence and changed files must stay inside declared write scopes."
                .to_string(),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(
            properties,
            Some(vec![
                "graph_id".to_string(),
                "task_id".to_string(),
                "outcome".to_string(),
                "summary".to_string(),
                "changed_files".to_string(),
                "checks".to_string(),
                "evidence".to_string(),
                "risks".to_string(),
            ]),
            Some(false.into()),
        ),
        output_schema: None,
    })
}

#[cfg(test)]
#[path = "work_graphs_spec_tests.rs"]
mod tests;
