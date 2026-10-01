//! Elpis: the work graph under `/agent` (v0.3.0 `multi_agents.rs` and `session_lifecycle.rs`).
//!
//! Opening the agent picker shows the root thread's latest work graph: each task with its
//! status, summary, changed files, checks, evidence, unchecked work and failure.

use super::*;
use crate::history_cell::PlainHistoryCell;
use codex_app_server_protocol::WorkGraphSummary;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;

impl App {
    /// Adds the root thread's latest work graph to the transcript, if it ran one.
    pub(super) async fn show_latest_work_graph(&mut self, app_server: &mut AppServerSession) {
        let Some(root_thread_id) = self.primary_thread_id else {
            return;
        };
        match app_server.work_graph_list(root_thread_id).await {
            Ok(response) => {
                if let Some(graph) = response.data.first() {
                    self.chat_widget
                        .add_to_history(work_graph_history_cell(graph));
                }
            }
            Err(err) => {
                self.chat_widget.add_info_message(
                    format!("Unable to load the work graph: {err}"),
                    /*hint*/ None,
                );
            }
        }
    }
}

fn work_graph_history_cell(graph: &WorkGraphSummary) -> PlainHistoryCell {
    let mut lines = vec![Line::from(vec![
        "Work graph ".bold(),
        Span::from(graph.name.clone()).bold(),
        Span::from(format!(" [{}]", graph.status)).dim(),
    ])];
    for (index, task) in graph.tasks.iter().enumerate() {
        let branch = if index + 1 == graph.tasks.len() {
            "└─ "
        } else {
            "├─ "
        };
        let status = match task.status.as_str() {
            "succeeded" => "✓".green(),
            "failed" | "blocked" | "cancelled" => "✕".red(),
            "running" => "●".yellow(),
            _ => "○".dim(),
        };
        lines.push(Line::from(vec![
            Span::from(branch).dim(),
            status,
            " ".into(),
            Span::from(task.kind.clone()).cyan(),
            " ".into(),
            Span::from(task.title.clone()),
        ]));
        if let Some(summary) = task
            .result
            .as_ref()
            .and_then(|result| result.get("summary"))
            .and_then(serde_json::Value::as_str)
        {
            lines.push(Line::from(vec![
                "   summary: ".dim(),
                Span::from(summary.to_string()),
            ]));
        }
        for (label, field) in [
            ("changed", "changed_files"),
            ("checks", "checks"),
            ("risks", "risks"),
            ("questions", "open_questions"),
        ] {
            if let Some(values) = task
                .result
                .as_ref()
                .and_then(|result| result.get(field))
                .and_then(serde_json::Value::as_array)
            {
                let values = values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>();
                if !values.is_empty() {
                    lines.push(Line::from(vec![
                        Span::from(format!("   {label}: ")).dim(),
                        Span::from(values.join("; ")),
                    ]));
                }
            }
        }
        for evidence in &task.evidence {
            lines.push(Line::from(vec![
                "   evidence: ".dim(),
                Span::from(evidence.clone()),
            ]));
        }
        if let Some(unchecked) = task
            .result
            .as_ref()
            .and_then(|result| result.get("what_i_did_not_check"))
            .and_then(serde_json::Value::as_array)
        {
            let unchecked = unchecked
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>();
            lines.push(Line::from(vec![
                "   unchecked: ".dim(),
                Span::from(if unchecked.is_empty() {
                    "none reported".to_string()
                } else {
                    unchecked.join("; ")
                }),
            ]));
        }
        if let Some(reason) = task.failure_reason.as_deref() {
            lines.push(Line::from(vec![
                "   failure: ".red(),
                Span::from(reason.to_string()),
            ]));
        }
    }
    if let Some(error) = graph.error.as_deref() {
        lines.push(Line::from(vec![
            "Graph error: ".red(),
            Span::from(error.to_string()),
        ]));
    }
    PlainHistoryCell::new(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered(graph: &WorkGraphSummary) -> String {
        work_graph_history_cell(graph)
            .display_lines(/*width*/ 200)
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn work_graph_renders_status_evidence_and_unchecked_work() {
        let graph = WorkGraphSummary {
            id: "graph-1".to_string(),
            name: "Accountable change".to_string(),
            status: "failed".to_string(),
            max_concurrency: 2,
            error: Some("verification failed".to_string()),
            event_count: 6,
            tasks: vec![codex_app_server_protocol::WorkGraphTaskSummary {
                id: "implement".to_string(),
                kind: "implement".to_string(),
                title: "Implement behavior".to_string(),
                status: "succeeded".to_string(),
                dependencies: Vec::new(),
                assigned_thread_id: Some("00000000-0000-0000-0000-000000000002".to_string()),
                result: Some(serde_json::json!({
                    "summary": "added the check",
                    "what_i_did_not_check": ["production data"]
                })),
                evidence: vec!["focused test passed".to_string()],
                failure_reason: None,
            }],
        };
        let text = rendered(&graph);
        assert!(text.contains("Work graph Accountable change [failed]"));
        assert!(text.contains("└─ ✓ implement Implement behavior"));
        assert!(text.contains("summary: added the check"));
        assert!(text.contains("evidence: focused test passed"));
        assert!(text.contains("unchecked: production data"));
        assert!(text.contains("Graph error: verification failed"));
    }
}
