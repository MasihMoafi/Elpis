#!/usr/bin/env python3
"""Deterministically score one real Elpis pruning pass against planted markers."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import Any


class ScoreError(RuntimeError):
    pass


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ScoreError(f"cannot read JSON {path}: {exc}") from exc


def load_cases(path: Path) -> list[dict[str, str]]:
    payload = load_json(path)
    if payload.get("schema_version") != 1:
        raise ScoreError("unsupported cases schema_version")
    cases = payload.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ScoreError("cases.json must contain a non-empty cases list")
    required = {"id", "category", "marker", "expected"}
    seen_markers: set[str] = set()
    normalized: list[dict[str, str]] = []
    for index, case in enumerate(cases):
        if not isinstance(case, dict) or not required.issubset(case):
            raise ScoreError(f"case {index} is missing required fields")
        row = {key: str(case[key]) for key in required}
        if row["expected"] not in {"kept", "deleted"}:
            raise ScoreError(f"case {row['id']} has invalid expected decision")
        if row["marker"] in seen_markers:
            raise ScoreError(f"duplicate marker {row['marker']}")
        seen_markers.add(row["marker"])
        normalized.append(row)
    return normalized


def load_artifacts(pass_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = load_json(pass_dir / "manifest.json")
    if manifest.get("schema_version") != 1:
        raise ScoreError(f"unsupported audit schema in {pass_dir}")
    items = manifest.get("items")
    if not isinstance(items, list):
        raise ScoreError(f"manifest has no items list: {pass_dir}")
    artifacts: list[dict[str, Any]] = []
    for item in items:
        relative = item.get("artifact") if isinstance(item, dict) else None
        if not isinstance(relative, str):
            raise ScoreError(f"invalid manifest item in {pass_dir}")
        artifacts.append(load_json(pass_dir / relative))
    return manifest, artifacts


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def markers_present(
    cases: list[dict[str, str]], artifacts: list[dict[str, Any]]
) -> set[str]:
    before = "\n".join(
        json_text(item.get("model_visible_before", [])) for item in artifacts
    )
    return {case["marker"] for case in cases if case["marker"] in before}


def select_pass(
    cases: list[dict[str, str]],
    pass_dir: Path | None,
    passes_dir: Path | None,
) -> Path:
    if pass_dir is not None:
        return pass_dir
    if passes_dir is None:
        raise ScoreError("provide PASS_DIR or --passes-dir")
    if not passes_dir.is_dir():
        raise ScoreError(f"passes directory does not exist: {passes_dir}")
    expected = {case["marker"] for case in cases}
    candidates = sorted(
        (path for path in passes_dir.iterdir() if path.is_dir()), reverse=True
    )
    for candidate in candidates:
        try:
            _, artifacts = load_artifacts(candidate)
        except ScoreError:
            continue
        if markers_present(cases, artifacts) == expected:
            return candidate
    raise ScoreError("no pruning pass contains every planted marker")


def score_pass(cases: list[dict[str, str]], pass_dir: Path) -> dict[str, Any]:
    manifest, artifacts = load_artifacts(pass_dir)
    rows: list[dict[str, Any]] = []
    for case in cases:
        marker = case["marker"]
        matches = [
            artifact
            for artifact in artifacts
            if marker in json_text(artifact.get("model_visible_before", []))
        ]
        if len(matches) != 1:
            rows.append(
                {
                    **case,
                    "actual": "missing" if not matches else "ambiguous",
                    "marker_preserved": False,
                    "passed": False,
                    "call_id": None,
                }
            )
            continue
        artifact = matches[0]
        actual = str(artifact.get("decision", "missing"))
        conclusion = str(artifact.get("conclusion") or "")
        after = json_text(artifact.get("model_visible_after", []))
        preserved = marker in conclusion or marker in after
        if case["expected"] == "kept":
            passed = actual == "kept" and preserved
        else:
            passed = actual == "deleted" and not preserved
        rows.append(
            {
                **case,
                "actual": actual,
                "marker_preserved": preserved,
                "passed": passed,
                "call_id": artifact.get("call_id"),
            }
        )

    categories: dict[str, dict[str, int]] = {}
    for row in rows:
        bucket = categories.setdefault(row["category"], {"passed": 0, "total": 0})
        bucket["total"] += 1
        bucket["passed"] += int(row["passed"])

    passed = sum(int(row["passed"]) for row in rows)
    return {
        "schema_version": 1,
        "pass_id": manifest.get("pass_id", pass_dir.name),
        "pass_dir": str(pass_dir),
        "trigger": manifest.get("trigger"),
        "model": manifest.get("model"),
        "passed": passed,
        "total": len(rows),
        "all_passed": passed == len(rows),
        "categories": categories,
        "cases": rows,
    }


def markdown(result: dict[str, Any]) -> str:
    lines = [
        "# Elpis pruning-safety score",
        "",
        f"Pass: `{result['pass_id']}`  ",
        f"Trigger: `{result.get('trigger')}`  ",
        f"Model: `{result.get('model')}`  ",
        f"Result: **{result['passed']}/{result['total']} passed**",
        "",
        "| Case | Category | Expected | Actual | Exact marker retained | Result |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for row in result["cases"]:
        lines.append(
            "| {id} | {category} | {expected} | {actual} | {marker} | {result} |".format(
                id=row["id"],
                category=row["category"],
                expected=row["expected"],
                actual=row["actual"],
                marker="yes" if row["marker_preserved"] else "no",
                result="PASS" if row["passed"] else "FAIL",
            )
        )
    return "\n".join(lines) + "\n"


def write_fake_pass(
    root: Path, *, keep_marker: str, delete_marker: str
) -> tuple[Path, Path]:
    cases_path = root / "cases.json"
    cases_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "cases": [
                    {
                        "id": "keep",
                        "category": "safety",
                        "marker": keep_marker,
                        "expected": "kept",
                    },
                    {
                        "id": "drop",
                        "category": "dead-end",
                        "marker": delete_marker,
                        "expected": "deleted",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    pass_dir = root / "passes" / "019-test"
    (pass_dir / "items").mkdir(parents=True)
    artifacts = [
        {
            "schema_version": 1,
            "call_id": "keep-call",
            "decision": "kept",
            "conclusion": f"retain {keep_marker}",
            "source_pointer": "rollout://tool-call/keep-call",
            "model_visible_before": [{"output": keep_marker}],
            "model_visible_after": [{"output": keep_marker}],
        },
        {
            "schema_version": 1,
            "call_id": "drop-call",
            "decision": "deleted",
            "conclusion": None,
            "source_pointer": "rollout://tool-call/drop-call",
            "model_visible_before": [{"output": delete_marker}],
            "model_visible_after": [],
        },
    ]
    manifest_items = []
    for index, artifact in enumerate(artifacts):
        name = f"items/{index:03}.json"
        (pass_dir / name).write_text(json.dumps(artifact), encoding="utf-8")
        manifest_items.append(
            {
                "call_id": artifact["call_id"],
                "decision": artifact["decision"],
                "conclusion": artifact["conclusion"],
                "artifact": name,
            }
        )
    (pass_dir / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "pass_id": "019-test",
                "timestamp": "2026-08-04T00:00:00Z",
                "trigger": "manual",
                "model": "test-model",
                "saved_chars": 10,
                "ace_conversation": "ace.json",
                "items": manifest_items,
            }
        ),
        encoding="utf-8",
    )
    return cases_path, pass_dir


def self_test() -> int:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        cases_path, pass_dir = write_fake_pass(
            root,
            keep_marker="SAFETY_SELF_TEST_KEEP",
            delete_marker="DEAD_END_SELF_TEST_DROP",
        )
        cases = load_cases(cases_path)
        result = score_pass(cases, pass_dir)
        if not result["all_passed"]:
            print(markdown(result), file=sys.stderr)
            return 1
    print("pruning-safety scorer self-test passed")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Score a real Elpis pruning audit pass against exact planted markers."
    )
    parser.add_argument("cases", type=Path, nargs="?", help="cases.json codebook")
    parser.add_argument(
        "pass_dir", type=Path, nargs="?", help="one immutable pass directory"
    )
    parser.add_argument(
        "--passes-dir",
        type=Path,
        help="select the newest pass containing all markers",
    )
    parser.add_argument(
        "--json-out", type=Path, help="write complete machine-readable results"
    )
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        return self_test()
    if args.cases is None:
        print("error: cases.json is required", file=sys.stderr)
        return 2
    if args.pass_dir is not None and args.passes_dir is not None:
        print("error: use PASS_DIR or --passes-dir, not both", file=sys.stderr)
        return 2
    try:
        cases = load_cases(args.cases)
        pass_dir = select_pass(cases, args.pass_dir, args.passes_dir)
        result = score_pass(cases, pass_dir)
    except ScoreError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(markdown(result), end="")
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(
            json.dumps(result, indent=2) + "\n", encoding="utf-8"
        )
    return 0 if result["all_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
