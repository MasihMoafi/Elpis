use serde::{Deserialize, Serialize};
use std::path::Path;

mod bash;
mod cpp;
mod go;
mod python;
mod rust;
mod ts_js;
mod universal;

/// Supported programming languages for AST/structure analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    Rust,
    Python,
    TypeScript,
    JavaScript,
    Go,
    Cpp,
    C,
    Bash,
    Java,
    Ruby,
    Unknown,
}

impl Language {
    /// Detects the language from a file path or extension.
    pub fn from_path(path: &Path) -> Self {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        match ext.as_str() {
            "rs" => Language::Rust,
            "py" | "pyi" => Language::Python,
            "ts" | "tsx" | "mts" | "cts" => Language::TypeScript,
            "js" | "jsx" | "mjs" | "cjs" => Language::JavaScript,
            "go" => Language::Go,
            "cpp" | "cc" | "cxx" | "hpp" | "hxx" => Language::Cpp,
            "c" | "h" => Language::C,
            "sh" | "bash" | "zsh" => Language::Bash,
            "java" => Language::Java,
            "rb" => Language::Ruby,
            _ => {
                let file_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if file_name == "bashrc" || file_name == "zshrc" || file_name.ends_with(".sh") {
                    Language::Bash
                } else {
                    Language::Unknown
                }
            }
        }
    }
}

/// The kind of structural code scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    Function,
    Method,
    Class,
    Struct,
    Trait,
    Impl,
    Module,
    Enum,
    Interface,
    TypeAlias,
    Namespace,
    Block,
}

/// An extracted AST / structural scope in the source file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolScope {
    /// Identifier / name of the symbol (e.g. `handle_request`, `UserManager`).
    pub name: String,
    /// Kind of scope (function, method, class, struct, etc.).
    pub kind: ScopeKind,
    /// Extracted signature / declaration line(s).
    pub signature: String,
    /// Hierarchical path from root enclosing symbols (e.g. `["UserManager", "authenticate"]`).
    pub path: Vec<String>,
    /// Byte range in the source file `[start_byte, end_byte]`.
    pub byte_range: std::ops::Range<usize>,
    /// 1-indexed line range in the source file `[start_line, end_line]`.
    pub line_range: std::ops::Range<usize>,
    /// Nested child scopes.
    pub children: Vec<SymbolScope>,
}

/// AST structural context extractor.
#[derive(Debug, Clone)]
pub struct AstContextExtractor {
    pub language: Language,
}

impl AstContextExtractor {
    pub fn new(language: Language) -> Self {
        Self { language }
    }

    /// Extracts all structural symbol scopes from the source code.
    pub fn extract_scopes(&self, source: &str) -> Vec<SymbolScope> {
        match self.language {
            Language::Rust => rust::parse_rust_scopes(source),
            Language::Python => python::parse_python_scopes(source),
            Language::TypeScript | Language::JavaScript => ts_js::parse_ts_js_scopes(source),
            Language::Go => go::parse_go_scopes(source),
            Language::Cpp | Language::C => cpp::parse_cpp_scopes(source),
            Language::Bash => bash::parse_bash_scopes(source),
            Language::Java | Language::Ruby | Language::Unknown => {
                universal::parse_universal_scopes(source)
            }
        }
    }

    /// Locates the deepest enclosing scope containing the given byte offset.
    pub fn find_enclosing_scope<'a>(
        &self,
        scopes: &'a [SymbolScope],
        byte_offset: usize,
    ) -> Option<&'a SymbolScope> {
        for scope in scopes {
            if scope.byte_range.contains(&byte_offset) || (byte_offset == scope.byte_range.end && byte_offset > scope.byte_range.start) {
                // Check if any child scope is more specific
                if let Some(child) = self.find_enclosing_scope(&scope.children, byte_offset) {
                    return Some(child);
                }
                return Some(scope);
            }
        }
        None
    }

    /// Returns the full hierarchy chain of enclosing scopes from outermost to innermost.
    pub fn find_scope_hierarchy<'a>(
        &self,
        scopes: &'a [SymbolScope],
        byte_offset: usize,
    ) -> Vec<&'a SymbolScope> {
        let mut hierarchy = Vec::new();
        self.collect_hierarchy(scopes, byte_offset, &mut hierarchy);
        hierarchy
    }

    fn collect_hierarchy<'a>(
        &self,
        scopes: &'a [SymbolScope],
        byte_offset: usize,
        hierarchy: &mut Vec<&'a SymbolScope>,
    ) {
        for scope in scopes {
            if scope.byte_range.contains(&byte_offset) || (byte_offset == scope.byte_range.end && byte_offset > scope.byte_range.start) {
                hierarchy.push(scope);
                self.collect_hierarchy(&scope.children, byte_offset, hierarchy);
                break;
            }
        }
    }
}
