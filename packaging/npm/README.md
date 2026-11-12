# elpis-cli

This package installs the Elpis terminal app with npm. Elpis is an agent harness for Linux, built on OpenAI's Codex: you decide what every agent sees and touches.

The package is alpha, like Elpis 0.5.2 itself, and runs on Linux x86_64 only.

## Quick start

```sh
npm install -g elpis-cli
elpis
```

Or without installing:

```sh
npx elpis-cli
```

Expected result: the first run prints `Elpis 0.5.2: first run, downloading the terminal app to …`, then the terminal app opens. Later runs open at once.

## How it works

The package holds a small launcher and no binary. On its first run the launcher downloads three files of the matching [GitHub release](https://github.com/MasihMoafi/Elpis/releases): the terminal app, its code-mode host and its sandbox helper. It checks each file against the SHA-256 published beside it. A file that does not match is not run.

The files go to `~/.local/share/elpis-npm/<version>/`. Set `ELPIS_NPM_HOME` to use another folder. Removing that folder removes the download; `npm uninstall -g elpis-cli` removes the launcher.

Limits:

- A platform other than Linux x86_64 gets a message that says so.
- The terminal app only. The desktop app installs with the script in the [Elpis README](https://github.com/MasihMoafi/Elpis#quick-start).
- The package version is the Elpis release it downloads. A new release needs a new package version.

## Evidence

`npm test` runs three tests against a stand-in release server:

- A first run downloads and checks the three files, then runs the app and passes its arguments and exit status through. A second run downloads nothing.
- A file with a wrong checksum is refused.
- Another platform gets the message.
