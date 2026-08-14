use super::{ScopeKind, SymbolScope};
use crate::displacement::LineIndex;

pub fn parse_python_scopes(source: &str) -> Vec<SymbolScope> {
    let line_index = LineIndex::new(source);
    let lines: Vec<&str> = source.lines().collect();
    let mut scopes = Vec::new();

    let mut in_multiline_str = false;
    let mut str_delimiter = "";

    // Stack to track active scopes: (indent_level, is_class, name, start_line, start_byte, sig, children)
    struct ActiveScope {
        indent: usize,
        kind: ScopeKind,
        name: String,
        signature: String,
        path: Vec<String>,
        start_line: usize,
        start_byte: usize,
        children: Vec<SymbolScope>,
    }

    let mut stack: Vec<ActiveScope> = Vec::new();

    for (idx, &line) in lines.iter().enumerate() {
        let line_num = idx + 1;
        let line_range = line_index.line_byte_range(line_num);
        let trimmed = line.trim();

        // Handle multiline string literals
        if in_multiline_str {
            if line.contains(str_delimiter) {
                in_multiline_str = false;
            }
            continue;
        }

        if trimmed.starts_with("\"\"\"") || trimmed.starts_with("'''") {
            let delim = &trimmed[..3];
            let after = &trimmed[3..];
            if !after.contains(delim) {
                in_multiline_str = true;
                str_delimiter = delim;
            }
            continue;
        }

        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let indent = line.len() - line.trim_start().len();

        // Pop scopes that have closed because current line has <= their indentation
        while let Some(top) = stack.last() {
            if indent <= top.indent {
                let popped = stack.pop().unwrap();
                let mut end_line = line_num.saturating_sub(1);
                while end_line > popped.start_line
                    && lines
                        .get(end_line - 1)
                        .map(|l| l.trim().is_empty())
                        .unwrap_or(false)
                {
                    end_line -= 1;
                }
                let end_byte = line_index.line_byte_range(end_line).end;

                let scope = SymbolScope {
                    name: popped.name,
                    kind: popped.kind,
                    signature: popped.signature,
                    path: popped.path,
                    byte_range: popped.start_byte..end_byte,
                    line_range: popped.start_line..end_line.max(popped.start_line),
                    children: popped.children,
                };

                if let Some(parent) = stack.last_mut() {
                    parent.children.push(scope);
                } else {
                    scopes.push(scope);
                }
            } else {
                break;
            }
        }

        // Check for `class ` or `def ` or `async def `
        let is_class = trimmed.starts_with("class ");
        let is_def = trimmed.starts_with("def ") || trimmed.starts_with("async def ");

        if is_class || is_def {
            let (kind, name) = if is_class {
                let after = &trimmed[6..];
                let name_end = after
                    .find(|c: char| !c.is_alphanumeric() && c != '_')
                    .unwrap_or(after.len());
                (ScopeKind::Class, after[..name_end].to_string())
            } else {
                let kw_len = if trimmed.starts_with("async def ") { 10 } else { 4 };
                let after = &trimmed[kw_len..];
                let name_end = after
                    .find(|c: char| !c.is_alphanumeric() && c != '_')
                    .unwrap_or(after.len());
                let kind = if stack.iter().any(|s| s.kind == ScopeKind::Class) {
                    ScopeKind::Method
                } else {
                    ScopeKind::Function
                };
                (kind, after[..name_end].to_string())
            };

            let mut path: Vec<String> = stack.iter().map(|s| s.name.clone()).collect();
            path.push(name.clone());

            stack.push(ActiveScope {
                indent,
                kind,
                name,
                signature: trimmed.to_string(),
                path,
                start_line: line_num,
                start_byte: line_range.start,
                children: Vec::new(),
            });
        }
    }

    // Flush remaining open scopes on stack
    let total_lines = line_index.total_lines();
    let total_bytes = source.len();

    while let Some(popped) = stack.pop() {
        let mut end_line = total_lines;
        while end_line > popped.start_line
            && lines
                .get(end_line - 1)
                .map(|l| l.trim().is_empty())
                .unwrap_or(false)
        {
            end_line -= 1;
        }

        let scope = SymbolScope {
            name: popped.name,
            kind: popped.kind,
            signature: popped.signature,
            path: popped.path,
            byte_range: popped.start_byte..total_bytes,
            line_range: popped.start_line..end_line.max(popped.start_line),
            children: popped.children,
        };

        if let Some(parent) = stack.last_mut() {
            parent.children.push(scope);
        } else {
            scopes.push(scope);
        }
    }

    scopes
}
