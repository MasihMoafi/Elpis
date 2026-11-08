export type Scope = {
    dir: string;
    why: string;
    files?: RegExp;
};
// Directories rewritten, relative to codex-rs/. `files`, when present, narrows a directory
// to the paths that match it.
const SCOPE: Scope[] = [
    { dir: "tui/src", why: "the TUI" },
    { dir: "cli/src", why: "CLI help and messages" },
    { dir: "exec/src", why: "`elpis exec` output and help" },
    { dir: "tui/tests", why: "integration tests that assert the TUI wording" },
    { dir: "cli/tests", why: "integration tests that assert the CLI wording" },
    { dir: "exec/tests", why: "integration tests that assert the exec wording" },
    { dir: "features/src", why: "descriptions the /experimental menu shows" },
    { dir: "config/src", why: "config warnings and errors the user reads" },
    { dir: "app-server/src", why: "messages the app server sends its clients; the TUI shows them" },
    { dir: "login/src", why: "the device-code banner, sign-in errors and the browser callback messages" },
    { dir: "model-provider/src", why: "provider and credential errors the user reads" },
    { dir: "login/tests", why: "integration tests that assert the login wording" },
    {
        dir: "app-server/tests",
        files: /^app-server\/tests\/suite\/v2\/(?:bedrock_setup|feedback|gateway_oauth_tests|model_list_requirements_tests|model_provider_enforcement_tests)\.rs$/,
        why: "only the tests that assert app-server wording; the rest assert core's prompts and other crates' output, which stay Codex",
    },
];
// Files left alone entirely. Paths are relative to codex-rs/.
const EXCLUDED_PATHS = [
    {
        re: /(^|\/)[^/]*elpis[^/]*$|^tui\/src\/branding\.rs$/,
        why: "Elpis-owned code; its evals assert that Codex wording is absent",
    },
    {
        re: /^cli\/src\/doctor(\.rs$|\/)|^cli\/src\/snapshots\/codex__doctor__|^cli\/tests\/(snapshots\/)?doctor_/,
        why: "`doctor` diagnoses OpenAI's Codex install and desktop app (package IDs, signing identities, endpoint-security exclusions); hidden from help",
    },
    {
        re: /^cli\/src\/desktop_app\//,
        why: "installs and launches OpenAI's Codex desktop app (Codex.app, OpenAI.Codex)",
    },
    {
        re: /^tui\/src\/pets\/|\/snapshots\/[^/]*pets[^/]*\.snap$/,
        why: "/pets is hidden in Elpis; 'Codex' there is OpenAI's pet character",
    },
    {
        re: /^tui\/src\/analytics\//,
        why: "labels OpenAI's usage-analytics surfaces (Codex, JetBrains, GitHub) returned by the ChatGPT backend",
    },
];
// Text kept as "Codex". `sample` is a real string each entry protects; the eval checks
// it survives and that it would be renamed without the entry.
const EXCEPTIONS = [
    {
        re: /OpenAI(?:'s)? Codex|Codex, OpenAI's/g,
        why: "names OpenAI's product outright; Elpis evals assert this upstream title is gone",
        sample: ">_ OpenAI Codex (v0.0.0)",
    },
    {
        re: /Codex docs/g,
        why: "link text for developers.openai.com/codex, OpenAI's documentation",
        sample: "Codex docs",
    },
    {
        re: /Codex keymap documentation/g,
        why: "OpenAI's keymap documentation; Elpis has none",
        sample: "See the Codex keymap documentation for supported actions and examples.",
    },
    {
        re: /Codex Cloud/g,
        why: "OpenAI's hosted Codex Cloud (the `cloud` subcommand)",
        sample: "[EXPERIMENTAL] Browse tasks from Codex Cloud and apply changes locally.",
    },
    {
        re: /Codex-optimized|Optimized for Codex/g,
        why: "OpenAI model-catalog descriptions of OpenAI's models",
        sample: "Optimized for Codex. Cheaper, faster, but less capable.",
    },
    {
        re: /Codex is currently experiencing high load/g,
        why: "status of OpenAI's backend, not of Elpis",
        sample: "Codex is currently experiencing high load.",
    },
    {
        re: /enable Codex plugins/g,
        why: "a ChatGPT workspace admin setting named by OpenAI",
        sample: "Ask a workspace admin to enable Codex plugins or plugin sharing",
    },
    {
        re: /Update Codex to the latest version|Updating Codex via|Update ran successfully! Please restart Codex|`codex update` is not available|release build of Codex|detect the Codex installation method/g,
        why: "`update` runs OpenAI's Codex installer (npm @openai/codex, brew codex, chatgpt.com/codex/install.sh); it does not update Elpis",
        sample: "`codex update` is not available in debug builds. Install a release build of Codex to use this command.",
    },
    {
        re: /## My request for Codex:/g,
        why: "model-visible marker that codex-rs/protocol (USER_MESSAGE_BEGIN) parses; renaming one side breaks title and summary extraction",
        sample: "\\n## My request for Codex:\\n",
    },
    {
        re: /Read the Codex goal objective file at/g,
        why: "persisted goal-objective prefix that goal_files.rs parses back; renaming it orphans goals saved before",
        sample: "Read the Codex goal objective file at ",
    },
    {
        re: /is archived\. Run `codex unarchive/g,
        why: "the error codex-rs/app-server returns (two sites); session_start.rs in the TUI recognises it by this text",
        sample: " is archived. Run `codex unarchive ",
    },
    {
        re: /or run `codex app-server daemon start`/g,
        why: "text codex-rs/app-server-daemon prints, asserted by a TUI snapshot",
        sample: "repair the existing installation, or run `codex app-server daemon start` to install",
    },
    {
        re: /^codex [^\n:`]*:/gm,
        why: "a test's argv (`codex ...`) echoed at the start of a snapshot line; test argv stays `codex`",
        sample: "codex exec review --worktree: `--worktree` is not supported for code review",
    },
    {
        re: /Co-authored-by: Codex/g,
        why: "commit trailer codex-rs/core adds; the CLI test asserts core's output",
        sample: "Co-authored-by: Codex <noreply@openai.com>",
    },
    {
        re: /Please run 'codex login'/g,
        why: "text codex-rs/cloud-tasks prints; the CLI test asserts it",
        sample: "Not signed in. Please run 'codex login'",
    },
    {
        re: /Codex Desktop/g,
        why: "client name the app server, core and otel match on (`name == \"Codex Desktop\"`, originator mapping); the desktop app is OpenAI's",
        sample: "(ConnectionOrigin::Stdio, \"Codex Desktop\", true, true, true)",
    },
    {
        re: /Codex-App_2/g,
        why: "a tool-namespace identifier fixture for validate_dynamic_tools, not prose",
        sample: "Some(\"Codex-App_2\")",
    },
    {
        re: /Codex Auth/g,
        why: "the OS keyring service name; renaming it orphans every saved login",
        sample: "const KEYRING_SERVICE: &str = \"Codex Auth\";",
    },
    {
        re: /Codex Companion/g,
        why: "the name of a third-party plugin in a hooks fixture, not this program",
        sample: "Optional stop-time review gate for Codex Companion.",
    },
    {
        re: /You do not have access to Codex|Codex is not enabled for your workspace|(?:request|get) access to Codex|authorized to use Codex|Codex access denial/g,
        why: "says the ChatGPT account lacks OpenAI's Codex entitlement (missing_codex_entitlement); it is not about this program",
        sample: "Codex is not enabled for your workspace. Contact your workspace administrator to request access to Codex.",
    },
    {
        re: /this Codex server/g,
        why: "the OpenAI auth server the login talks to; Elpis has no server of its own",
        sample: "device code login is not enabled for this Codex server. Use the browser login.",
    },
    {
        re: /invalid Codex open app URL/g,
        why: "names CODEX_OPEN_APP_URL, the link that opens OpenAI's Codex desktop app",
        sample: "invalid Codex open app URL: relative URL without a base",
    },
    {
        re: /Sanitized Codex user agent|base Codex user agent|default Codex originator/g,
        why: "logs about the user-agent and originator header values, which stay Codex-prefixed for OpenAI's backend",
        sample: "Falling back to default Codex originator because base user agent string is invalid",
    },
    {
        re: /update or unset it, then restart Codex/g,
        why: "core/src/client_tests.rs asserts this Bedrock message verbatim and core is out of scope; rename both together",
        sample: "update or unset it, then restart Codex",
    },
];
// A string literal kept as "Codex" because of the code around it, not its wording. `before`
// is tested against the source just ahead of the literal, `body` against its contents.
// `sample` is Rust source the entry protects; the eval checks it survives and would be
// renamed without the entry.
const LITERAL_EXCEPTIONS = [
    {
        before: /(?:\.join|Path::new)\("OpenAI"\)\s*\.join\(\s*$/,
        body: /^Codex$/,
        why: "the Windows ProgramData directory OpenAI\\Codex where managed config and requirements are read",
        sample: 'program_data.join("OpenAI").join("Codex")',
    },
    {
        before: /(?:\.starts_with|is_first_party_originator)\(\s*$/,
        body: /^Codex /,
        why: "the first-party originator prefix (`Codex Desktop`, ...) that login matches and OpenAI's backend sees",
        sample: 'originator_value.starts_with("Codex ")',
    },
];
// The multitool's subcommands; `codex <one of these>` is a command the user types.
const SUBCOMMANDS = [
    "agents", "app", "app-server", "apply", "archive", "cloud", "completion", "debug",
    "delete", "doctor", "exec", "exec-server", "features", "fork", "login", "logout", "mcp",
    "migrate-rollouts", "plugin", "queue", "remote-control", "resume", "review", "sandbox",
    "unarchive", "update",
];
// A word is standalone unless a letter, digit or one of `_ . / \ ~ -` touches it.
const NOT_AFTER = String.raw `(?<![\w./\\~-])`;
const RULES = [
    { name: "product", re: new RegExp(`${NOT_AFTER}Codex(?!\\w)`, "g"), to: "Elpis" },
    // "You approved codex to run", "before codex could apply": the agent as actor.
    {
        name: "actor",
        re: new RegExp(`${NOT_AFTER}codex(?= (?:to|could|network access)\\b)`, "g"),
        to: "Elpis",
    },
    // "run codex resume", "Usage: codex exec", "codex --no-daemon", "`codex`", "`codex {cmd}`".
    {
        name: "command",
        re: new RegExp(`${NOT_AFTER}codex(?= (?:${SUBCOMMANDS.join("|")})(?![\\w-])| --?[a-z])|(?<=\`)codex(?=[\` ])` +
            // The same command right after a color escape in a Rust literal: "\u{1b}[36mcodex resume".
            `|(?<=\\u\\{1b\\}\\[[0-9;]*m)codex(?= (?:${SUBCOMMANDS.join("|")})(?![\\w-]))`, "g"),
        to: "elpis",
    },
];
module.exports = { SCOPE, EXCLUDED_PATHS, EXCEPTIONS, LITERAL_EXCEPTIONS, SUBCOMMANDS, NOT_AFTER, RULES };
