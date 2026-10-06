//! Elpis: old tool screenshots leave the prompt, so a long chat with screenshots does not send
//! tens of megabytes on every request.

use super::*;
use crate::context_manager::normalize::OLD_SCREENSHOT_NOTE;
use codex_protocol::models::ContentItem;
use codex_protocol::models::DEFAULT_IMAGE_DETAIL;
use codex_protocol::models::FunctionCallOutputContentItem;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::ImageReference;
use codex_protocol::openai_models::default_input_modalities;
use codex_utils_output_truncation::TruncationPolicy;
use pretty_assertions::assert_eq;

fn screenshot_call(n: usize) -> [ResponseItem; 2] {
    let call_id = format!("shot-{n}");
    [
        ResponseItem::CustomToolCall {
            id: None,
            status: None,
            call_id: call_id.clone(),
            name: "exec".to_string(),
            namespace: None,
            input: "screenshot".to_string(),
            internal_chat_message_metadata_passthrough: None,
        },
        ResponseItem::CustomToolCallOutput {
            id: None,
            call_id,
            name: None,
            output: FunctionCallOutputPayload::from_content_items(vec![
                FunctionCallOutputContentItem::InputText {
                    text: format!("screenshot {n}"),
                },
                FunctionCallOutputContentItem::InputImage {
                    image: ImageReference::Inline {
                        image_url: format!("data:image/png;base64,SHOT{n}"),
                    },
                    detail: Some(DEFAULT_IMAGE_DETAIL),
                },
            ]),
            internal_chat_message_metadata_passthrough: None,
        },
    ]
}

fn user_image_message() -> ResponseItem {
    ResponseItem::Message {
        id: None,
        role: "user".to_string(),
        content: vec![ContentItem::InputImage {
            image: ImageReference::Inline {
                image_url: "data:image/png;base64,PASTED".to_string(),
            },
            detail: Some(DEFAULT_IMAGE_DETAIL),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }
}

/// Screenshot numbers still sent as images, and the number replaced by the note.
fn prompt_screenshots(screenshots: usize) -> (Vec<usize>, usize) {
    let mut items = vec![user_image_message()];
    for n in 0..screenshots {
        items.extend(screenshot_call(n));
    }
    let mut history = ContextManager::new();
    history.record_items(items.iter(), TruncationPolicy::Tokens(10_000));
    let prompt = history.for_prompt(&default_input_modalities());

    assert!(
        matches!(&prompt[0], ResponseItem::Message { content, .. }
            if matches!(content[0], ContentItem::InputImage { .. })),
        "an image the user attached is never removed"
    );
    let mut kept = Vec::new();
    let mut notes = 0;
    for item in &prompt {
        let ResponseItem::CustomToolCallOutput { output, .. } = item else {
            continue;
        };
        for content in output.content_items().unwrap_or_default() {
            match content {
                FunctionCallOutputContentItem::InputImage {
                    image: ImageReference::Inline { image_url },
                    ..
                } => kept.push(
                    image_url["data:image/png;base64,SHOT".len()..]
                        .parse()
                        .unwrap(),
                ),
                FunctionCallOutputContentItem::InputText { text }
                    if text == OLD_SCREENSHOT_NOTE =>
                {
                    notes += 1
                }
                _ => {}
            }
        }
    }
    (kept, notes)
}

#[test]
fn a_few_screenshots_all_stay() {
    assert_eq!(prompt_screenshots(7), ((0..7).collect(), 0));
}

#[test]
fn old_screenshots_become_a_note_and_the_newest_stay() {
    // 30 screenshots: the 24 oldest leave in blocks of 4 and the newest 6 stay. Between 4 and 7
    // screenshots are always sent.
    let (kept, notes) = prompt_screenshots(30);
    assert_eq!(kept, (24..30).collect::<Vec<_>>());
    assert_eq!(notes, 24);
}

#[test]
fn the_cut_moves_in_blocks_so_the_cached_prefix_survives_most_requests() {
    // From 8 to 11 screenshots the same 4 leave; the prompt prefix does not change between them.
    for screenshots in 8..12 {
        assert_eq!(prompt_screenshots(screenshots).1, 4, "{screenshots}");
    }
    assert_eq!(prompt_screenshots(12).1, 8);
}
