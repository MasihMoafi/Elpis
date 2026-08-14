use super::{ScopeKind, SymbolScope};
use crate::displacement::LineIndex;

/// Universal structural parser for generic languages.
pub fn parse_universal_scopes(source: &str) -> Vec<SymbolScope> {
    let line_index = LineIndex::new(source);
    let mut scopes = Vec::new();
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        if bytes[i] == b'#' || (bytes[i] == b'/' && i + 1 < len && bytes[i + 1] == b'/') {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        let is_word_start = i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_';
        if is_word_start {
            let rem = &source[i..];
            for kw in &["function ", "class ", "def ", "fn ", "method "] {
                if rem.starts_with(kw) {
                    let decl_start = find_line_start(source, i);
                    if let Some((sig, name, body_end)) = extract_generic_block(source, i) {
                        let (start_line, _) = line_index.line_col(source, decl_start);
                        let (end_line, _) = line_index.line_col(source, body_end);

                        let kind = if kw.contains("class") {
                            ScopeKind::Class
                        } else {
                            ScopeKind::Function
                        };

                        scopes.push(SymbolScope {
                            name: name.clone(),
                            kind,
                            signature: sig.trim().to_string(),
                            path: vec![name],
                            byte_range: decl_start..body_end,
                            line_range: start_line..end_line,
                            children: Vec::new(),
                        });

                        i = body_end;
                        break;
                    }
                }
            }
        }

        i += 1;
    }

    scopes
}

fn extract_generic_block(source: &str, start_pos: usize) -> Option<(String, String, usize)> {
    let bytes = source.as_bytes();
    let len = bytes.len();

    let mut i = start_pos;
    let mut brace_start = None;
    while i < len {
        if bytes[i] == b'{' {
            brace_start = Some(i);
            break;
        }
        if bytes[i] == b';' {
            return None;
        }
        i += 1;
    }

    let b_start = brace_start?;
    let decl_line_start = find_line_start(source, start_pos);
    let sig_text = source[decl_line_start..b_start + 1].trim().to_string();
    let name = extract_generic_name(&sig_text);

    let mut depth = 1;
    let mut curr = b_start + 1;
    while curr < len && depth > 0 {
        if bytes[curr] == b'{' {
            depth += 1;
        } else if bytes[curr] == b'}' {
            depth -= 1;
        }
        curr += 1;
    }

    let b_end = curr;
    let line_end = find_line_end(source, b_end);
    Some((sig_text, name, line_end))
}

fn extract_generic_name(sig: &str) -> String {
    for kw in &["function ", "class ", "def ", "fn ", "method "] {
        if let Some(pos) = sig.find(kw) {
            let after = sig[pos + kw.len()..].trim_start();
            let name_end = after
                .find(|c: char| !c.is_alphanumeric() && c != '_')
                .unwrap_or(after.len());
            return after[..name_end].to_string();
        }
    }
    "unknown".to_string()
}

fn find_line_start(source: &str, pos: usize) -> usize {
    let bytes = source.as_bytes();
    let mut i = pos;
    while i > 0 && bytes[i - 1] != b'\n' {
        i -= 1;
    }
    i
}

fn find_line_end(source: &str, pos: usize) -> usize {
    let bytes = source.as_bytes();
    let mut i = pos;
    while i < bytes.len() && bytes[i] != b'\n' {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'\n' {
        i += 1;
    }
    i
}
