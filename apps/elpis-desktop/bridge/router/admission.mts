// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/admission.ts.
/**
 * Per-scope admission matrix classifying incoming messages as explicit requests, inferred candidates, or ignored.
 * A listed sender who addresses the agent always makes an explicit request (no table cell); an unaddressed message cannot be explicit.
 */
import type { AdmissionCell } from "./core/model.mts";

export type { AdmissionCell };
export type Admission = "explicit" | "inferred" | "ignore";
export const ADMISSION_OPTIONS = {
  listedUnaddressed: ["inferred", "ignore"],
  unlistedAddressed: ["explicit", "inferred", "ignore"],
  unlistedUnaddressed: ["inferred", "ignore"],
} as const satisfies Record<AdmissionCell, readonly Admission[]>;
export type AdmissionRow = { [C in AdmissionCell]?: (typeof ADMISSION_OPTIONS)[C][number] | undefined };
/** Default admission rules (matching pre-table behavior): unaddressed messages from listed senders are inferred candidates; unlisted senders are ignored. */
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = {
  listedUnaddressed: "inferred",
  unlistedAddressed: "ignore",
  unlistedUnaddressed: "ignore",
};
