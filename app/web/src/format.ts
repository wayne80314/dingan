/**
 * Display helpers.
 *
 * Money formatting mirrors src/core/money.ts rather than importing it: the
 * worker and the browser are separate bundles, and the shape here is small
 * enough that duplicating it beats wiring up shared-module resolution. The
 * behaviour that matters — cents, explicit signs — is covered by tests on the
 * server side.
 */

export function formatTwd(cents: number, opts: { withSign?: boolean } = {}): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  const body =
    frac === 0
      ? whole.toLocaleString("zh-TW")
      : `${whole.toLocaleString("zh-TW")}.${String(frac).padStart(2, "0")}`;
  const sign = negative ? "-" : opts.withSign && cents !== 0 ? "+" : "";
  return `${sign}NT$${body}`;
}

export function formatQuantity(quantityMilli: number): string {
  const negative = quantityMilli < 0;
  const abs = Math.abs(quantityMilli);
  return `${negative ? "-" : ""}${Math.trunc(abs / 1000)}.${String(abs % 1000).padStart(3, "0")}`;
}

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  pending: "待確認",
  confirmed: "已確認",
  rejected: "不同意",
  request_changes: "要求修改",
  expired: "已逾期",
  withdrawn: "已撤回",
};

/**
 * How the recorded identity should be described.
 *
 * These are deliberately not interchangeable. A name the designer entered on
 * someone's behalf is weaker evidence than one that person supplied, and
 * showing both as "confirmed by 陳大明" would overstate what the record proves
 * at exactly the moment someone is relying on it.
 */
export const IDENTITY_LABEL: Record<string, { text: string; tone: "strong" | "medium" | "weak" }> = {
  whitelisted: { text: "本人登錄", tone: "strong" },
  asserted: { text: "設計師指定", tone: "medium" },
  seen_before: { text: "曾在群組發言", tone: "weak" },
  unknown: { text: "身分未知", tone: "weak" },
};

export const ACTION_LABEL: Record<string, string> = {
  confirm: "確認",
  reject: "不同意",
  request_changes: "要求修改",
};
