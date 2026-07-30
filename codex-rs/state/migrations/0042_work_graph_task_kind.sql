ALTER TABLE work_graph_tasks
ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'explore';

ALTER TABLE work_graph_tasks
ADD COLUMN baseline_json TEXT;
