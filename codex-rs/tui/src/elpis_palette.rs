use ratatui::style::Color;

// Category hues retain their contrast on charcoal and light backgrounds.
pub(crate) const USER_MESSAGES_COLOR: Color = Color::Rgb(83, 177, 255);
pub(crate) const AGENT_RESPONSES_COLOR: Color = Color::Rgb(63, 211, 148);
pub(crate) const REASONING_COLOR: Color = Color::Rgb(171, 132, 255);
pub(crate) const TOOL_CALLS_COLOR: Color = Color::Rgb(255, 161, 58);
pub(crate) const TOOL_RESULTS_COLOR: Color = Color::Rgb(217, 219, 117);
pub(crate) const SYSTEM_INSTRUCTIONS_COLOR: Color = Color::Rgb(240, 68, 93);
pub(crate) const DEVELOPER_MESSAGES_COLOR: Color = Color::Rgb(255, 153, 194);
pub(crate) const TOOL_DEFINITIONS_COLOR: Color = Color::Rgb(160, 160, 160);
pub(crate) const UNRECOGNIZED_ITEMS_COLOR: Color = Color::Rgb(29, 209, 226);
pub(crate) const LIGHT_USER_MESSAGES_COLOR: Color = Color::Rgb(0, 108, 206);
pub(crate) const LIGHT_AGENT_RESPONSES_COLOR: Color = Color::Rgb(0, 135, 92);
pub(crate) const LIGHT_REASONING_COLOR: Color = Color::Rgb(113, 67, 214);
pub(crate) const LIGHT_TOOL_CALLS_COLOR: Color = Color::Rgb(205, 103, 0);
pub(crate) const LIGHT_TOOL_RESULTS_COLOR: Color = Color::Rgb(116, 132, 27);
pub(crate) const LIGHT_SYSTEM_INSTRUCTIONS_COLOR: Color = Color::Rgb(140, 45, 60);
pub(crate) const LIGHT_DEVELOPER_MESSAGES_COLOR: Color = Color::Rgb(206, 71, 143);
pub(crate) const LIGHT_TOOL_DEFINITIONS_COLOR: Color = Color::Rgb(100, 100, 100);
pub(crate) const LIGHT_UNRECOGNIZED_ITEMS_COLOR: Color = Color::Rgb(0, 131, 149);

pub(crate) const WORKING: Color = Color::Yellow;

pub(crate) fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color::Rgb(r, g, b)
}
