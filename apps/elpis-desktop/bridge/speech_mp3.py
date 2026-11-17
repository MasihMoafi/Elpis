"""Incremental MP3 frames through the system encoder, without another process."""
import ctypes as c
from ctypes.util import find_library
from functools import cache


@cache
def library():
    name = find_library("mp3lame")
    if not name:
        raise RuntimeError("Streaming speech needs the installed MP3 encoder")
    lib = c.CDLL(name)
    signatures = {
        "lame_init": (c.c_void_p, []),
        "lame_set_in_samplerate": (c.c_int, [c.c_void_p, c.c_int]),
        "lame_set_num_channels": (c.c_int, [c.c_void_p, c.c_int]),
        "lame_set_brate": (c.c_int, [c.c_void_p, c.c_int]),
        "lame_set_quality": (c.c_int, [c.c_void_p, c.c_int]),
        "lame_set_bWriteVbrTag": (c.c_int, [c.c_void_p, c.c_int]),
        "lame_init_params": (c.c_int, [c.c_void_p]),
        "lame_encode_buffer": (c.c_int, [c.c_void_p, c.POINTER(c.c_short), c.POINTER(c.c_short), c.c_int, c.c_void_p, c.c_int]),
        "lame_encode_flush": (c.c_int, [c.c_void_p, c.c_void_p, c.c_int]),
        "lame_close": (c.c_int, [c.c_void_p]),
    }
    for name, (result, args) in signatures.items():
        function = getattr(lib, name)
        function.restype, function.argtypes = result, args
    return lib


class Mp3:
    def __init__(self, rate):
        self.lib = library()
        self.encoder = self.lib.lame_init()
        if not self.encoder:
            raise MemoryError("Cannot start speech encoding")
        for name, value in (("in_samplerate", rate), ("num_channels", 1), ("brate", 64),
                            ("quality", 2), ("bWriteVbrTag", 0)):
            if getattr(self.lib, "lame_set_" + name)(self.encoder, value) < 0:
                self.close()
                raise RuntimeError("Unsupported speech format")
        if self.lib.lame_init_params(self.encoder) < 0:
            self.close()
            raise RuntimeError("Cannot initialize speech encoding")

    def process(self, pcm):
        count = len(pcm) // 2
        samples = (c.c_short * count).from_buffer_copy(pcm)
        output = c.create_string_buffer(int(count * 1.25) + 7200)
        length = self.lib.lame_encode_buffer(self.encoder, samples, samples, count, output, len(output))
        if length < 0:
            raise RuntimeError("Speech encoding failed")
        return output.raw[:length]

    def finish(self):
        output = c.create_string_buffer(7200)
        length = self.lib.lame_encode_flush(self.encoder, output, len(output))
        if length < 0:
            raise RuntimeError("Cannot finish speech encoding")
        return output.raw[:length]

    def close(self):
        if self.encoder:
            self.lib.lame_close(self.encoder)
            self.encoder = None
