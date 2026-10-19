# T6 · compact-profile comparison · 19 October 2026

Measure the engine, keeping source/features/toolchain constant. Base `8b` plus command-center, credits and pointer prerequisites must match installed `a8`'s Rust tree; retain bridge `08a`. Do not alter release defaults or install either result.

| Profile | LTO | Optimization | Codegen units | Incremental | Debug | Strip |
| --- | --- | --- | --- | --- | --- | --- |
| Fast control | false | 1 | 256 | true | none | symbols |
| Compact | thin | s | 4 | false | none | symbols |

Build fast, then compact with guarded `next-cargo` and identical `build --release --locked --offline -p codex-cli --bin codex` arguments. Use shared target, six jobs/rustc threads 1, exclusive compiler lock, 12/16 GiB memory/no swap, CPU 600%, low I/O priority and 60-minute cap per profile. Check disk/memory/sensors/ownership before each: ≥45 GiB free to start, 20 GiB abort; helper pauses at 77°C/resumes below 74°C and aborts at 80°C. Stop on any failure without retry/wider limits/downloads/cache clearing.

Keep only measured control/candidate artifacts privately; record source/flags/toolchain, actual cgroup limits, wall/CPU/maxRSS/cgroup peak, free-space/thermal logs and binary size/hash. Compare help/version plus bounded no-inference private tmux startup, typing/scrolling, pointer and bridge behavior. Verify the installed original remains byte-identical. Report partial results and untested boundaries honestly; savings alone do not justify installation.
