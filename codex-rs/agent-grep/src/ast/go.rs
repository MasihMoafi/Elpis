use super::{ScopeKind, SymbolScope};
use crate::displacement::LineIndex;

pub fn parse_go_scopes(source: &str) -> Vec<SymbolScope> {
    let line_index = LineIndex::new(source);
    let mut scopes = Vec::new();
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        // Skip comments
        if bytes[i] == b'/' && i + 1 < len && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i] == b'/' && i + 1 < len && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(len);
            continue;
        }
        if bytes[i] == b'"' || bytes[i] == b'`' {
            let quote = bytes[i];
            i += 1;
            while i < len {
                if quote == b'"' && bytes[i] == b'\\' {
                    i += 2;
                } else if bytes[i] == quote {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }

        let is_word_start = i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_';
        if is_word_start {
            let rem = &source[i..];

            // 1. Check for `func `
            if rem.starts_with("func ") {
                let decl_start = find_line_start(source, i);
                if let Some((sig, name, receiver, body_end)) = extract_go_func_block(source, i) {
                    let (start_line, _) = line_index.line_col(source, decl_start);
                    let (end_line, _) = line_index.line_col(source, body_end);

                    let (kind, path) = if let Some(recv) = receiver {
                        (ScopeKind::Method, vec![recv, name.clone()])
                    } else {
                        (ScopeKind::Function, vec![name.clone()])
                    };

                    scopes.push(SymbolScope {
                        name,
                        kind,
                        signature: sig.trim().to_string(),
                        path,
                        byte_range: decl_start..body_end,
                        line_range: start_line..end_line,
                        children: Vec::new(),
                    });

                    i = body_end;
                    continue;
                }
            }

            // 2. Check for `type ... struct` / `type ... interface`
            if rem.starts_with("type ") {
                let decl_start = find_line_start(source, i);
                if let Some((sig, name, kind, body_end)) = extract_go_type_block(source, i) {
                    let (start_line, _) = line_index.line_col(source, decl_start);
                    let (end_line, _) = line_index.line_col(source, body_end);

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
                    continue;
                }
            }
        }

        i += 1;
    }

    scopes
}

fn extract_go_func_block(
    source: &str,
    start_pos: usize,
) -> Option<(String, String, Option<String>, usize)> {
    let bytes = source.as_bytes();
    let len = bytes.len();

    let mut i = start_pos;
    let mut brace_start = None;
    while i < len {
        if bytes[i] == b'{' {
            brace_start = Some(i);
            break;
        }
        if bytes[i] == b';' || bytes[i] == b'\n' {
            // Check if multiline func sig or interface method
            if bytes[i] == b';' {
                return None;
            }
        }
        i += 1;
    }

    let b_start = brace_start?;
    let decl_line_start = find_line_start(source, start_pos);
    let sig_text = source[decl_line_start..b_start + 1].trim().to_string();

    let (name, receiver) = parse_go_func_signature(&sig_text);

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
    Some((sig_text, name, receiver, line_end))
}

fn parse_go_func_signature(sig: &str) -> (String, Option<String>) {
    let after_func = if let Some(idx) = sig.find("func") {
        sig[idx + 4..].trim_start()
    } else {
        sig
    };

    if after_func.starts_with('(') {
        // Method with receiver: `(s *Service) MethodName(...)`
        if let Some(close_recv) = after_func.find(')') {
            let recv_str = &after_func[1..close_recv].trim();
            let recv_type = recv_str
                .split_whitespace()
                .last()
                .unwrap_or("")
                .trim_start_matches('*');

            let after_recv = after_func[close_recv + 1..].trim_start();
            let name_end = after_recv
                .find(|c: char| !c.is_alphanumeric() && c != '_')
                .unwrap_or(after_recv.len());
            let name = after_recv[..name_end].to_string();
            (name, Some(recv_type.to_string()))
        } else {
            ("unknown".to_string(), None)
        }
    } else {
        // Plain function: `MethodName(...)`
        let name_end = after_func
            .find(|c: char| !c.is_alphanumeric() && c != '_')
            .unwrap_or(after_func.len());
        (after_func[..name_end].to_string(), None)
    }
}

fn extract_go_type_block(
    source: &str,
    start_pos: usize,
) -> Option<(String, String, ScopeKind, usize)> {
    let bytes = source.as_bytes();
    let len = bytes.len();

    let mut i = start_pos;
    let mut brace_start = None;
    while i < len {
        if bytes[i] == b'{' {
            brace_start = Some(i);
            break;
        }
        i += 1;
    }

    let b_start = brace_start?;
    let decl_line_start = find_line_start(source, start_pos);
    let sig_text = source[decl_line_start..b_start + 1].trim().to_string();

    let is_interface = sig_text.contains("interface");
    let kind = if is_interface {
        ScopeKind::Interface
    } else {
        ScopeKind::Struct
    };

    let name = extract_go_type_name(&sig_text);

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
    Some((sig_text, name, kind, line_end))
}

fn extract_go_type_name(sig: &str) -> String {
    if let Some(pos) = sig.find("type") {
        let after = sig[pos + 4..].trim_start();
        let name_end = after
            .find(|c: char| !c.is_alphanumeric() && c != '_')
            .unwrap_or(after.len());
        after[..name_end].to_string()
    } else {
        "unknown".to_string()
    }
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
