"""Read aloud's local voice (Kokoro, the af_heart voice Masih chose). One JSON request per line on stdin:
{"id": ..., "text": ..., "out": "/path.wav"}; one JSON reply per line on stdout: {"id": ..., "ok": true} or an error."""
import json, os, sys
import kokoro_onnx, soundfile

model = kokoro_onnx.Kokoro(sys.argv[1], sys.argv[2])
voice, speed = os.environ.get("ELPIS_KOKORO_VOICE", "af_heart"), float(os.environ.get("ELPIS_KOKORO_SPEED", "1.0"))
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    try:
        samples, rate = model.create(request["text"], voice=voice, speed=speed, lang="en-us")
        soundfile.write(request["out"], samples, rate)
        print(json.dumps({"id": request["id"], "ok": True}), flush=True)
    except Exception as error:  # one bad piece of text must not end the worker
        print(json.dumps({"id": request["id"], "ok": False, "error": str(error)[:300]}), flush=True)
