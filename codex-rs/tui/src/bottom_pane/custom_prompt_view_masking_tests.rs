use super::*;

#[test]
fn elpis_masked_provider_key_stays_private_after_paste_edit_and_resize() {
    let (submitted, received) = std::sync::mpsc::channel();
    let mut view = CustomPromptView::new(
        "API key".into(),
        "Paste key".into(),
        String::new(),
        None,
        Box::new(move |value| submitted.send(value).unwrap()),
    )
    .masked();
    let secret = "sk-private-fixture-0123456789abcdefghijklmnop";
    assert!(view.handle_paste(secret.into()));
    view.handle_key_event(KeyCode::Backspace.into());

    for width in [12, 40, 80] {
        let area = Rect::new(0, 0, width, 8);
        let mut buffer = Buffer::empty(area);
        view.render(area, &mut buffer);
        let rendered: String = buffer.content().iter().map(|cell| cell.symbol()).collect();
        assert!(rendered.contains('•'), "masked input must remain visible");
        for fragment in ["sk-", "private", "fixture", "0123456789", "abcdefghijkl"] {
            assert!(!rendered.contains(fragment), "key leaked at width {width}");
        }
        let (x, y) = view.cursor_pos(area).expect("key input cursor");
        assert!(x < width && y < area.height);
    }

    view.handle_key_event(KeyCode::Enter.into());
    assert_eq!(received.try_recv().unwrap(), &secret[..secret.len() - 1]);
    assert_eq!(view.completion(), Some(ViewCompletion::Accepted));
}
