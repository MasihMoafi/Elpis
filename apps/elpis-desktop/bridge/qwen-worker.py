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
engine = sys.argv[2] if len(sys.argv) > 2 else "qwen"
sys.argv = [sys.argv[0], engine]
try:
    with contextlib.redirect_stdout(sys.stderr):
        from speech_mp3 import Mp3, library
        from synthesis import load
        import numpy as np
        library()
        if engine == "kokoro":
            import onnxruntime
            onnxruntime.preload_dlls(directory="")
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
        encoder = None
        tempo = None
        try:
            with contextlib.redirect_stdout(sys.stderr):
                speed = request.get("speed", 1.0)
                if engine == "kokoro":
                    samples, rate = generate(request["text"], request["voice"], speed)
                    chunks = [(samples, rate, None)]
                else:
                    chunks = generate(request["text"], request["voice"])
                for samples, rate, _ in chunks:
                    if request["id"] in cancelled:
                        break
                    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
                    if pcm:
                        if encoder is None:
                            encoder = Mp3(rate)
                            if engine == "qwen" and speed != 1.0:
                                from speech_tempo import SpeechTempo
                                tempo = SpeechTempo(rate, speed)
                        pcm = tempo.process(pcm) if tempo else pcm
                        audio = encoder.process(pcm) if pcm else b""
                        if audio:
                            print(json.dumps({"id": request["id"], "audio": base64.b64encode(audio).decode("ascii")}), file=sys.__stdout__, flush=True)
                if encoder is not None and request["id"] not in cancelled:
                    tail = tempo.finish() if tempo else b""
                    audio = (encoder.process(tail) if tail else b"") + encoder.finish()
                    if audio:
                        print(json.dumps({"id": request["id"], "audio": base64.b64encode(audio).decode("ascii")}), file=sys.__stdout__, flush=True)
            print(json.dumps({"id": request["id"], "done": True}), flush=True)
        except Exception:
            print(json.dumps({"id": request["id"], "error": "The local voice could not read this text."}), flush=True)
        finally:
            if tempo is not None:
                tempo.close()
            if encoder is not None:
                encoder.close()
            cancelled.discard(request["id"])
except Exception:
    print(json.dumps({"ready": False, "error": "The installed GPU voice could not start."}), flush=True)
    sys.exit(1)
