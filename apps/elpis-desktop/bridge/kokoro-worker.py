"""Read aloud's local voice (Kokoro, the af_heart voice Masih chose). One JSON request per line on stdin:
{"id": ..., "text": ..., "out": "/path.wav"}; one JSON reply per line on stdout: {"id": ..., "ok": true} or an error."""
import json, os, sys

try:
    import kokoro_onnx, onnxruntime, soundfile

    if "CUDAExecutionProvider" not in onnxruntime.get_available_providers():
        raise RuntimeError("CUDA is unavailable")
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    session = onnxruntime.InferenceSession(sys.argv[1], sess_options=options, providers=["CUDAExecutionProvider"])
    session.disable_fallback()
    if session.get_providers()[0] != "CUDAExecutionProvider":
        raise RuntimeError("CUDA did not initialize")
    model = kokoro_onnx.Kokoro.from_session(session, sys.argv[2])
except Exception:
    print(json.dumps({"ready": False, "error": "Read aloud needs a working NVIDIA GPU and CUDA-enabled Kokoro."}), flush=True)
    sys.exit(1)

voice, speed = os.environ.get("ELPIS_KOKORO_VOICE", "af_heart"), float(os.environ.get("ELPIS_KOKORO_SPEED", "1.0"))
print(json.dumps({"ready": True, "voices": model.get_voices()}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    try:
        samples, rate = model.create(request["text"], voice=request.get("voice") or voice, speed=speed, lang="en-us")
        soundfile.write(request["out"], samples, rate)
        print(json.dumps({"id": request["id"], "ok": True}), flush=True)
    except Exception as error:  # one bad piece of text must not end the worker
        print(json.dumps({"id": request["id"], "ok": False, "error": str(error)[:300]}), flush=True)
