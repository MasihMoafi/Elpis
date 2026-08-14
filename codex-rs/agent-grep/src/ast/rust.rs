use super::{ScopeKind, SymbolScope};
use crate::displacement::LineIndex;

pub fn parse_rust_scopes(source: &str) -> Vec<SymbolScope> {
    let line_index = LineIndex::new(source);
    let mut scopes = Vec::new();
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    let mut impl_context: Option<(String, usize)> = None; // (impl_target_name, brace_depth)
    let mut brace_depth = 0;

    while i < len {
        // Skip comments and string literals
        if bytes[i] == b'/' && i + 1 < len && bytes[i + 1] == b'/' {
            // Line comment
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i] == b'/' && i + 1 < len && bytes[i + 1] == b'*' {
            // Block comment
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(len);
            continue;
        }
        if bytes[i] == b'"' {
            // String literal
            i += 1;
            while i < len {
                if bytes[i] == b'\\' {
                    i += 2;
                } else if bytes[i] == b'"' {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if bytes[i] == b'\'' {
            // Char literal or lifetime
            if i + 2 < len && bytes[i + 2] == b'\'' {
                i += 3;
                continue;
            }
            if i + 3 < len && bytes[i + 1] == b'\\' && bytes[i + 3] == b'\'' {
                i += 4;
                continue;
            }
        }

        if bytes[i] == b'{' {
            brace_depth += 1;
            i += 1;
            continue;
        } else if bytes[i] == b'}' {
            if let Some((_, depth)) = &impl_context {
                if brace_depth <= *depth {
                    impl_context = None;
                }
            }
            brace_depth = brace_depth.saturating_sub(1);
            i += 1;
            continue;
        }

        // Only check keyword on non-whitespace word starts
        if !bytes[i].is_ascii_whitespace() {
            let is_word_start = i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_';
            if is_word_start {
                let rem = &source[i..];

                // 1. Check for `impl`
                if rem.starts_with("impl") && is_keyword(source, i, 4) {
                    let decl_start = find_line_start(source, i);
                    if let Some((sig, name, body_start, body_end)) = extract_brace_block(source, i) {
                        let (start_line, _) = line_index.line_col(source, decl_start);
                        let (end_line, _) = line_index.line_col(source, body_end.saturating_sub(1));

                        let target_name = extract_impl_target(&sig).unwrap_or(name);
                        let current_depth = brace_depth;
                        impl_context = Some((target_name.clone(), current_depth + 1));

                        // Parse inner methods inside the impl block
                        let inner_source = &source[body_start..body_end.saturating_sub(1)];
                        let mut inner_methods = parse_rust_inner_methods(
                            inner_source,
                            body_start,
                            &target_name,
                            &line_index,
                        );

                        scopes.push(SymbolScope {
                            name: target_name.clone(),
                            kind: ScopeKind::Impl,
                            signature: sig.trim().to_string(),
                            path: vec![target_name],
                            byte_range: decl_start..body_end,
                            line_range: start_line..end_line,
                            children: inner_methods.drain(..).collect(),
                        });

                        i = body_start;
                        continue;
                    }
                }

                // 2. Check for `fn` or `pub ... fn` or `async fn`
                if is_fn_declaration(rem) {
                    let decl_start = find_line_start(source, i);
                    if let Some((sig, name, _body_start, body_end)) = extract_brace_block(source, i) {
                        let (start_line, _) = line_index.line_col(source, decl_start);
                        let (end_line, _) = line_index.line_col(source, body_end.saturating_sub(1));

                        let (kind, path) = if let Some((parent_impl, _)) = &impl_context {
                            (ScopeKind::Method, vec![parent_impl.clone(), name.clone()])
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

                // 3. Check for `struct`, `enum`, `trait`
                if (rem.starts_with("struct") && is_keyword(source, i, 6))
                    || (rem.starts_with("pub struct") && is_keyword(source, i, 10))
                    || (rem.starts_with("enum") && is_keyword(source, i, 4))
                    || (rem.starts_with("pub enum") && is_keyword(source, i, 8))
                    || (rem.starts_with("trait") && is_keyword(source, i, 5))
                    || (rem.starts_with("pub trait") && is_keyword(source, i, 9))
                {
                    let decl_start = find_line_start(source, i);
                    let (kind, _kw_len) = if rem.contains("struct") {
                        (ScopeKind::Struct, 6)
                    } else if rem.contains("enum") {
                        (ScopeKind::Enum, 4)
                    } else {
                        (ScopeKind::Trait, 5)
                    };

                    if let Some((sig, name, _, body_end)) = extract_brace_block(source, i) {
                        let (start_line, _) = line_index.line_col(source, decl_start);
                        let (end_line, _) = line_index.line_col(source, body_end.saturating_sub(1));

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
                    } else {
                        // Check semicolon struct e.g. `struct Unit;`
                        if let Some(semi_pos) = rem.find(';') {
                            let end_pos = i + semi_pos + 1;
                            let line_end = find_line_end(source, end_pos);
                            let (start_line, _) = line_index.line_col(source, decl_start);
                            let (end_line, _) = line_index.line_col(source, line_end);
                            let sig_text = &source[decl_start..end_pos];
                            let name = extract_ident_after_keyword(sig_text, kind_str(kind));

                            scopes.push(SymbolScope {
                                name: name.clone(),
                                kind,
                                signature: sig_text.trim().to_string(),
                                path: vec![name],
                                byte_range: decl_start..line_end,
                                line_range: start_line..end_line,
                                children: Vec::new(),
                            });

                            i = line_end;
                            continue;
                        }
                    }
                }
            }
        }

        i += 1;
    }

    scopes
}

fn parse_rust_inner_methods(
    source: &str,
    offset_base: usize,
    parent_name: &str,
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

        if !bytes[i].is_ascii_whitespace() {
            let is_word_start = i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_';
            if is_word_start && is_fn_declaration(&source[i..]) {
                let decl_start = find_line_start(source, i);
                if let Some((sig, name, _, body_end)) = extract_brace_block(source, i) {
                    let abs_start = offset_base + decl_start;
                    let abs_end = offset_base + body_end;
                    let (start_line, _) = line_index.line_col(source, abs_start);
                    let (end_line, _) = line_index.line_col(source, abs_end.saturating_sub(1));

                    methods.push(SymbolScope {
                        name: name.clone(),
                        kind: ScopeKind::Method,
                        signature: sig.trim().to_string(),
                        path: vec![parent_name.to_string(), name],
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

fn is_keyword(source: &str, offset: usize, len: usize) -> bool {
    let bytes = source.as_bytes();
    let end = offset + len;
    if end >= bytes.len() {
        return true;
    }
    !bytes[end].is_ascii_alphanumeric() && bytes[end] != b'_'
}

fn is_fn_declaration(s: &str) -> bool {
    let trimmed = s.trim_start_matches(|c: char| c == ' ' || c == '\t');
    trimmed.starts_with("fn ")
        || trimmed.starts_with("pub fn ")
        || trimmed.starts_with("pub async fn ")
        || trimmed.starts_with("async fn ")
        || trimmed.starts_with("pub const fn ")
        || trimmed.starts_with("const fn ")
        || trimmed.starts_with("pub unsafe fn ")
        || trimmed.starts_with("unsafe fn ")
        || trimmed.starts_with("pub(crate) fn ")
        || trimmed.starts_with("pub(crate) async fn ")
}

fn kind_str(kind: ScopeKind) -> &'static str {
    match kind {
        ScopeKind::Struct => "struct",
        ScopeKind::Enum => "enum",
        ScopeKind::Trait => "trait",
        _ => "",
    }
}

fn extract_ident_after_keyword(sig: &str, kw: &str) -> String {
    if let Some(pos) = sig.find(kw) {
        let after = &sig[pos + kw.len()..].trim_start();
        let name_end = after
            .find(|c: char| !c.is_alphanumeric() && c != '_')
            .unwrap_or(after.len());
        after[..name_end].to_string()
    } else {
        "unknown".to_string()
    }
}

fn extract_impl_target(sig: &str) -> Option<String> {
    let clean = sig.replace('{', "");
    let trimmed = clean.trim();
    if let Some(for_pos) = trimmed.find(" for ") {
        let target = &trimmed[for_pos + 5..].trim();
        let target_end = target
            .find(|c: char| !c.is_alphanumeric() && c != '_')
            .unwrap_or(target.len());
        Some(target[..target_end].to_string())
    } else if let Some(impl_pos) = trimmed.find("impl") {
        let after = &trimmed[impl_pos + 4..].trim_start();
        let after_generics = if after.starts_with('<') {
            if let Some(close) = after.find('>') {
                after[close + 1..].trim_start()
            } else {
                after
            }
        } else {
            after
        };
        let target_end = after_generics
            .find(|c: char| !c.is_alphanumeric() && c != '_')
            .unwrap_or(after_generics.len());
        Some(after_generics[..target_end].to_string())
    } else {
        None
    }
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
    let name = extract_fn_or_type_name(&sig_text);

    let mut depth = 1;
    let mut curr = b_start + 1;
    while curr < len && depth > 0 {
        if bytes[curr] == b'{' {
            depth += 1;
        } else if bytes[curr] == b'}' {
            depth -= 1;
        } else if bytes[curr] == b'"' {
            curr += 1;
            while curr < len {
                if bytes[curr] == b'\\' {
                    curr += 2;
                } else if bytes[curr] == b'"' {
                    break;
                } else {
                    curr += 1;
                }
            }
        }
        curr += 1;
    }

    let b_end = curr;
    let line_end = find_line_end(source, b_end);
    Some((sig_text, name, b_start + 1, line_end))
}

fn extract_fn_or_type_name(sig: &str) -> String {
    for kw in &["fn ", "struct ", "enum ", "trait ", "impl "] {
        if let Some(pos) = sig.find(kw) {
            let after = sig[pos + kw.len()..].trim_start();
            let after = if after.starts_with('<') {
                if let Some(c) = after.find('>') {
                    after[c + 1..].trim_start()
                } else {
                    after
                }
            } else {
                after
            };
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
