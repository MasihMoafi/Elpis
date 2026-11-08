// Generated from codex-rs/skills/assets-src/openai-docs/manual-outline.mts by scripts/emit-compat-js.mts; do not edit.

export const manualLines = (manual        ) => {
    const lines = manual.replace(/\r\n/g, "\n").split("\n");
    if (lines[lines.length - 1] === "")
        lines.pop();
    return lines;
};
export const sectionTitle = (rawTitle        ) => rawTitle.replace(/\s+#+\s*$/, "").replace(/\s+/g, " ").trim();
export const buildOutline = (manual        )          => {
    const lines = manualLines(manual);
    const headings            = [];
    let inFence = false;
    lines.forEach((line, index) => {
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            return;
        }
        if (inFence)
            return;
        const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (!match)
            return;
        if (match[1] === undefined || match[2] === undefined)
            return;
        const level = match[1].length;
        if (level < 2 || level > 3)
            return;
        headings.push({
            level,
            title: sectionTitle(match[2]),
            startLine: index + 1,
            endLine: lines.length,
        });
    });
    for (let index = 0; index < headings.length; index += 1) {
        const heading = headings[index];
        if (heading === undefined)
            continue;
        const nextPeer = headings
            .slice(index + 1)
            .find((candidate) => candidate.level <= heading.level);
        if (nextPeer) {
            heading.endLine = nextPeer.startLine - 1;
        }
    }
    if (headings.length === 0) {
        return {
            headingCount: 0,
            lineCount: lines.length,
            text: "No markdown headings found.",
        };
    }
    const minLevel = Math.min(...headings.map((heading) => heading.level));
    return {
        headingCount: headings.length,
        lineCount: lines.length,
        text: headings
            .map((heading) => {
            const indent = "  ".repeat(heading.level - minLevel);
            return `${indent}- ${heading.title} (lines ${heading.startLine}-${heading.endLine})`;
        })
            .join("\n"),
    };
};
export const outlineMarkdown = (outline         ) => `# Codex Manual Outline\n\n${outline.text}\n`;
