/** Display only recognizable plan names; protocol codes are not product copy. */
export function accountPlanLabel(value: string | null | undefined): string | null {
  const names: Record<string, string> = { free: "Free", plus: "Plus", pro: "Pro", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Education" };
  const key = value?.trim().toLowerCase();
  return key && Object.hasOwn(names, key) ? names[key]! : null;
}
