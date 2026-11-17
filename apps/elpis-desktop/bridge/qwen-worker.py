"""Adapt the installed Read Aloud GPU generator to Elpis's streaming audio pipe."""
import base64
import contextlib
import ctypes
import json
import os
import signal
import sys
import queue
import threading

owner = os.getppid()
if ctypes.CDLL(None).prctl(1, signal.SIGTERM, 0, 0, 0) != 0 or os.getppid() != owner:
    sys.exit(1)
sys.path.insert(0, sys.argv[1])
sys.argv = [sys.argv[0], "qwen"]
try:
    with contextlib.redirect_stdout(sys.stderr):
        from synthesis import load
        import numpy as np
        generate = load()
    print(json.dumps({"ready": True}), flush=True)
    requests = queue.Queue()
    cancelled = set()
    def receive():
        for line in sys.stdin:
            request = json.loads(line)
            if "cancel" in request:
                cancelled.add(request["cancel"])
            else:
                requests.put(request)
        requests.put(None)
    threading.Thread(target=receive, daemon=True).start()
    while (request := requests.get()) is not None:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                for samples, rate, _ in generate(request["text"], request["voice"]):
                    if request["id"] in cancelled:
                        break
                    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
                    if pcm:
                        print(json.dumps({"id": request["id"], "rate": rate, "pcm": base64.b64encode(pcm).decode("ascii")}), file=sys.__stdout__, flush=True)
            print(json.dumps({"id": request["id"], "done": True}), flush=True)
        except Exception:
            print(json.dumps({"id": request["id"], "error": "The local Qwen voice could not read this text."}), flush=True)
        finally:
            cancelled.discard(request["id"])
except Exception:
    print(json.dumps({"ready": False, "error": "The installed GPU Qwen voice could not start."}), flush=True)
    sys.exit(1)
