/**
 * Dashboard API client.
 *
 * Requests are relative: in production the same worker serves both the page
 * and the API, and in development Vite proxies /api across. Cloudflare Access
 * sits in front of the whole origin, so there are no tokens to attach here.
 */

export interface Project {
  id: string;
  name: string;
  client_name: string | null;
  status: string;
  contract_amount_inc_tax_cents: number | null;
  created_at: number;
}

export type DecisionStatus =
  | "draft"
  | "pending"
  | "confirmed"
  | "rejected"
  | "request_changes"
  | "expired"
  | "withdrawn";

export interface DecisionSummary {
  id: string;
  decision_no: string;
  version: number;
  title: string;
  status: DecisionStatus;
  amount_inc_tax_cents: number;
  schedule_delta_days: number;
  required_approval_count: number;
  published_at: number | null;
  decided_at: number | null;
  approvals: number;
  /** Taps that arrived without an attributable sender. */
  unidentified: number;
  /** Confirmations whose group receipt never went out. */
  undelivered_receipts: number;
}

export interface ConfirmedTotals {
  additions: number;
  deductions: number;
  net: number;
  additionsText: string;
  deductionsText: string;
  netText: string;
}

export interface Confirmation {
  id: string;
  version: number;
  action: "confirm" | "reject" | "request_changes";
  channel: string;
  confirmed_by_user_id: string | null;
  identity_source: string;
  identity_confidence: "whitelisted" | "asserted" | "seen_before" | "unknown";
  resolution_status: "resolved" | "unidentified" | "late" | "revoked" | "superseded";
  display_name_snapshot: string | null;
  declared_name: string | null;
  declared_role: string | null;
  confirm_text: string;
  content_sha256_at_confirm: string;
  line_event_timestamp: number | null;
  server_received_at: number;
  receipt_status: "pending" | "sent" | "failed";
  created_at: number;
}

export interface DecisionLineItem {
  id: string;
  seq: number;
  area: string | null;
  description: string;
  spec_note: string | null;
  unit: string;
  quantity_milli: number;
  unit_price_cents: number;
  line_total_cents: number;
}

export interface DecisionDetail {
  decision: Record<string, unknown> & {
    id: string;
    decision_no: string;
    version: number;
    title: string;
    status: DecisionStatus;
    change_scope: string | null;
    change_reason: string | null;
    amount_ex_tax_cents: number;
    amount_tax_cents: number;
    amount_inc_tax_cents: number;
    schedule_delta_days: number;
    required_approval_count: number;
  };
  lineItems: DecisionLineItem[];
  confirmations: Confirmation[];
}

export interface UnclaimedGroup {
  id: string;
  line_group_id: string;
  group_name_snapshot: string | null;
  member_count: number | null;
  joined_at: number;
}

export interface IdentityHealth {
  windowDays: number;
  messages: { total: number; withUserId: number; ratio: number | null };
  confirmations: { total: number; missingUserId: number; undeliveredReceipts: number };
  healthy: boolean;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // Surface the server's own wording; these errors are things a designer can
    // act on ("no active owner group for this project"), not stack traces.
    try {
      const parsed = JSON.parse(text) as { error?: string; detail?: string };
      throw new Error(parsed.detail ? `${parsed.error}（${parsed.detail}）` : (parsed.error ?? text));
    } catch (e) {
      if (e instanceof Error && e.message !== text) throw e;
      throw new Error(text);
    }
  }
  return JSON.parse(text) as T;
}

export interface DigestSummary {
  id: string;
  digest_date: string;
  message_count: number;
  segment_count: number;
  status: "draft" | "reviewed" | "published" | "dismissed" | "failed";
  summary_text: string | null;
  edited_at: number | null;
  published_at: number | null;
  error: string | null;
  created_at: number;
  item_count: number;
}

export interface DigestItem {
  id: string;
  seq: number;
  kind: "decision" | "pending" | "cost" | "schedule" | "note";
  title: string;
  detail: string | null;
  amount_inc_tax_cents: number | null;
  amount_verbatim: string | null;
  source_message_ids: string;
  promoted_decision_id: string | null;
}

export interface DigestSourceMessage {
  line_message_id: string;
  display_name_snapshot: string | null;
  text_content: string | null;
  line_timestamp: number;
}

export interface DigestDetail {
  digest: DigestSummary & { id: string };
  items: DigestItem[];
  sources: DigestSourceMessage[];
}

export interface Organization {
  id: string;
  name: string;
  tax_id: string | null;
  timezone: string;
}

export const api = {
  org: () => get<{ organization: Organization | null }>("/org"),

  createOrg: (body: { name: string; taxId?: string }) =>
    post<{ ok: true; id: string; name: string }>("/org", body),

  projects: () => get<{ projects: Project[] }>("/projects"),

  createProject: (body: {
    name: string;
    clientName?: string;
    siteAddress?: string;
    contractAmountIncTaxCents?: number;
  }) => post<{ ok: true; id: string; name: string }>("/projects", body),

  decisions: (projectId: string) =>
    get<{ decisions: DecisionSummary[]; confirmedTotals: ConfirmedTotals }>(
      `/projects/${projectId}/decisions`,
    ),

  decision: (id: string) => get<DecisionDetail>(`/decisions/${id}`),

  publish: (id: string, body: { lineGroupId?: string; expiresAt?: number } = {}) =>
    post<{ ok: true; version: number; contentSha256: string }>(`/decisions/${id}/publish`, body),

  unclaimedGroups: () => get<{ groups: UnclaimedGroup[] }>("/groups/unclaimed"),

  claimGroup: (id: string, body: { projectId: string; purpose?: string }) =>
    post<{ ok: true }>(`/groups/${id}/claim`, body),

  digests: (projectId: string) =>
    get<{ digests: DigestSummary[] }>(`/projects/${projectId}/digests`),

  digest: (id: string) => get<DigestDetail>(`/digests/${id}`),

  runDigest: (projectId: string, hours?: number) =>
    post<{ ok: true; digestId: string; itemCount: number; dropped: Array<{ title: string; reason: string }> }>(
      `/projects/${projectId}/digests/run`,
      hours ? { hours } : {},
    ),

  editDigest: (id: string, summaryText: string) =>
    post<{ ok: true }>(`/digests/${id}/edit`, { summaryText }),

  publishDigest: (id: string) => post<{ ok: true }>(`/digests/${id}/publish`, {}),

  promoteDigestItem: (id: string) =>
    post<{ ok: true; decisionId: string; decisionNo: string }>(`/digest-items/${id}/promote`, {}),

  identityHealth: () => get<IdentityHealth>("/health/identity"),

  exportUrl: (projectId: string, all = false) =>
    `/api/projects/${projectId}/export.csv${all ? "?all=1" : ""}`,
};
