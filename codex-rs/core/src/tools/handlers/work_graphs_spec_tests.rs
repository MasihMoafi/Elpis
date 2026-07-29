use super::*;

#[test]
fn work_graph_tool_requires_name_and_tasks() {
    let ToolSpec::Function(tool) = create_run_agent_work_graph_tool() else {
        panic!("expected function tool");
    };
    assert_eq!(tool.name, "run_agent_work_graph");
    assert_eq!(
        tool.parameters.required,
        Some(vec!["name".to_string(), "tasks".to_string()])
    );
}

#[test]
fn report_tool_is_worker_only_and_requires_evidence_field() {
    let ToolSpec::Function(tool) = create_report_agent_work_task_tool() else {
        panic!("expected function tool");
    };
    assert_eq!(tool.name, "report_agent_work_task");
    assert!(tool.description.contains("Worker-only"));
    assert!(
        tool.parameters
            .required
            .expect("required fields")
            .contains(&"evidence".to_string())
    );
}
