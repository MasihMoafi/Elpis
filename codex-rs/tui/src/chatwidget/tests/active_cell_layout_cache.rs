use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use crate::history_cell::HistoryCell;

use super::*;

#[derive(Debug)]
struct CountingCell {
    desired_height_calls: Arc<AtomicUsize>,
}

impl CountingCell {
    fn new(desired_height_calls: Arc<AtomicUsize>) -> Self {
        Self {
            desired_height_calls,
        }
    }
}

impl HistoryCell for CountingCell {
    fn display_lines(&self, _width: u16) -> Vec<Line<'static>> {
        vec![Line::from("stable active cell")]
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        self.display_lines(/*width*/ 80)
    }

    fn desired_height(&self, _width: u16) -> u16 {
        self.desired_height_calls.fetch_add(1, Ordering::Relaxed);
        1
    }
}

#[tokio::test]
async fn unchanged_active_cell_reuses_desired_height() {
    let (mut chat, _events, _ops) = make_chatwidget_manual(None).await;
    let calls = Arc::new(AtomicUsize::new(0));
    chat.transcript.active_cell = Some(Box::new(CountingCell::new(Arc::clone(&calls))));
    chat.bump_active_cell_revision();

    let _ = Renderable::desired_height(&chat, /*width*/ 120);
    let after_first_layout = calls.load(Ordering::Relaxed);
    assert!(after_first_layout > 0, "first layout must measure the cell");

    let _ = Renderable::desired_height(&chat, /*width*/ 120);
    assert_eq!(
        calls.load(Ordering::Relaxed),
        after_first_layout,
        "unchanged active-cell height should come from the bounded layout cache",
    );
}
