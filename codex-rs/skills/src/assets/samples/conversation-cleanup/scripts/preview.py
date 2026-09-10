#!/usr/bin/env python3
"""Read-only inventory; never classifies or deletes conversations."""
import argparse
import json
from pathlib import Path
import sqlite3
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--older-than-days", type=int, default=0)
    parser.add_argument("--cwd")
    args = parser.parse_args()
    if args.older_than_days < 0:
        parser.error("--older-than-days must be nonnegative")
    db = args.db.resolve(strict=True)
    with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        query = "SELECT id, title, cwd, updated_at, archived FROM threads WHERE updated_at <= ?"
        parameters = [int(time.time()) - args.older_than_days * 86400]
        if args.cwd is not None:
            query += " AND cwd = ?"
            parameters.append(args.cwd)
        query += " ORDER BY updated_at ASC, id ASC"
        rows = [dict(row) for row in connection.execute(query, parameters)]
    print(json.dumps({"count": len(rows), "conversations": rows}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
