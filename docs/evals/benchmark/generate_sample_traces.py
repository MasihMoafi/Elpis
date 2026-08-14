"""Script to generate realistic canonical rollout traces for the benchmark test suite."""
import json
import os

SAMPLE_DIR = os.path.join(os.path.dirname(__file__), "sample_traces")
os.makedirs(SAMPLE_DIR, exist_ok=True)

def generate_sample_trace(filename: str, system: str, num_turns: int = 6, with_prunes: bool = True):
    filepath = os.path.join(SAMPLE_DIR, filename)
    window = 258400
    
    # State tracking
    total_input = 0
    total_cached = 0
    total_output = 0
    used_context = 15000
    
    lines = []
    
    # Initial AGENTS.md preamble
    lines.append({
        "timestamp": "2026-08-14T10:00:00.000Z",
        "type": "response_item",
        "payload": {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "# AGENTS.md instructions\nFollow guidelines."}]
        }
    })
    
    for turn in range(1, num_turns + 1):
        turn_prompt = f"Benchmark turn {turn}: Execute AST transformation and verification."
        lines.append({
            "timestamp": f"2026-08-14T10:0{turn}:00.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": turn_prompt}]
            }
        })
        
        # Tool call
        lines.append({
            "timestamp": f"2026-08-14T10:0{turn}:05.000Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "edit_file",
                "call_id": f"call_{turn}_001"
            }
        })
        
        # Determine context growth and caching
        if system == "elpis":
            # Context stays controlled around 20%-30%
            if with_prunes and turn in (3, 5):
                # Trigger pressure prune cycle
                lines.append({
                    "timestamp": f"2026-08-14T10:0{turn}:10.000Z",
                    "type": "compacted",
                    "payload": {
                        "message": f"elpis.context-prune.v1:{used_context - 45000}",
                        "window_number": 1
                    }
                })
                lines.append({
                    "timestamp": f"2026-08-14T10:0{turn}:11.000Z",
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "developer",
                        "content": [{"type": "input_text", "text": f"[elpis.context-prune.epoch {turn//2}] sealed boundary"}]
                    }
                })
                used_context = 45000 # reduced from peak
            else:
                used_context += 12000
                
            input_delta = used_context
            cached_delta = round(input_delta * (0.85 if turn > 1 else 0.0))
        else:
            # Codex context climbs monotonically until compaction at ~90%
            used_context += 42000
            if used_context > 230000 and turn >= 5:
                lines.append({
                    "timestamp": f"2026-08-14T10:0{turn}:10.000Z",
                    "type": "compacted",
                    "payload": {
                        "message": "summary compaction",
                        "window_number": 2
                    }
                })
                used_context = 40000
            input_delta = used_context
            cached_delta = round(input_delta * (0.90 if turn > 1 else 0.0))
            
        output_delta = 450
        total_input += input_delta
        total_cached += cached_delta
        total_output += output_delta
        
        lines.append({
            "timestamp": f"2026-08-14T10:0{turn}:15.000Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": total_input,
                        "cached_input_tokens": total_cached,
                        "output_tokens": total_output,
                        "cache_write_tokens": 1200 if turn == 1 else 0
                    },
                    "last_token_usage": {
                        "input_tokens": input_delta,
                        "cached_input_tokens": cached_delta,
                        "output_tokens": output_delta,
                        "total_tokens": used_context
                    },
                    "model_context_window": window
                }
            }
        })
        
    with open(filepath, "w") as fh:
        for item in lines:
            fh.write(json.dumps(item) + "\n")
    print(f"Generated {filepath} ({len(lines)} records)")

if __name__ == "__main__":
    generate_sample_trace("task1_elpis_trace.jsonl", "elpis", num_turns=6, with_prunes=True)
    generate_sample_trace("task1_codex_trace.jsonl", "codex", num_turns=6, with_prunes=False)
    generate_sample_trace("task2_cache_persistence_trace.jsonl", "elpis", num_turns=8, with_prunes=True)
    generate_sample_trace("task3_agent_grep_trace.jsonl", "elpis", num_turns=4, with_prunes=False)
