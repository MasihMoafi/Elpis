use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use crate::history_cell::CompositeHistoryCell;
use crate::history_cell::HistoryCell;
use crate::render::highlight::current_syntax_theme;
use crate::render::highlight::set_syntax_theme;

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

#[derive(Debug)]
struct DisplayCountingCell {
    display_calls: Arc<AtomicUsize>,
}

impl HistoryCell for DisplayCountingCell {
    fn display_lines(&self, _width: u16) -> Vec<Line<'static>> {
        self.display_calls.fetch_add(1, Ordering::Relaxed);
        vec![Line::from("mutable composite part")]
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        vec![Line::from("mutable composite part")]
    }
}

fn measure(chat: &ChatWidget, width: u16) {
    let _ = Renderable::desired_height(chat, width);
}

#[tokio::test]
async fn unchanged_active_cell_reuses_desired_height() {
    let (mut chat, _events, _ops) = make_chatwidget_manual(None).await;
    let calls = Arc::new(AtomicUsize::new(0));
    chat.transcript.active_cell = Some(Box::new(CountingCell::new(Arc::clone(&calls))));
    chat.bump_active_cell_revision();

    measure(&chat, /*width*/ 120);
    let after_first_layout = calls.load(Ordering::Relaxed);
    assert!(after_first_layout > 0, "first layout must measure the cell");

    measure(&chat, /*width*/ 120);
    assert_eq!(
        calls.load(Ordering::Relaxed),
        after_first_layout,
        "unchanged active-cell height should come from the bounded layout cache",
    );
}

#[tokio::test]
async fn active_cell_layout_cache_invalidates_on_every_layout_input() {
    let (mut chat, _events, _ops) = make_chatwidget_manual(None).await;
    let calls = Arc::new(AtomicUsize::new(0));
    chat.transcript.active_cell = Some(Box::new(CountingCell::new(Arc::clone(&calls))));
    chat.bump_active_cell_revision();

    measure(&chat, /*width*/ 120);
    let mut previous = calls.load(Ordering::Relaxed);

    measure(&chat, /*width*/ 100);
    assert!(calls.load(Ordering::Relaxed) > previous, "width change");
    previous = calls.load(Ordering::Relaxed);

    chat.bump_active_cell_revision();
    measure(&chat, /*width*/ 100);
    assert!(calls.load(Ordering::Relaxed) > previous, "revision change");
    previous = calls.load(Ordering::Relaxed);

    let revision = chat.transcript.active_cell_revision;
    chat.set_raw_output_mode(/*enabled*/ true);
    assert_eq!(chat.transcript.active_cell_revision, revision);
    measure(&chat, /*width*/ 100);
    assert!(
        calls.load(Ordering::Relaxed) > previous,
        "render mode change"
    );
    previous = calls.load(Ordering::Relaxed);

    set_syntax_theme(current_syntax_theme());
    measure(&chat, /*width*/ 100);
    assert!(
        calls.load(Ordering::Relaxed) > previous,
        "syntax theme change"
    );
}

#[tokio::test]
async fn active_cell_identity_change_invalidates_layout_without_revision_change() {
    let (mut chat, _events, _ops) = make_chatwidget_manual(None).await;
    let first_calls = Arc::new(AtomicUsize::new(0));
    chat.transcript.active_cell = Some(Box::new(CountingCell::new(Arc::clone(&first_calls))));
    chat.bump_active_cell_revision();
    measure(&chat, /*width*/ 120);

    let second_calls = Arc::new(AtomicUsize::new(0));
    let replacement: Box<dyn HistoryCell> = Box::new(CountingCell::new(Arc::clone(&second_calls)));
    chat.transcript.active_cell = Some(replacement);
    measure(&chat, /*width*/ 120);

    assert!(
        second_calls.load(Ordering::Relaxed) > 0,
        "a different cell at the same revision must be measured",
    );
}

#[tokio::test]
async fn taking_active_cell_clears_layout_cache() {
    let (mut chat, _events, _ops) = make_chatwidget_manual(None).await;
    chat.transcript.active_cell = Some(Box::new(CountingCell::new(Arc::new(AtomicUsize::new(0)))));
    chat.bump_active_cell_revision();
    measure(&chat, /*width*/ 120);
    assert!(chat.transcript.active_cell_layout.get().is_some());

    let taken = chat.transcript.take_active_cell();
    assert!(taken.is_some());
    assert!(chat.transcript.active_cell_layout.get().is_none());
}

#[tokio::test]
async fn composite_active_cell_is_remeasured_each_frame() {
    let (mut chat, _events, _ops) = make_chatwidget_manual(None).await;
    let display_calls = Arc::new(AtomicUsize::new(0));
    chat.transcript.active_cell = Some(Box::new(CompositeHistoryCell::new(vec![Box::new(
        DisplayCountingCell {
            display_calls: Arc::clone(&display_calls),
        },
    )])));
    chat.bump_active_cell_revision();

    measure(&chat, /*width*/ 120);
    let after_first_layout = display_calls.load(Ordering::Relaxed);
    measure(&chat, /*width*/ 120);

    assert!(
        display_calls.load(Ordering::Relaxed) > after_first_layout,
        "composite cells can change through their parts and must not reuse height",
    );
    assert!(chat.transcript.active_cell_layout.get().is_none());
}
