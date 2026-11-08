// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/sources/github.ts.
// Ported from dsh-superagent (MIT), src/sources/github.ts
import { GithubAccountsSchema } from "./settings.mts";
import { githubThreadContext } from "./github-read.mts";
import { SOURCE } from "./github-trigger.mts";
import { githubLink, sendGithub } from "./github-channel.mts";
import type { Localized, SourceKind } from "./kind.mts";
import { z } from "zod";
export const GithubConfigSchema = GithubAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observePulls: z.boolean().default(false),
  observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false),
}).strict();
export type GithubConfig = z.infer<typeof GithubConfigSchema>;
export const OBSERVED = {
  issues: "observeIssues",
  pulls: "observePulls",
  comments: "observeComments",
  ci: "observeCi",
} as const;
export type Scope = keyof typeof OBSERVED;
export function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.branch === "string" ? "ci" : undefined;
  if (meta.kind === "issue") return "issues";
  if (meta.kind === "pull") return "pulls";
  return meta.kind === "conversation" || meta.kind === "inline" || meta.kind === "review" ? "comments" : undefined;
}
export const githubKind: SourceKind<GithubConfig> = {
  kind: SOURCE,
  title: { zh: "GitHub", en: "GitHub" },
  description: {
    zh: "智能体的 GitHub 账号；接收仓库里发给它的通知、已订阅 Issue 与 PR 的讨论、CI 状态变化和 PR 合并关闭。",
    en: "The saved gh login; receives notifications to it in the repository, discussion on subscribed Issues and PRs, CI changes, and PR merge or close.",
  },
  schema: GithubConfigSchema,
  fields: [
    {
      key: "repository",
      type: "text",
      pattern: "[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+",
      label: { zh: "监听的仓库", en: "Repository" },
      hint: {
        zh: "写作 owner/name。使用现有 gh 登录，不经过代理。保存时检查仓库访问权限，然后开始轮询。",
        en: "Written owner/name. Uses the existing gh login without proxy variables. Saving checks repository access before polling starts.",
      },
    },
    {
      key: "pollSeconds",
      type: "number",
      advanced: true,
      min: 60,
      max: 3600,
      label: { zh: "轮询间隔 / 秒", en: "Polling interval / seconds" },
      hint: { zh: "GitHub 要求更长间隔时以 GitHub 为准。", en: "A longer interval requested by GitHub wins." },
    },
    {
      key: "failuresBeforeError",
      type: "number",
      advanced: true,
      min: 1,
      max: 20,
      label: { zh: "连续失败几次后报告异常", en: "Failed polls before reporting an error" },
      hint: {
        zh: "单次网络中断会在下一次轮询时自动重试，不必报告。",
        en: "A single network interruption is retried on the next poll and need not be reported.",
      },
    },
    {
      key: "observeIssues",
      type: "switch",
      label: { zh: "接收仓库里的新 Issue", en: "Receive new Issues in the repository" },
      hint: {
        zh: "打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。",
        en: "New Issues that do not mention the agent are received too, and the Policy's admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.",
      },
    },
    {
      key: "observePulls",
      type: "switch",
      label: { zh: "接收仓库里的新 PR", en: "Receive new pull requests in the repository" },
      hint: {
        zh: "打开后，没有 @ 智能体的新 PR 也会收到，由策略的接收表决定是否成为候选。",
        en: "New pull requests that do not mention the agent are received too, and the Policy's admission table decides whether they become candidates.",
      },
    },
    {
      key: "observeComments",
      type: "switch",
      label: { zh: "接收仓库里的评论", en: "Receive comments in the repository" },
      hint: {
        zh: "打开后，Issue 和 PR 上没有 @ 智能体的评论和代码评论也会收到，由策略的接收表决定是否成为候选。",
        en: "Comments and review comments on Issues and PRs that do not mention the agent are received too, and the Policy's admission table decides whether they become candidates.",
      },
    },
    {
      key: "observeCi",
      type: "switch",
      label: { zh: "接收默认分支的 CI", en: "Receive the default branch's CI" },
      hint: {
        zh: "打开后，默认分支的 CI 失败和恢复会收到，由策略的接收表决定是否成为候选。",
        en: "Failures of the default branch's CI, and its recovery, are received, and the Policy's admission table decides whether they become candidates.",
      },
    },
  ],
  // What the Source observes across the repository it receives in full; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta);
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...(row ? { row } : {}) };
  },
  health: ["github"],
  channel: { send: sendGithub, link: githubLink },
  threadContext: githubThreadContext,
  // `#12`, `12`, or the page of an Issue or PR, of any repository, names Thread 12.
  find: query => {
    const number = (/^#?(\d+)$/.exec(query.trim()) ??
      /github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)/.exec(query))?.[1];
    return { threads: number ? [`${SOURCE}:${number}`] : [], terms: [] };
  },
  policy: {
    schema: z
      .object({
        allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+$/) }).strict()).default([]),
        bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+(\[bot\])?$/) }).strict()).optional(),
      })
      .strict(),
    fields: [
      {
        key: "allowed",
        type: "rows",
        label: { zh: "能发起工作的 GitHub 账号", en: "GitHub accounts that may originate work" },
        columns: [{ key: "id", type: "text", label: { zh: "账号", en: "Account" }, pattern: "[A-Za-z0-9\\-]+" }],
      },
      {
        key: "bots",
        type: "rows",
        label: { zh: "评论可以成为候选的机器人", en: "Bots whose comments may become candidates" },
        hint: {
          zh: "名单里的机器人账号（例如 dependabot[bot]）的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收仓库里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。",
          en: "A comment of a bot account on this list, such as dependabot[bot], becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the repository on. Such a comment never makes an explicit request or stops a ticket; other bots' comments are not admitted.",
        },
        columns: [
          { key: "id", type: "text", label: { zh: "账号", en: "Account" }, pattern: "[A-Za-z0-9\\-]+(\\[bot\\])?" },
        ],
      },
    ],
    explicit: {
      zh: "名单里的账号在 Issue 或评论里 @ 智能体的账号。",
      en: "An account on the list mentions the agent's account in an Issue or a comment.",
    },
    rows(stored) {
      const config = GithubConfigSchema.partial().parse(stored);
      const note = (observed: boolean | undefined) =>
        observed ? { zh: "全部", en: "All" } : { zh: "仅 @", en: "@ only" };
      const row = (
        id: Scope,
        label: {
          zh: string;
          en: string;
        },
      ) => ({
        id,
        label,
        note: note(config[OBSERVED[id]]),
        cells: {
          listedUnaddressed: !!config[OBSERVED[id]],
          unlistedAddressed: true,
          unlistedUnaddressed: !!config[OBSERVED[id]],
        },
      });
      return [
        row("issues", { zh: "新 Issue", en: "New Issues" }),
        row("pulls", { zh: "新 PR", en: "New pull requests" }),
        row("comments", { zh: "评论", en: "Comments" }),
        // CI has no sender, so only the cell of a sender off the list who does not address the agent applies.
        {
          id: "ci",
          label: { zh: "默认分支的 CI", en: "Default branch CI" },
          note: config.observeCi ? { zh: "接收", en: "Received" } : { zh: "不接收", en: "Not received" },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi },
        },
      ];
    },
  },
  environment: {
    variables: [
      {
        key: "DSH_SUPERAGENT_GITHUB_REPOSITORY",
        description: {
          zh: "这个来源监听的仓库，owner/name。智能体在这里开的 PR，分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单",
          en: "The repository this Source watches, as owner/name. A PR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket",
        },
      },
      {
        key: "DSH_SUPERAGENT_GITHUB_ACCOUNT",
        description: {
          zh: "智能体的 GitHub 账号；gh 以它登录，除自动合并外的 GitHub 操作都用 gh，不用其他账号或凭据",
          en: "The agent's GitHub account. gh is signed in to it; use gh for every GitHub operation except auto-merge, and never another account or credential",
        },
      },
      {
        key: "DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL",
        description: {
          zh: "智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱",
          en: "Commit email of the agent's account. git has no identity here: commit as the author these instructions name, or as the agent's account with this email when they name none",
        },
      },
      {
        key: "DSH_SUPERAGENT_GITHUB_NUMBER",
        description: {
          zh: "接下工单的 Issue 或 PR 编号；工单不是从 GitHub 来的时为空",
          en: "Number of the Issue or PR that started the ticket; empty when the ticket did not start on GitHub",
        },
      },
      {
        key: "DSH_SUPERAGENT_GITHUB_PR_HEAD",
        description: {
          zh: "接下工单的 PR 的 head 引用 refs/pull/<编号>/head；不是 PR 时为空",
          en: "Head ref refs/pull/<number>/head of the PR that started the ticket; empty when it was not a PR",
        },
      },
    ],
    values: ({ deployment, trigger }) => {
      const number = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.number) || 0 : 0;
      return {
        DSH_SUPERAGENT_GITHUB_REPOSITORY: deployment.repository,
        DSH_SUPERAGENT_GITHUB_ACCOUNT: deployment.github.login,
        DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: deployment.github.noreply,
        DSH_SUPERAGENT_GITHUB_NUMBER: number ? String(number) : "",
        DSH_SUPERAGENT_GITHUB_PR_HEAD: number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : "",
      };
    },
  },
  facts: (deployment): Record<string, Localized | string> =>
    deployment
      ? {
          cli: { zh: `当前账号 @${deployment.github.login}`, en: `Current account @${deployment.github.login}` },
        }
      : {},
};
