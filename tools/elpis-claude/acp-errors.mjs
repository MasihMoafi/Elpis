const kindOf = error => String(error?.data?.errorKind ?? error?.errorKind ?? "").toLowerCase();

/** Translate subscription ACP failures into the error kinds the desktop recovery card understands. */
export function acpErrorInfo(error) {
  const kind = kindOf(error);
  if (/^(?:rate_limit_error|rate_limit_exceeded)$/.test(kind)) return "rateLimitExceeded";
  if (/^(?:usage_limit_reached|quota_exceeded|insufficient_quota)$/.test(kind)) return "usageLimitExceeded";

  const message = String(error?.message ?? "");
  const detail = message.replace(/^[^:\n]+ \(ACP\) error:\s*/i, "").trim();
  if (/\b(?:http(?: status)?\s*)?429\b/i.test(detail)
    || /\btoo many requests\b/i.test(detail)
    || /\brate[-_ ]?limit(?:ed|ing)\b/i.test(detail)
    || /\brate[-_ ]?limit\b.{0,40}\b(?:reached|exceeded|exhausted|error)\b/i.test(detail)
    || /\b(?:hit|reached|exceeded|exhausted)\b.{0,30}\brate[-_ ]?limit\b/i.test(detail)
    || /^rate[-_ ]?limit(?: error)?[.!]?$/i.test(detail)) return "rateLimitExceeded";
  if (/\b(?:individual|usage|weekly|monthly|daily|plan|credit)(?:\s+usage)?\s+(?:limit|quota)\s+(?:reached|exceeded|exhausted)\b/i.test(detail)
    || /\b(?:hit|reached|exceeded|exhausted)\s+(?:your\s+|the\s+)?(?:individual|usage|weekly|monthly|daily|plan|credit)(?:\s+usage)?\s+(?:limit|quota)\b/i.test(detail)
    || /\b(?:quota|usage limit)\s+(?:reached|exceeded|exhausted)\b/i.test(detail)
    || /^(?:weekly|usage) limit[.!]?$/i.test(detail)) return "usageLimitExceeded";
  return null;
}
