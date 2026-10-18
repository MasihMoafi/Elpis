//! Manual tmux harness for the real welcome and keyboard-routing path, without
//! starting an Elpis client, loading credentials or contacting an app server.
use super::*;
use crate::terminal_palette::with_test_default_colors;
use crate::terminal_probe::DefaultColors;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

fn screen() -> OnboardingScreen {
    OnboardingScreen {
        request_frame: FrameRequester::test_dummy(),
        steps: vec![
            Step::Welcome(WelcomeWidget::new(
                false,
                FrameRequester::test_dummy(),
                true,
            )),
            Step::TrustDirectory(TrustDirectoryWidget {
                restricted: false,
                existing_task: false,
                cancel: super::super::trust_directory::TrustCancelAction::Quit,
                cwd: PathBuf::from("/tmp/elpis-logo-preview"),
                trust_target: PathBuf::from("/tmp/elpis-logo-preview"),
                show_windows_create_sandbox_hint: false,
                should_quit: false,
                selection: None,
                highlighted: TrustDirectorySelection::Trust,
                error: None,
            }),
        ],
        remote_trust_key: None,
        is_done: false,
        should_exit: false,
    }
}

#[test]
fn welcome_keys_reach_the_picker_before_the_animation_finishes() {
    for width in [80, 120] {
        let mut screen = screen();
        let area = Rect::new(0, 0, width, 41);
        let mut buffer = Buffer::empty(area);
        (&screen).render_ref(area, &mut buffer);
        assert!(
            buffer.content.iter().any(|cell| cell
                .symbol()
                .chars()
                .any(|c| ('\u{2801}'..='\u{28ff}').contains(&c))),
            "onboarding's second render must keep the logo"
        );
        let welcome: String = (0..width).map(|x| buffer[(x, 22)].symbol()).collect();
        assert!(welcome.contains("Welcome to Elpis"));
        screen.handle_key_event(KeyEvent::from(KeyCode::Down));
        let Step::TrustDirectory(widget) = &screen.steps[1] else {
            panic!("trust picker")
        };
        assert_eq!(widget.highlighted, TrustDirectorySelection::Quit);
        screen.handle_key_event(KeyEvent::from(KeyCode::Enter));
        assert!(screen.is_done());
        assert!(screen.should_exit());
    }
}

#[test]
#[ignore = "interactive preview: run alone in tmux with --ignored --nocapture"]
fn welcome_tmux_preview() {
    use crossterm::cursor::MoveTo;
    use crossterm::event::{Event, poll, read};
    use crossterm::execute;
    use crossterm::style::{Color as TerminalColor, SetBackgroundColor, SetForegroundColor};
    use crossterm::terminal::{Clear, ClearType, disable_raw_mode, enable_raw_mode, size};
    let light = std::env::var("ELPIS_LOGO_THEME").as_deref() == Ok("light");
    let colors = if light {
        DefaultColors {
            fg: (30, 30, 30),
            bg: (255, 255, 255),
        }
    } else {
        DefaultColors {
            fg: (220, 220, 220),
            bg: (15, 20, 37),
        }
    };
    let terminal_color = |rgb: (u8, u8, u8)| TerminalColor::Rgb {
        r: rgb.0,
        g: rgb.1,
        b: rgb.2,
    };
    enable_raw_mode().unwrap();
    let mut stdout = std::io::stdout();
    execute!(
        stdout,
        SetBackgroundColor(terminal_color(colors.bg)),
        Clear(ClearType::All)
    )
    .unwrap();
    let start = Instant::now();
    let mut screen = screen();
    with_test_default_colors(colors, || {
        while !screen.is_done() && start.elapsed() < Duration::from_secs(30) {
            let (width, height) = size().unwrap();
            let area = Rect::new(0, 0, width, height);
            let mut buffer = Buffer::empty(area);
            (&screen).render_ref(area, &mut buffer);
            for y in 0..height {
                execute!(stdout, MoveTo(0, y)).unwrap();
                for x in 0..width {
                    let cell = &buffer[(x, y)];
                    let fg = match cell.fg {
                        Color::Rgb(r, g, b) => (r, g, b),
                        _ => colors.fg,
                    };
                    execute!(stdout, SetForegroundColor(terminal_color(fg))).unwrap();
                    write!(stdout, "{}", cell.symbol()).unwrap();
                }
            }
            stdout.flush().unwrap();
            if poll(Duration::from_millis(50)).unwrap()
                && let Event::Key(key) = read().unwrap()
            {
                screen.handle_key_event(key);
            }
        }
    });
    disable_raw_mode().unwrap();
    assert!(
        screen.is_done(),
        "preview timed out before keyboard confirmation"
    );
    eprintln!("welcome keyboard confirmation after {:?}", start.elapsed());
}
