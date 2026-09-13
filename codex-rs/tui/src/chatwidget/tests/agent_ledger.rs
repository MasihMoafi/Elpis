use super::*;
use crate::chatwidget::agent_ledger::AgentLedgerEntry;

#[tokio::test]
async fn subagent_ledger_shows_status_and_activity_and_clears_with_session() {
    let (mut chat, _rx, _ops) = make_chatwidget_manual(None).await;
    assert!(chat.agent_ledger_lines(50).is_empty());
    chat.set_agent_ledger(vec![AgentLedgerEntry {
        task: "/root/input_failures".into(),
        status: "Running",
        activity: Some("Reproduced the missing redraw".into()),
    }]);
    let text = lines_to_single_string(&chat.agent_ledger_lines(50));
    assert!(text.contains("SUBAGENT LEDGER · 1"));
    assert!(text.contains("Running · /root/input_failures"));
    assert!(text.contains("Reproduced the missing redraw"));
    let area = ratatui::layout::Rect::new(0, 0, 55, 30);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    chat.render_context_ledger(area, &mut buffer);
    let rendered = buffer
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("SUBAGENT LEDGER"));
    assert!(rendered.contains("/root/input_failures"));
    chat.set_agent_ledger(vec![AgentLedgerEntry {
        task: "/root/input_failures".into(),
        status: "Idle",
        activity: Some("Fix ready for verification".into()),
    }]);
    let text = lines_to_single_string(&chat.agent_ledger_lines(50));
    assert!(text.contains("Idle · /root/input_failures"));
    assert!(!text.contains("Running"));
    chat.set_agent_ledger(Vec::new());
    assert!(chat.agent_ledger_lines(50).is_empty());
}
