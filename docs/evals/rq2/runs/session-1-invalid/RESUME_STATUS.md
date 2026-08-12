# Resume attempt status

Resume was attempted against the preserved session ID `019ff148-e0d6-79e1-84ce-d352a866bdcb`.

The exact command was:

```text
/home/masih/.local/bin/elpis resume 019ff148-e0d6-79e1-84ce-d352a866bdcb
```

The frozen binary rejected it before creating a session:

```text
error: unexpected argument '019ff148-e0d6-79e1-84ce-d352a866bdcb' found
Usage: elpis [OPTIONS] [PROMPT]
```

`--resume <session-id>` was also rejected, and the binary help exposes no resume option or subcommand. The original preserved session JSONL is unchanged. No replacement session, new target capture, final probe, or session-2 run was started.

Evidence:

- [`resume-attempt.log`](resume-attempt.log)
- [`resume-cli-help.txt`](resume-cli-help.txt)
- [`elpis-session.jsonl`](elpis-session.jsonl)
