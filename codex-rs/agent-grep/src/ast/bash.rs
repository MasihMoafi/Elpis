use super::{ScopeKind, SymbolScope};
use crate::displacement::LineIndex;
use tree_sitter::Parser;
use tree_sitter_bash::LANGUAGE as BASH;

pub fn parse_bash_scopes(source: &str) -> Vec<SymbolScope> {
    if let Some(scopes) = parse_bash_with_tree_sitter(source) {
        if !scopes.is_empty() {
            return scopes;
        }
    }
    parse_bash_scopes_fallback(source)
}

fn parse_bash_with_tree_sitter(source: &str) -> Option<Vec<SymbolScope>> {
    let mut parser = Parser::new();
    let lang = BASH.into();
    if parser.set_language(&lang).is_err() {
        return None;
    }

    let tree = parser.parse(source, None)?;
    let root = tree.root_node();
    let line_index = LineIndex::new(source);

    let mut scopes = Vec::new();
    let mut cursor = root.walk();

    for child in root.children(&mut cursor) {
        if child.kind() == "function_definition" {
            let start_byte = child.start_byte();
            let end_byte = child.end_byte();
            let (start_line, _) = line_index.line_col(source, start_byte);
            let (end_line, _) = line_index.line_col(source, end_byte);

            // Extract function name
            let name = if let Some(name_node) = child.child_by_field_name("name") {
                source[name_node.start_byte()..name_node.end_byte()].to_string()
            } else {
                extract_bash_name(&source[start_byte..end_byte])
            };

            // First line or signature line
            let sig_end = source[start_byte..end_byte]
                .find('\n')
                .map(|p| start_byte + p)
                .unwrap_or(end_byte);
            let signature = source[start_byte..sig_end].trim().to_string();

            scopes.push(SymbolScope {
                name: name.clone(),
                kind: ScopeKind::Function,
                signature,
                path: vec![name],
                byte_range: start_byte..end_byte,
                line_range: start_line..end_line,
                children: Vec::new(),
            });
        }
    }

    Some(scopes)
}

fn parse_bash_scopes_fallback(source: &str) -> Vec<SymbolScope> {
    let line_index = LineIndex::new(source);
    let mut scopes = Vec::new();
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        if bytes[i] == b'#' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        let is_word_start = i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_';
        if is_word_start {
            let rem = &source[i..];
            if rem.starts_with("function ") || (rem.contains("()") && is_bash_func_line(rem)) {
                let decl_start = find_line_start(source, i);
                if let Some((sig, name, _, body_end)) = extract_brace_block(source, i) {
                    let (start_line, _) = line_index.line_col(source, decl_start);
                    let (end_line, _) = line_index.line_col(source, body_end);

                    scopes.push(SymbolScope {
                        name: name.clone(),
                        kind: ScopeKind::Function,
                        signature: sig.trim().to_string(),
                        path: vec![name],
                        byte_range: decl_start..body_end,
                        line_range: start_line..end_line,
                        children: Vec::new(),
                    });

                    i = body_end;
                    continue;
                }
            }
        }

        i += 1;
    }

    scopes
}

fn is_bash_func_line(s: &str) -> bool {
    let trimmed = s.trim_start();
    if let Some(paren_pos) = trimmed.find("()") {
        if let Some(brace_pos) = trimmed.find('{') {
            return paren_pos < brace_pos;
        }
    }
    false
}

fn extract_bash_name(code: &str) -> String {
    let trimmed = code.trim_start();
    if let Some(pos) = trimmed.find("function") {
        let after = trimmed[pos + 8..].trim_start();
        let name_end = after
            .find(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
            .unwrap_or(after.len());
        return after[..name_end].to_string();
    }
    if let Some(paren_pos) = trimmed.find('(') {
        let before = trimmed[..paren_pos].trim();
        return before.to_string();
    }
    "unknown".to_string()
}

fn extract_brace_block(source: &str, start_pos: usize) -> Option<(String, String, usize, usize)> {
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
    let name = extract_bash_name(&sig_text);

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
    Some((sig_text, name, b_start + 1, line_end))
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
