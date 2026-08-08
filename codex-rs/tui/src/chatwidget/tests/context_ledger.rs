use super::*;

use crate::render::renderable::Renderable;

fn render_ledger(chat: &ChatWidget, height: u16) -> String {
    let area = ratatui::layout::Rect::new(0, 0, 52, height);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    chat.render_context_ledger(area, &mut buf);

    (0..area.height)
        .map(|y| {
            (0..area.width).fold(String::new(), |mut line, x| {
                line.push_str(&crate::terminal_hyperlinks::strip_osc8(
                    buf[(x, y)].symbol(),
                ));
                line
            })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_ledger_buffer(chat: &ChatWidget, height: u16) -> ratatui::buffer::Buffer {
    let area = ratatui::layout::Rect::new(0, 0, 52, height);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    chat.render_context_ledger(area, &mut buf);
    buf
}

fn configure_ledger_sources(
    chat: &mut ChatWidget,
    root: &std::path::Path,
) -> anyhow::Result<(PathBuf, PathBuf)> {
    let memories = root.join(".elpis/memories");
    let cwd = root.join("projects/Elpis");
    let dev = root.join("projects/skills/dev");
    let global = root.join("global/AGENTS.md");
    let workspace = crate::legacy_core::elpis_context::workspace_context_dir(Some(&memories), &cwd)
        .expect("workspace path");

    std::fs::create_dir_all(global.parent().expect("global parent"))?;
    std::fs::create_dir_all(&cwd)?;
    std::fs::create_dir_all(&dev)?;
    std::fs::create_dir_all(&workspace)?;
    std::fs::create_dir_all(&memories)?;
    std::fs::write(&global, "Global instructions")?;
    std::fs::write(cwd.join("AGENTS.md"), "Project instructions")?;
    std::fs::write(dev.join("SKILL.md"), "Development instructions")?;
    std::fs::write(workspace.join("GOAL.md"), "Ship the grouped ledger")?;
    std::fs::write(workspace.join("ES.md"), "Command evidence")?;
    std::fs::write(memories.join("MEMORY.md"), "Durable memory")?;

    chat.config.memory_dir = memories.clone().abs();
    chat.config.cwd = cwd.clone().abs();
    // The ledger reads instruction rows from the server-reported list, exactly as
    // /usage does. Mirror a real session by reporting the same files created above.
    chat.instruction_source_paths = vec![
        codex_utils_path_uri::PathUri::from_abs_path(&global.abs()),
        codex_utils_path_uri::PathUri::from_abs_path(&cwd.join("AGENTS.md").abs()),
        codex_utils_path_uri::PathUri::from_abs_path(&dev.join("SKILL.md").abs()),
    ];
    chat.last_rendered_width.set(Some(120));
    Ok((memories, cwd))
}

fn instruction_paths(chat: &ChatWidget) -> Vec<PathBuf> {
    chat.instruction_source_paths_as_path_bufs()
}

#[tokio::test]
async fn ledger_groups_real_sources_and_exposes_selected_reason() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;

    let unfocused = render_ledger(&chat, 80);
    assert!(unfocused.contains("Tab focus"));
    assert!(unfocused.contains("Ctrl+click open file"));

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('w'))));
    let rendered = render_ledger(&chat, 80);

    // GOAL.md and ES.md both carry the session forward, so they share one category and
    // there is no separate evidence heading.
    for heading in ["SESSION CONTINUITY", "DURABLE MEMORY", "INSTRUCTIONS"] {
        assert!(rendered.contains(heading), "missing {heading}:\n{rendered}");
    }
    assert!(rendered.contains("≈"), "token estimates must be labeled");
    assert!(rendered.contains("Up/Down move"));
    assert!(rendered.contains("Space/Enter toggle"));
    assert!(rendered.contains("WHY INCLUDED"));
    assert!(rendered.contains("applicable global rules"));
    assert!(
        rendered.contains("dev/SKILL.md"),
        "server-reported dev rule must render as its own row:\n{rendered}"
    );

    let short = render_ledger(&chat, 16);
    assert!(short.contains("Global AGENTS.md"));
    assert!(short.contains("WHY INCLUDED"));
    assert!(short.contains("applicable global rules"));
    Ok(())
}

#[tokio::test]
async fn ledger_file_rows_emit_real_file_hyperlinks() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;

    let rendered = render_ledger_buffer(&chat, 80);
    let hyperlink_prefix = format!("\u{1b}]8;;file://{}", root.path().display());
    assert!(
        rendered
            .content()
            .iter()
            .any(|cell| cell.symbol().contains(&hyperlink_prefix)),
        "underlining alone is not clickable; expected an OSC 8 file link"
    );
    Ok(())
}

#[tokio::test]
async fn ledger_g_sequences_exclude_and_include_all_selectable_sources() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab));

    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('g')));
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('e')));
    assert!(
        crate::legacy_core::elpis_context::continuity_sources(
            Some(&memories),
            &cwd,
            &instruction_paths(&chat),
        )
        .iter()
        .filter(|source| source.selectable)
        .all(|source| !source.admitted)
    );

    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('g')));
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('i')));
    assert!(
        crate::legacy_core::elpis_context::continuity_sources(
            Some(&memories),
            &cwd,
            &instruction_paths(&chat),
        )
        .iter()
        .filter(|source| source.selectable)
        .all(|source| source.admitted)
    );
    Ok(())
}

#[tokio::test]
async fn ledger_dedupes_manually_added_file_that_is_already_a_rule() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;

    let dev_rule = root.path().join("projects/skills/dev/SKILL.md");
    crate::legacy_core::elpis_context::add_continuity_source(Some(&memories), &cwd, &dev_rule)?;

    let sources = crate::legacy_core::elpis_context::continuity_sources(
        Some(&memories),
        &cwd,
        &instruction_paths(&chat),
    );
    let rows = sources
        .iter()
        .filter(|source| {
            source
                .path
                .canonicalize()
                .ok()
                .zip(dev_rule.canonicalize().ok())
                .is_some_and(|(a, b)| a == b)
        })
        .count();
    assert_eq!(
        rows, 1,
        "a /add-ed file already admitted as a rule must appear exactly once"
    );
    Ok(())
}

#[tokio::test]
async fn ledger_and_status_read_the_same_source_list() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;

    let sources = crate::legacy_core::elpis_context::continuity_sources(
        Some(&memories),
        &cwd,
        &instruction_paths(&chat),
    );
    // Every server-reported instruction file must appear as a row; nothing hidden.
    for name in ["Global AGENTS.md", "Project AGENTS.md", "dev/SKILL.md"] {
        assert!(
            sources.iter().any(|source| source.name == name),
            "missing row {name}"
        );
    }
    // And the rendered panel shows them all too.
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab));
    let rendered = render_ledger(&chat, 80);
    for name in ["Global AGENTS.md", "Project AGENTS.md", "dev/SKILL.md"] {
        assert!(rendered.contains(name), "panel hides {name}:\n{rendered}");
    }
    Ok(())
}

#[tokio::test]
async fn full_widget_render_keeps_context_ledger_visible() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;

    let area = ratatui::layout::Rect::new(0, 0, 120, 80);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    Renderable::render(&chat, area, &mut buf);
    let rendered = buf
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("CONTEXT LEDGER"));
    Ok(())
}
