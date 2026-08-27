import { useEffect, useState } from "react";
import { api, type IdentityHealth, type Project, type UnclaimedGroup } from "../api";
import { formatDate, formatTwd } from "../format";

interface Props {
  onOpenProject: (p: Project) => void;
}

export function ProjectList({ onOpenProject }: Props) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [groups, setGroups] = useState<UnclaimedGroup[]>([]);
  const [health, setHealth] = useState<IdentityHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    api.projects().then((r) => setProjects(r.projects)).catch((e: Error) => setError(e.message));
    api.unclaimedGroups().then((r) => setGroups(r.groups)).catch(() => setGroups([]));
    api.identityHealth().then(setHealth).catch(() => setHealth(null));
  }, [reload]);

  const claim = async (group: UnclaimedGroup, projectId: string) => {
    setClaiming(group.id);
    try {
      await api.claimGroup(group.id, { projectId });
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClaiming(null);
    }
  };

  if (error) return <div className="alert error">讀取失敗：{error}</div>;
  if (!projects) return <div className="empty">載入中…</div>;

  return (
    <div>
      {/* The product leans on LINE reporting who tapped, which LINE does not
          promise. This is the earliest place that would show it changing. */}
      {health && !health.healthy && (
        <div className="alert warn">
          最近 {health.windowDays} 天有
          {health.confirmations.missingUserId > 0 && ` ${health.confirmations.missingUserId} 筆確認無法識別身分`}
          {health.confirmations.undeliveredReceipts > 0 &&
            ` ${health.confirmations.undeliveredReceipts} 筆回執未送達`}
          {health.messages.ratio !== null &&
            health.messages.ratio < 1 &&
            `，訊息帶身分比例 ${Math.round(health.messages.ratio * 100)}%`}
          。建議檢查後再繼續推播重要決策。
        </div>
      )}

      {groups.length > 0 && (
        <div className="card">
          <div className="title" style={{ marginBottom: "0.3rem" }}>待指派的群組</div>
          <div className="muted" style={{ marginBottom: "0.6rem" }}>
            機器人已加入這些群組，但尚未歸屬到案子。
            <strong>指派前不會記錄任何對話內容。</strong>請先確認群組名稱與人數無誤。
          </div>
          {groups.map((g) => (
            <div key={g.id} className="row wrap" style={{ padding: "0.5rem 0", borderTop: "1px solid var(--line)" }}>
              <div>
                <div className="title">{g.group_name_snapshot ?? "（未取得群組名稱）"}</div>
                <div className="muted mono">
                  {g.line_group_id.slice(0, 12)}…　成員 {g.member_count ?? "?"} 人　
                  {formatDate(g.joined_at)} 加入
                </div>
              </div>
              <div>
                <select
                  defaultValue=""
                  disabled={claiming === g.id || projects.length === 0}
                  onChange={(e) => e.target.value && claim(g, e.target.value)}
                >
                  <option value="" disabled>
                    指派到案子…
                  </option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: "1.05rem" }}>案子</h2>
      {projects.length === 0 ? (
        <div className="empty">還沒有案子。</div>
      ) : (
        projects.map((p) => (
          <div key={p.id} className="card clickable" onClick={() => onOpenProject(p)}>
            <div className="row wrap">
              <div>
                <div className="title">{p.name}</div>
                <div className="muted">
                  {p.client_name ? `業主：${p.client_name}　` : ""}
                  {formatDate(p.created_at)} 建立
                </div>
              </div>
              {p.contract_amount_inc_tax_cents !== null && (
                <div style={{ textAlign: "right" }}>
                  <div className="muted" style={{ fontSize: "0.76rem" }}>合約金額</div>
                  <div className="amount">{formatTwd(p.contract_amount_inc_tax_cents)}</div>
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
