use codex_agent_grep::ast::{AstContextExtractor, Language, ScopeKind};
use codex_agent_grep::displacement::LineIndex;
use pretty_assertions::assert_eq;

#[test]
fn test_rust_function_context_and_displacement() {
    let source = r#"// A Rust module
use std::collections::HashMap;

pub struct Config {
    pub timeout: u64,
}

pub async fn handle_request(req_id: &str, config: &Config) -> Result<String, String> {
    let prefix = "REQ_";
    let formatted = format!("{}{}", prefix, req_id);
    if config.timeout > 100 {
        return Ok(formatted);
    }
    Err("timeout too low".to_string())
}

fn helper() {
    println!("done");
}
"#;

    let line_index = LineIndex::new(source);
    let extractor = AstContextExtractor::new(Language::Rust);
    let scopes = extractor.extract_scopes(source);

    // Verify handle_request was parsed
    let req_pos = source.find("formatted = format!").expect("find query in source");
    let disp = line_index.displacement_for_span(req_pos, "formatted".len());

    assert_eq!(disp.start_line, 10);
    assert_eq!(disp.end_line, 10);
    assert_eq!(disp.start_col, 9);
    assert_eq!(disp.byte_offset, req_pos);
    assert_eq!(disp.byte_len, "formatted".len());

    // Find enclosing scope
    let enclosing = extractor.find_enclosing_scope(&scopes, req_pos).expect("enclosing scope");
    assert_eq!(enclosing.name, "handle_request");
    assert_eq!(enclosing.kind, ScopeKind::Function);
    assert!(enclosing.signature.contains("pub async fn handle_request(req_id: &str, config: &Config) -> Result<String, String>"));
    assert_eq!(enclosing.line_range.start, 8);
    assert_eq!(enclosing.line_range.end, 15);
}

#[test]
fn test_rust_impl_method_hierarchy_and_struct() {
    let source = r#"pub struct UserManager {
    db_url: String,
}

impl UserManager {
    pub fn new(db_url: String) -> Self {
        Self { db_url }
    }

    pub async fn authenticate(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        true
    }
}
"#;

    let extractor = AstContextExtractor::new(Language::Rust);
    let scopes = extractor.extract_scopes(source);

    let auth_pos = source.find("token.is_empty()").expect("find in source");
    let enclosing = extractor.find_enclosing_scope(&scopes, auth_pos).expect("enclosing scope");

    assert_eq!(enclosing.name, "authenticate");
    assert_eq!(enclosing.kind, ScopeKind::Method);
    assert_eq!(enclosing.path, vec!["UserManager", "authenticate"]);
    assert!(enclosing.signature.contains("pub async fn authenticate(&self, token: &str) -> bool"));
    assert_eq!(enclosing.line_range.start, 10);
    assert_eq!(enclosing.line_range.end, 15);

    // Test struct scope
    let struct_pos = source.find("db_url: String").expect("find struct field");
    let struct_scope = extractor.find_enclosing_scope(&scopes, struct_pos).expect("struct scope");
    assert_eq!(struct_scope.name, "UserManager");
    assert_eq!(struct_scope.kind, ScopeKind::Struct);
    assert_eq!(struct_scope.line_range.start, 1);
    assert_eq!(struct_scope.line_range.end, 3);
}

#[test]
fn test_python_class_and_method_context() {
    let source = r#"import os
import sys

class DataPipeline:
    """A data ingestion pipeline."""
    def __init__(self, name: str):
        self.name = name

    async def process_records(self, records: list) -> int:
        valid_count = 0
        for r in records:
            if r.get("active"):
                valid_count += 1
        return valid_count

def standalone_task():
    return 42
"#;

    let extractor = AstContextExtractor::new(Language::Python);
    let scopes = extractor.extract_scopes(source);

    let query_pos = source.find("valid_count += 1").expect("find target");
    let enclosing = extractor.find_enclosing_scope(&scopes, query_pos).expect("enclosing scope");

    assert_eq!(enclosing.name, "process_records");
    assert_eq!(enclosing.kind, ScopeKind::Method);
    assert_eq!(enclosing.path, vec!["DataPipeline", "process_records"]);
    assert!(enclosing.signature.contains("async def process_records(self, records: list) -> int:"));
    assert_eq!(enclosing.line_range.start, 9);
    assert_eq!(enclosing.line_range.end, 14);

    let top_func_pos = source.find("return 42").expect("find in standalone_task");
    let top_scope = extractor.find_enclosing_scope(&scopes, top_func_pos).expect("standalone scope");
    assert_eq!(top_scope.name, "standalone_task");
    assert_eq!(top_scope.kind, ScopeKind::Function);
    assert_eq!(top_scope.path, vec!["standalone_task"]);
}

#[test]
fn test_typescript_classes_and_arrow_functions() {
    let source = r#"export interface RequestOptions {
    retries: number;
}

export class ApiClient {
    private endpoint: string;

    constructor(endpoint: string) {
        this.endpoint = endpoint;
    }

    public async executeQuery<T>(query: string): Promise<T> {
        const payload = JSON.stringify({ query });
        return fetch(this.endpoint, { body: payload });
    }
}

export const formatResponse = (raw: any): string => {
    return `Response: ${JSON.stringify(raw)}`;
};
"#;

    let extractor = AstContextExtractor::new(Language::TypeScript);
    let scopes = extractor.extract_scopes(source);

    let query_pos = source.find("JSON.stringify({ query })").expect("find in method");
    let enclosing = extractor.find_enclosing_scope(&scopes, query_pos).expect("method scope");

    assert_eq!(enclosing.name, "executeQuery");
    assert_eq!(enclosing.kind, ScopeKind::Method);
    assert_eq!(enclosing.path, vec!["ApiClient", "executeQuery"]);
    assert!(enclosing.signature.contains("public async executeQuery<T>(query: string): Promise<T>"));

    let arrow_pos = source.find("Response: ${JSON.stringify").expect("find in arrow");
    let arrow_scope = extractor.find_enclosing_scope(&scopes, arrow_pos).expect("arrow scope");
    assert_eq!(arrow_scope.name, "formatResponse");
    assert_eq!(arrow_scope.kind, ScopeKind::Function);
}

#[test]
fn test_go_functions_and_methods() {
    let source = r#"package main

import "fmt"

type Service struct {
    port int
}

func (s *Service) StartServer() error {
    fmt.Printf("Listening on %d\n", s.port)
    return nil
}

func CalculateChecksum(data []byte) uint32 {
    var sum uint32 = 0
    for _, b := range data {
        sum += uint32(b)
    }
    return sum
}
"#;

    let extractor = AstContextExtractor::new(Language::Go);
    let scopes = extractor.extract_scopes(source);

    let method_pos = source.find("Listening on").expect("find in method");
    let method_scope = extractor.find_enclosing_scope(&scopes, method_pos).expect("method scope");
    assert_eq!(method_scope.name, "StartServer");
    assert_eq!(method_scope.kind, ScopeKind::Method);
    assert_eq!(method_scope.path, vec!["Service", "StartServer"]);
    assert!(method_scope.signature.contains("func (s *Service) StartServer() error"));

    let func_pos = source.find("sum += uint32(b)").expect("find in func");
    let func_scope = extractor.find_enclosing_scope(&scopes, func_pos).expect("func scope");
    assert_eq!(func_scope.name, "CalculateChecksum");
    assert_eq!(func_scope.kind, ScopeKind::Function);
}

#[test]
fn test_bash_functions() {
    let source = r#"#!/usr/bin/env bash

set -euo pipefail

function deploy_service() {
    local target="$1"
    echo "Deploying to ${target}..."
    ssh "${target}" "docker compose up -d"
}

cleanup_tmp() {
    rm -rf /tmp/build-*
}
"#;

    let extractor = AstContextExtractor::new(Language::Bash);
    let scopes = extractor.extract_scopes(source);

    let deploy_pos = source.find("docker compose up -d").expect("find deploy");
    let deploy_scope = extractor.find_enclosing_scope(&scopes, deploy_pos).expect("deploy scope");
    assert_eq!(deploy_scope.name, "deploy_service");
    assert_eq!(deploy_scope.kind, ScopeKind::Function);

    let cleanup_pos = source.find("rm -rf /tmp/build").expect("find cleanup");
    let cleanup_scope = extractor.find_enclosing_scope(&scopes, cleanup_pos).expect("cleanup scope");
    assert_eq!(cleanup_scope.name, "cleanup_tmp");
    assert_eq!(cleanup_scope.kind, ScopeKind::Function);
}

#[test]
fn test_cpp_class_and_functions() {
    let source = r#"#include <iostream>
#include <string>

namespace Engine {
    class PhysicsSimulator {
    public:
        void update(double delta_time) {
            double step = delta_time * 1.5;
            std::cout << "Step: " << step << std::endl;
        }
    };
}
"#;

    let extractor = AstContextExtractor::new(Language::Cpp);
    let scopes = extractor.extract_scopes(source);

    let pos = source.find("delta_time * 1.5").expect("find in cpp");
    let scope = extractor.find_enclosing_scope(&scopes, pos).expect("cpp scope");
    assert_eq!(scope.name, "update");
    assert_eq!(scope.kind, ScopeKind::Method);
    assert_eq!(scope.path, vec!["PhysicsSimulator", "update"]);
}
