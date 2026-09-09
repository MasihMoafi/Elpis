use super::{ScopeKind, SymbolScope};
use crate::displacement::LineIndex;

pub fn parse_ts_js_scopes(source: &str) -> Vec<SymbolScope> {
    let line_index = LineIndex::new(source);
    let mut scopes = Vec::new();
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    let mut class_context: Option<(String, usize)> = None; // (class_name, brace_depth)
    let mut brace_depth = 0;

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
        if bytes[i] == b'"' || bytes[i] == b'\'' || bytes[i] == b'`' {
            let quote = bytes[i];
            i += 1;
            while i < len {
                if bytes[i] == b'\\' {
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

        if bytes[i] == b'{' {
            brace_depth += 1;
            i += 1;
            continue;
        } else if bytes[i] == b'}' {
            if let Some((_, depth)) = &class_context {
                if brace_depth <= *depth {
                    class_context = None;
                }
            }
            brace_depth = brace_depth.saturating_sub(1);
            i += 1;
            continue;
        }

        let is_word_start = i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_';
        if is_word_start {
            let rem = &source[i..];

            // 1. Check for `class` or `export class`
            if rem.starts_with("class ")
                || rem.starts_with("export class ")
                || rem.starts_with("export default class ")
            {
                let decl_start = find_line_start(source, i);
                if let Some((sig, name, body_start, body_end)) = extract_brace_block(source, i) {
                    let (start_line, _) = line_index.line_col(source, decl_start);
                    let (end_line, _) = line_index.line_col(source, body_end);

                    let class_name = name.clone();
                    let current_depth = brace_depth;
                    class_context = Some((class_name.clone(), current_depth + 1));

                    let inner_source = &source[body_start..body_end.saturating_sub(1)];
                    let mut inner_methods = parse_ts_js_inner_methods(
                        inner_source,
                        body_start,
                        &class_name,
                        &line_index,
                    );

                    scopes.push(SymbolScope {
                        name: class_name.clone(),
                        kind: ScopeKind::Class,
                        signature: sig.trim().to_string(),
                        path: vec![class_name],
                        byte_range: decl_start..body_end,
                        line_range: start_line..end_line,
                        children: inner_methods.drain(..).collect(),
                    });

                    i = body_start;
                    continue;
                }
            }

            // 2. Check for `function` or `async function`
            if is_function_keyword(rem) {
                let decl_start = find_line_start(source, i);
                if let Some((sig, name, _, body_end)) = extract_brace_block(source, i) {
                    let (start_line, _) = line_index.line_col(source, decl_start);
                    let (end_line, _) = line_index.line_col(source, body_end);

                    let (kind, path) = if let Some((parent_class, _)) = &class_context {
                        (ScopeKind::Method, vec![parent_class.clone(), name.clone()])
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

            // 3. Check for arrow function assignment e.g. `const foo = (...) => {`
            if is_arrow_fn_decl(rem) {
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

            // 4. Check for `interface`
            if rem.starts_with("interface ") || rem.starts_with("export interface ") {
                let decl_start = find_line_start(source, i);
                if let Some((sig, name, _, body_end)) = extract_brace_block(source, i) {
                    let (start_line, _) = line_index.line_col(source, decl_start);
                    let (end_line, _) = line_index.line_col(source, body_end);

                    scopes.push(SymbolScope {
                        name: name.clone(),
                        kind: ScopeKind::Interface,
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

fn parse_ts_js_inner_methods(
    source: &str,
    offset_base: usize,
    parent_class: &str,
    line_index: &LineIndex,
) -> Vec<SymbolScope> {
    let mut methods = Vec::new();
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        if bytes[i] == b'/' && i + 1 < len && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        let is_word_start = i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_';
        if is_word_start {
            let rem = &source[i..];
            if is_method_signature(rem) {
                let decl_start = find_line_start(source, i);
                if let Some((sig, name, _, body_end)) = extract_brace_block(source, i) {
                    let abs_start = offset_base + decl_start;
                    let abs_end = offset_base + body_end;
                    let (start_line, _) = line_index.line_col(source, abs_start);
                    let (end_line, _) = line_index.line_col(source, abs_end);

                    methods.push(SymbolScope {
                        name: name.clone(),
                        kind: ScopeKind::Method,
                        signature: sig.trim().to_string(),
                        path: vec![parent_class.to_string(), name],
                        byte_range: abs_start..abs_end,
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

    methods
}

fn is_function_keyword(s: &str) -> bool {
    let trimmed = s.trim_start();
    trimmed.starts_with("function ")
        || trimmed.starts_with("export function ")
        || trimmed.starts_with("export default function ")
        || trimmed.starts_with("async function ")
        || trimmed.starts_with("export async function ")
        || trimmed.starts_with("export default async function ")
}

fn is_arrow_fn_decl(s: &str) -> bool {
    let trimmed = s.trim_start();
    if trimmed.starts_with("const ")
        || trimmed.starts_with("let ")
        || trimmed.starts_with("var ")
        || trimmed.starts_with("export const ")
        || trimmed.starts_with("export let ")
    {
        if let Some(arrow_pos) = trimmed.find("=>") {
            if let Some(brace_pos) = trimmed.find('{') {
                return arrow_pos < brace_pos;
            }
        }
    }
    false
}

fn is_method_signature(s: &str) -> bool {
    let trimmed = s.trim_start();
    trimmed.starts_with("public ")
        || trimmed.starts_with("private ")
        || trimmed.starts_with("protected ")
        || trimmed.starts_with("async ")
        || trimmed.starts_with("constructor(")
        || (trimmed.contains('(')
            && trimmed.contains(')')
            && !trimmed.starts_with("if")
            && !trimmed.starts_with("for")
            && !trimmed.starts_with("while")
            && !trimmed.starts_with("switch"))
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
    let name = extract_identifier(&sig_text);

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

fn extract_identifier(sig: &str) -> String {
    for kw in &[
        "class ",
        "function ",
        "interface ",
        "const ",
        "let ",
        "var ",
        "async ",
    ] {
        if let Some(pos) = sig.find(kw) {
            let after = sig[pos + kw.len()..].trim_start();
            let name_end = after
                .find(|c: char| !c.is_alphanumeric() && c != '_')
                .unwrap_or(after.len());
            let candidate = after[..name_end].trim();
            if !candidate.is_empty() && candidate != "function" && candidate != "default" {
                return candidate.to_string();
            }
        }
    }
    // Fallback: look before `(`
    if let Some(paren_pos) = sig.find('(') {
        let before = sig[..paren_pos].trim();
        let words: Vec<&str> = before.split_whitespace().collect();
        if let Some(last_word) = words.last() {
            let clean = last_word.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
            if !clean.is_empty() {
                return clean.to_string();
            }
        }
    }
    "anonymous".to_string()
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
