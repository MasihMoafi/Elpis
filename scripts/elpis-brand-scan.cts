const { EXCEPTIONS, LITERAL_EXCEPTIONS, RULES }: typeof import('./elpis-brand-rules.cts') = require('./elpis-brand-rules.cts');
export type Token = {
    kind: 'str' | 'doc' | 'comment';
    raw?: boolean;
    start: number;
    end: number;
    bodyStart: number;
    bodyEnd: number;
};
export type Edit = {
    start: number;
    end: number;
    to: string;
};
export type RuleEdit = Edit & {
    rule: string;
};
// A bare "codex" literal is a binary or ID and stays, except as the head of a command
// vector the user is told to run: `vec!["codex".to_string(), ...]` (the reconnect hint).
const COMMAND_HEAD = /vec!\[\s*$/;
const CLAP_DERIVE = /derive\([^)]*\b(?:clap::)?(?:Parser|Args|Subcommand|ValueEnum)\b/;
// Minimal Rust lexer: string literals (plain, raw, byte) and comments, with offsets.
function lexRust(src: string) {
    const tokens: Token[] = [];
    const n = src.length;
    const isIdent = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
    let i = 0;
    while (i < n) {
        const c = src[i];
        if (c === "/" && src[i + 1] === "/") {
            let end = src.indexOf("\n", i);
            if (end < 0)
                end = n;
            const text = src.slice(i, end);
            const doc = text.startsWith("///") && !text.startsWith("////");
            tokens.push({ kind: doc ? "doc" : "comment", start: i, end, bodyStart: i + (doc ? 3 : 2), bodyEnd: end });
            i = end;
            continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            let depth = 1;
            let j = i + 2;
            while (j < n && depth > 0) {
                if (src[j] === "/" && src[j + 1] === "*") {
                    depth++;
                    j += 2;
                }
                else if (src[j] === "*" && src[j + 1] === "/") {
                    depth--;
                    j += 2;
                }
                else
                    j++;
            }
            i = j;
            continue;
        }
        if (!isIdent(src[i - 1])) {
            const raw = /^(?:b|c|br|cr)?r(#*)"/.exec(src.slice(i, i + 64));
            if (raw) {
                const close = `"${raw[1]}`;
                const bodyStart = i + raw[0].length;
                const bodyEnd = src.indexOf(close, bodyStart);
                if (bodyEnd < 0)
                    throw new Error(`unterminated raw string at offset ${i}`);
                tokens.push({ kind: "str", raw: true, start: i, end: bodyEnd + close.length, bodyStart, bodyEnd });
                i = bodyEnd + close.length;
                continue;
            }
            const plain = /^(?:b|c)?"/.exec(src.slice(i, i + 2));
            if (plain) {
                const bodyStart = i + plain[0].length;
                let j = bodyStart;
                while (j < n && src[j] !== '"')
                    j += src[j] === "\\" ? 2 : 1;
                if (j >= n)
                    throw new Error(`unterminated string at offset ${i}`);
                tokens.push({ kind: "str", raw: false, start: i, end: j + 1, bodyStart, bodyEnd: j });
                i = j + 1;
                continue;
            }
        }
        if (c === "'") {
            // Char literal ('x', '\n', '\u{1b}', '"') or a lifetime ('a).
            if (src[i + 1] === "\\") {
                let j = i + 3;
                while (j < n && src[j] !== "'")
                    j++;
                i = j + 1;
                continue;
            }
            const codePoint = src.codePointAt(i + 1);
            const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
            i += src[i + 1 + width] === "'" ? 2 + width : 1;
            continue;
        }
        if (isIdent(c)) {
            // String prefixes (`b"`, `r#"`) were matched above, so this is a plain identifier.
            while (i < n && isIdent(src[i]))
                i++;
            continue;
        }
        i++;
    }
    return tokens;
}
// A same-length view of an escaped literal body: `\n`, `\t`, `\r` read as the whitespace
// they print, so "…\nCodex" is a standalone word. Offsets are unchanged.
function unescapedView(body: string) {
    return body.replace(/\\[\\"'nrt0]/g, (escape) => (escape === "\\\\" ? escape : ` ${escape[1] === "n" || escape[1] === "r" || escape[1] === "t" ? " " : escape[1]}`));
}
// Occurrences in `text` the rules would rename, split into renamed and excepted.
function scanText(text: string) {
    const spans: {
        index: number;
        start: number;
        end: number;
    }[] = [];
    EXCEPTIONS.forEach((exception, index) => {
        exception.re.lastIndex = 0;
        for (const m of text.matchAll(exception.re)) {
            const start = m.index as number;
            spans.push({ index, start, end: start + m[0].length });
        }
    });
    const renames: RuleEdit[] = [];
    const excepted = new Set<number>();
    for (const rule of RULES) {
        rule.re.lastIndex = 0;
        for (const m of text.matchAll(rule.re)) {
            const start = m.index as number;
            const end = start + m[0].length;
            const cover = spans.find((span) => span.start <= start && end <= span.end);
            if (cover)
                excepted.add(cover.index);
            else {
                renames.push({ start, end, to: rule.to, rule: rule.name });
                // "a Codex task" reads "an Elpis task".
                if (rule.to === "Elpis" && /(?:^|[^\w])[Aa] $/.test(text.slice(Math.max(0, start - 3), start))) {
                    renames.push({ start: start - 1, end: start - 1, to: "n", rule: "article" });
                }
            }
        }
    }
    return { renames, excepted };
}
// Edits (absolute offsets) for one file, plus the exceptions it exercised.
function editsFor(relPath: string, src: string) {
    const edits: Edit[] = [];
    const excepted = new Set<number>();
    const literalExcepted = new Set<number>();
    const collect = (text: string, offset: number) => {
        const result = scanText(text);
        for (const r of result.renames)
            edits.push({ start: offset + r.start, end: offset + r.end, to: r.to });
        for (const index of result.excepted)
            excepted.add(index);
    };
    if (relPath.endsWith(".snap")) {
        const header = /^---\n[\s\S]*?\n---\n/.exec(src);
        const offset = header ? header[0].length : 0;
        collect(src.slice(offset), offset);
    }
    else {
        const clapFile = CLAP_DERIVE.test(src);
        for (const token of lexRust(src)) {
            if (token.kind === "str") {
                const body = src.slice(token.bodyStart, token.bodyEnd);
                const before = src.slice(Math.max(0, token.start - 96), token.start);
                const literalIndex = LITERAL_EXCEPTIONS.findIndex((e) => e.body.test(body) && e.before.test(before));
                if (literalIndex >= 0) {
                    if (scanText(body).renames.length)
                        literalExcepted.add(literalIndex);
                    continue;
                }
                const replyLabel = relPath.startsWith("exec/src/") && src.startsWith(".style(", token.end);
                const commandHead = COMMAND_HEAD.test(src.slice(Math.max(0, token.start - 64), token.start)) &&
                    src.startsWith(".to_string()", token.end);
                // The `elpis exec` reply label, `"codex".style(...)`, and the reconnect command head.
                if (body === "codex" && (replyLabel || commandHead)) {
                    edits.push({ start: token.bodyStart, end: token.bodyEnd, to: "elpis" });
                    continue;
                }
                collect(token.raw ? body : unescapedView(body), token.bodyStart);
            }
            else if (token.kind === "doc" && clapFile) {
                collect(src.slice(token.bodyStart, token.bodyEnd), token.bodyStart);
            }
        }
    }
    edits.sort((a, b) => a.start - b.start);
    return { edits, excepted, literalExcepted };
}
function applyEdits(src: string, edits: Edit[]) {
    let out = "";
    let last = 0;
    for (const edit of edits) {
        out += src.slice(last, edit.start) + edit.to;
        last = edit.end;
    }
    return out + src.slice(last);
}
module.exports = { COMMAND_HEAD, CLAP_DERIVE, lexRust, unescapedView, scanText, editsFor, applyEdits };
