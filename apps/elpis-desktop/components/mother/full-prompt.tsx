import { Diff } from "./prompt-history";
import { OptionSelect } from "@/components/ui/option-select";
import { Button as SharedButton } from "@/components/ui/button";
import { useEffect, useState } from "react";
import type { ApiResponse } from "../../bridge/router/app/api.mts";
import type { PromptConfig, PromptsView } from "./api.ts";
import { isSkill, lineDiff, partText, partWith, sectionLabel, sectionText } from "./prompt-config.ts";
import { usePanel } from "./provider.tsx";
import { valueLabel } from "./text.ts";
import { Hint, LoadState } from "./widgets.tsx";
import { Button, Icon, SegmentedControl } from "./controls.tsx";

export type Preview = ApiResponse<"POST prompts/preview">;

export type Target = "orchestrator" | "worker" | `skill/${string}`;

export const KIND_LABEL = {
  team: "promptPartTeam",
  fixed: "promptPartFixed",
  generated: "promptPartGenerated",
} as const;

export function FullPrompt({
  config,
  view,
  dirty,
  revision,
  onEdit,
}: {
  config: PromptConfig;
  view: PromptsView;
  dirty: boolean;
  revision: number;
  onEdit: (name: string) => void;
}) {
  const { t, call, notify } = usePanel();
  const [target, setTarget] = useState<Target>("orchestrator");
  const [compare, setCompare] = useState<"saved" | "default">(dirty ? "saved" : "default");
  // Keep the preview paired with the config it was composed from so diffs stay consistent until the next preview arrives.
  const [preview, setPreview] = useState<{ config: PromptConfig; value: Preview }>();
  const [error, setError] = useState<Error>();
  useEffect(() => {
    let active = true;
    call("POST prompts/preview", { body: config }).then(
      value => {
        if (active) {
          setPreview({ config, value });
          setError(undefined);
        }
      },
      (failure: Error) => {
        if (active) setError(failure);
      },
    );
    return () => {
      active = false;
    };
  }, [call, config]);
  if (!preview || error) return <LoadState loading error={error} />;
  const shown = dirty ? compare : "default";
  // A built-in skill is a built-in part, by its key.
  const team = isSkill(target) && Object.hasOwn(preview.config.skills, target.slice(6));
  const parts: {
    name: string;
    kind: "team" | "fixed" | "generated";
    key?: string | undefined;
    heading?: string | undefined;
    text: string;
  }[] = isSkill(target)
    ? [
        {
          name: target,
          kind: team ? "team" : "fixed",
          ...(team ? {} : { key: target }),
          text: preview.value.skills[target.slice(6)] ?? "",
        },
      ]
    : preview.value.parts[target];
  const builtIn = (key: string) => view.parts.find(part => part.key === key);
  return (
    <>
      <div className="dt-subhead">
        <OptionSelect
          className="w-auto"
          aria-label={t("promptPreviewTarget")}
          value={target}
          onChange={event => setTarget(event.target.value as Target)}
        >
          <option value="orchestrator">{valueLabel(t, "promptRole", "orchestrator")}</option>
          <option value="worker">{valueLabel(t, "promptRole", "worker")}</option>
          {Object.keys(preview.value.skills).map(name => (
            <option key={name} value={`skill/${name}`}>
              {sectionLabel(t, view, `skill/${name}`)}
            </option>
          ))}
        </OptionSelect>
        <Hint>
          {t("promptFullState", {
            count: parts.length,
            chars: parts.reduce((sum, part) => sum + part.text.length, 0),
            state: dirty ? t("promptPreviewDraft") : t("promptPreviewSaved", { revision }),
          })}
        </Hint>
        <SegmentedControl
          className="dt-compare"
          label={t("promptCompare")}
          value={shown}
          options={[
            ...(dirty ? [{ value: "saved" as const, label: t("promptCompareSaved") }] : []),
            { value: "default" as const, label: t("promptCompareDefault") },
          ]}
          onChange={setCompare}
        />
        <Button
          variant="outline"
          size="sm"
          icon={<Icon name="copy" />}
          onClick={() => {
            void navigator.clipboard
              .writeText(parts.map(part => part.text).join("\n\n"))
              .then(() => notify(t("copied")));
          }}
        >
          {t("promptCopyAll")}
        </Button>
      </div>
      {parts.map(part => {
        const { kind } = part;
        const text = sectionText(preview.config, part.name) ?? "";
        const entry = part.key === undefined ? undefined : builtIn(part.key);
        // The text a part is compared with: a team section's, or a built-in part's, override or built-in text, in the saved
        // version or the defaults; a generated part holds data and is not compared.
        const from = (config: PromptConfig) =>
          kind === "team"
            ? partWith(part, sectionText(config, part.name) ?? "")
            : kind === "fixed" && entry
              ? partText(config, entry)
              : undefined;
        const base = from(shown === "saved" ? view.current.config : view.defaults);
        const edited =
          kind === "team"
            ? !isSkill(part.name) && text !== sectionText(view.defaults, part.name)
            : !!entry && !!preview.config.overrides?.[entry.key];
        // A generated part's template the draft changed shows filled, as it is not compared.
        const template =
          kind === "generated" &&
          !!entry &&
          preview.config.overrides?.[entry.key]?.text !== view.current.config.overrides?.[entry.key]?.text;
        return (
          <section
            key={part.name}
            className="dt-preview-part"
            data-editable={kind === "team" || entry !== undefined || undefined}
          >
            <div className="dt-preview-head">
              <b>{sectionLabel(t, view, entry ? `part/${entry.key}` : part.name)}</b>
              <span>{t(KIND_LABEL[kind])}</span>
              {edited && <span className="settings-badge">{t("promptChanged")}</span>}
              {(kind === "team" || entry) && (
                <SharedButton
                  variant="link"
                  size="content"
                  type="button"
                  className="dt-textlink p-0 justify-start text-left"
                  onClick={() => onEdit(entry ? `part/${entry.key}` : part.name)}
                >
                  {t("promptEditSource")}
                </SharedButton>
              )}
            </div>
            {/* When comparing against saved, show only changes from this draft and fold the parts it leaves as they were. */}
            {base !== undefined && base !== part.text ? (
              <Diff lines={lineDiff(base, part.text)} />
            ) : shown === "saved" && !template ? (
              <Hint>{t(kind === "generated" ? "promptBuiltInFolded" : "promptSameAsSaved")}</Hint>
            ) : (
              <pre className="dt-pre">{part.text}</pre>
            )}
          </section>
        );
      })}
    </>
  );
}
