/** Display only recognizable plan names; protocol codes are not product copy. */
export function accountPlanLabel(value: string | null | undefined): string | null {
  const names: Record<string, string> = { free: "Free", plus: "Plus", pro: "Pro", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Education" };
  return typeof value === "string" ? names[value.trim().toLowerCase()] ?? null : null;
}
