import { useEffect, useState } from "react";
import { api, type ConfirmedTotals, type DecisionSummary, type Project } from "../api";
import { STATUS_LABEL, formatDate, formatTwd } from "../format";

interface Props {
  project: Project;
  onOpenDecision: (id: string) => void;
  reloadKey: number;
}

export function DecisionList({ project, onOpenDecision, reloadKey }: Props) {
  const [decisions, setDecisions] = useState<DecisionSummary[] | null>(null);
  const [totals, setTotals] = useState<ConfirmedTotals | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .decisions(project.id)
      .then((r) => {
        setDecisions(r.decisions);
        setTotals(r.confirmedTotals);
      })
      .catch((e: Error) => setError(e.message));
  }, [project.id, reloadKey]);

  if (error) return <div className="alert error">讀取失敗：{error}</div>;
  if (!decisions) return <div className="empty">載入中…</div>;

  const needsAttention = decisions.filter(
    (d) => d.unidentified > 0 || d.undelivered_receipts > 0,
  );

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: "0.9rem" }}>
        <div>
          <h2 style={{ margin: 0 }}>{project.name}</h2>
          {project.client_name && <div className="muted">業主：{project.client_name}</div>}
        </div>
      </div>

      {needsAttention.length > 0 && (
        <div className="alert warn">
          有 {needsAttention.length} 張卡片需要處理：
          {needsAttention.map((d) => d.decision_no).join("、")}
          （身分無法識別或回執未送達）
        </div>
      )}

      {totals && (
        <div className="totals">
          <div>
            <span className="label">已確認追加</span>
            <span className="amount add">{totals.additionsText}</span>
          </div>
          <div>
            <span className="label">已確認減帳</span>
            <span className="amount sub">{totals.deductionsText}</span>
          </div>
          <div>
            <span className="label">淨額</span>
            <span className={`amount ${totals.net >= 0 ? "add" : "sub"}`}>{totals.netText}</span>
          </div>
        </div>
      )}

      <div className="toolbar">
        {/* Defaults to confirmed items: this is what goes to the client with an
            invoice, and billing for something they never agreed to is the
            dispute the product exists to prevent. */}
        <a className="btn ghost" href={api.exportUrl(project.id)} style={{ textDecoration: "none" }}>
          匯出追加減帳表（已確認）
        </a>
        <a className="btn ghost" href={api.exportUrl(project.id, true)} style={{ textDecoration: "none" }}>
          匯出全部項目
        </a>
      </div>

      {decisions.length === 0 ? (
        <div className="empty">這個案子還沒有決策卡。</div>
      ) : (
        decisions.map((d) => (
          <div key={d.id} className="card clickable" onClick={() => onOpenDecision(d.id)}>
            <div className="row wrap">
              <div>
                <span className="muted mono">
                  {d.decision_no}
                  {d.version > 1 ? ` v${d.version}` : ""}
                </span>
                <div className="title">{d.title}</div>
                <div className="muted">
                  {d.status === "pending" && d.required_approval_count > 1
                    ? `${d.approvals}/${d.required_approval_count} 已確認`
                    : d.decided_at
                      ? `${formatDate(d.decided_at)} 定案`
                      : d.published_at
                        ? `${formatDate(d.published_at)} 推播`
                        : "尚未推播"}
                  {d.schedule_delta_days !== 0 &&
                    `　工期${d.schedule_delta_days > 0 ? "＋" : "－"}${Math.abs(d.schedule_delta_days)}天`}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className={`amount ${d.amount_inc_tax_cents >= 0 ? "add" : "sub"}`}>
                  {formatTwd(d.amount_inc_tax_cents, { withSign: true })}
                </div>
                <span
                  className={`badge ${d.status === "confirmed" ? "green" : d.status === "rejected" ? "red" : ""}`}
                >
                  {STATUS_LABEL[d.status] ?? d.status}
                </span>
                {d.unidentified > 0 && <span className="badge warn" style={{ marginLeft: 4 }}>身分待確認</span>}
                {d.undelivered_receipts > 0 && (
                  <span className="badge red" style={{ marginLeft: 4 }}>回執未送達</span>
                )}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
