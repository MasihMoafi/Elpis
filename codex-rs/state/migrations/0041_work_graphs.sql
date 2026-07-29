CREATE TABLE work_graphs (
    id TEXT PRIMARY KEY,
    root_thread_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    max_concurrency INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    last_error TEXT
);

CREATE TABLE work_graph_tasks (
    graph_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    title TEXT NOT NULL,
    instruction TEXT NOT NULL,
    status TEXT NOT NULL,
    write_scopes_json TEXT NOT NULL,
    acceptance_criteria_json TEXT NOT NULL,
    environment_id TEXT,
    workspace_path TEXT,
    assigned_thread_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    evidence_json TEXT,
    failure_reason TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    PRIMARY KEY (graph_id, task_id),
    FOREIGN KEY (graph_id) REFERENCES work_graphs(id) ON DELETE CASCADE
);

CREATE TABLE work_graph_dependencies (
    graph_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    depends_on_task_id TEXT NOT NULL,
    PRIMARY KEY (graph_id, task_id, depends_on_task_id),
    FOREIGN KEY (graph_id, task_id)
        REFERENCES work_graph_tasks(graph_id, task_id) ON DELETE CASCADE,
    FOREIGN KEY (graph_id, depends_on_task_id)
        REFERENCES work_graph_tasks(graph_id, task_id) ON DELETE CASCADE
);

CREATE TABLE work_graph_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    graph_id TEXT NOT NULL,
    task_id TEXT,
    event_type TEXT NOT NULL,
    payload_json TEXT,
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY (graph_id) REFERENCES work_graphs(id) ON DELETE CASCADE
);

CREATE INDEX idx_work_graphs_status
    ON work_graphs(status, updated_at_ms DESC);
CREATE INDEX idx_work_graph_tasks_status
    ON work_graph_tasks(graph_id, status, ordinal ASC, task_id ASC);
CREATE INDEX idx_work_graph_dependencies_prerequisite
    ON work_graph_dependencies(graph_id, depends_on_task_id);
CREATE INDEX idx_work_graph_events_graph
    ON work_graph_events(graph_id, sequence ASC);
