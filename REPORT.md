Closed stdout and stderr pipes no longer raise uncaught EPIPE or ERR_STREAM_DESTROYED errors.
Other stream errors still reach the uncaught exception path.
Verified: real closed pipes in Node and Electron; resource build and test inventory passed.
Strict baseline unchanged: types 2404, tsx 10, lint 278.
Workspace pointer check reports 30 existing problems outside this change.
CI: build branch requested; see its GitHub Actions run for status.
