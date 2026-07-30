-- A recall is one distinct retrieval context on one day, not one tool call.
-- Keying only on (thread_id, query_key) meant a memory retrieved by the same
-- question on ten different days counted once, while ten calls inside one turn
-- counted ten times. Adding the day bucket to the key inverts both.
CREATE TABLE stage1_recall_queries_next (
    thread_id TEXT NOT NULL,
    query_key TEXT NOT NULL,
    day_bucket TEXT NOT NULL,
    recalled_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, query_key, day_bucket),
    FOREIGN KEY (thread_id) REFERENCES stage1_outputs(thread_id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO stage1_recall_queries_next (thread_id, query_key, day_bucket, recalled_at)
SELECT thread_id, query_key, date(recalled_at, 'unixepoch'), recalled_at
FROM stage1_recall_queries;

DROP TABLE stage1_recall_queries;

ALTER TABLE stage1_recall_queries_next RENAME TO stage1_recall_queries;

CREATE INDEX idx_stage1_recall_queries_thread_id
ON stage1_recall_queries(thread_id);
