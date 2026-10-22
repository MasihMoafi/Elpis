//! Static welcome mark using the geometry generated from the desktop Elpis SVG.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;

pub(crate) const WIDTH: u16 = 60;
pub(crate) const HEIGHT: u16 = 21;
const FRAME_BYTES: usize = WIDTH as usize * HEIGHT as usize * 4;
const MARK: &[u8] = include_bytes!("frames/elpis.bin");

pub(crate) fn render_mark(area: Rect, buffer: &mut Buffer) {
    if area.width != WIDTH || area.height != HEIGHT || area.intersection(buffer.area) != area {
        return;
    }
    // The first frame contains the original silhouette; its lighting is unused.
    for (index, cell) in MARK[..FRAME_BYTES]
        .chunks_exact(4)
        .enumerate()
        .filter(|(_, cell)| cell[0] != 0)
    {
        buffer[(area.x + index as u16 % WIDTH, area.y + index as u16 / WIDTH)]
            .set_char(char::from_u32(0x2800 + u32::from(cell[0])).unwrap_or(' '))
            .set_fg(Color::Reset);
    }
}
