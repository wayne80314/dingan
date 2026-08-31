import { useEffect, useState } from "react";
import { api, type DecisionDetail as Detail } from "../api";
import {
  ACTION_LABEL,
  IDENTITY_LABEL,
  STATUS_LABEL,
  formatDateTime,
  formatQuantity,
  formatTwd,
} from "../format";

interface Props {
  decisionId: string;
  onPublished: () => void;
}

export function DecisionDetail({ decisionId, onPublished }: Props) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [resending, setResending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => {
    api
      .decision(decisionId)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  };

  useEffect(load, [decisionId]);

  if (error) return <div className="alert error">讀取失敗：{error}</div>;
  if (!data) return <div className="empty">載入中…</div>;

  const d = data.decision;
  const canPublish = d.status === "draft" || d.status === "request_changes";

  const publish = async () => {
    setPublishing(true);
    setNotice(null);
    try {
      const r = await api.publish(decisionId);
      setNotice(`已推播到群組（版本 v${r.version}）。業主確認後，群組會出現回執。`);
      load();
      onPublished();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  const resend = async () => {
    setResending(true);
    setNotice(null);
    try {
      await api.resendDecision(decisionId);
      setNotice("已重新送出卡片，請確認群組是否收到。");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResending(false);
    }
  };

  const approvals = data.confirmations.filter(
    (c) => c.action === "confirm" && c.confirmed_by_user_id,
  ).length;
  const unidentified = data.confirmations.filter((c) => c.resolution_status === "unidentified");
  const undelivered = data.confirmations.filter((c) => c.receipt_status !== "sent");

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: "0.8rem" }}>
        <div>
          <span className="muted mono">
            {d.decision_no}
            {d.version > 1 ? ` v${d.version}` : ""}
          </span>
          <h2 style={{ margin: "0.2rem 0" }}>{d.title}</h2>
        </div>
        <span className={`badge ${d.status === "confirmed" ? "green" : d.status === "rejected" ? "red" : ""}`}>
          {STATUS_LABEL[d.status] ?? d.status}
        </span>
      </div>

      {notice && <div className="alert info">{notice}</div>}

      {/* Both of these mean the record has a hole in it, so they sit above the
          content rather than beside it. */}
      {unidentified.length > 0 && (
        <div className="alert warn">
          有 {unidentified.length} 次點擊無法識別身分，尚未計為確認。
          請業主直接在群組傳一則「我確認 {d.decision_no}」的訊息，訊息一定帶得到身分資訊。
        </div>
      )}
      {undelivered.length > 0 && (
        <div className="alert error">
          有 {undelivered.length} 筆確認的群組回執未送達。
          對群組裡的人來說，沒看到回執等同於沒發生過，建議在群組補一句說明。
        </div>
      )}

      <div className="card">
        {d.change_scope && (
          <p style={{ marginTop: 0 }}>
            <span className="muted">變更範圍：</span>
            {d.change_scope}
          </p>
        )}
        {d.change_reason && (
          <p>
            <span className="muted">原因：</span>
            {d.change_reason}
          </p>
        )}

        <div className="row wrap" style={{ marginTop: "0.9rem" }}>
          <div>
            <div className="muted" style={{ fontSize: "0.78rem" }}>
              {d.amount_inc_tax_cents >= 0 ? "追加金額（含稅）" : "減帳金額（含稅）"}
            </div>
            <div className={`amount big ${d.amount_inc_tax_cents >= 0 ? "add" : "sub"}`}>
              {formatTwd(d.amount_inc_tax_cents, { withSign: true })}
            </div>
            <div className="muted" style={{ fontSize: "0.78rem" }}>
              未稅 {formatTwd(d.amount_ex_tax_cents, { withSign: true })}／稅額{" "}
              {formatTwd(d.amount_tax_cents, { withSign: true })}
            </div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: "0.78rem" }}>工期影響</div>
            <div className="amount">
              {d.schedule_delta_days === 0
                ? "無"
                : d.schedule_delta_days > 0
                  ? `延後 ${d.schedule_delta_days} 天`
                  : `提前 ${Math.abs(d.schedule_delta_days)} 天`}
            </div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: "0.78rem" }}>確認進度</div>
            <div className="amount">
              {approvals}/{d.required_approval_count}
            </div>
          </div>
        </div>
      </div>

      {data.lineItems.length > 0 && (
        <div className="card">
          <div className="title" style={{ marginBottom: "0.5rem" }}>明細</div>
          <table>
            <thead>
              <tr>
                <th>項目</th>
                <th className="num">數量</th>
                <th className="num">單價</th>
                <th className="num">小計</th>
              </tr>
            </thead>
            <tbody>
              {data.lineItems.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.area ? `${i.area}／` : ""}
                    {i.description}
                    {i.spec_note && <div className="muted">{i.spec_note}</div>}
                  </td>
                  <td className="num">
                    {formatQuantity(i.quantity_milli)} {i.unit}
                  </td>
                  <td className="num">{formatTwd(i.unit_price_cents)}</td>
                  <td className="num">{formatTwd(i.line_total_cents, { withSign: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="title" style={{ marginBottom: "0.5rem" }}>確認紀錄</div>
        {data.confirmations.length === 0 ? (
          <div className="muted">尚無任何回應。</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>回應</th>
                <th>確認人</th>
                <th>身分依據</th>
                <th>時間</th>
                <th>回執</th>
              </tr>
            </thead>
            <tbody>
              {data.confirmations.map((c) => {
                const identity = IDENTITY_LABEL[c.identity_confidence] ?? {
                  text: c.identity_confidence,
                  tone: "weak" as const,
                };
                const name =
                  c.declared_name ?? c.display_name_snapshot ?? (c.confirmed_by_user_id ? "（無名稱）" : "無法識別");
                return (
                  <tr key={c.id}>
                    <td>
                      <span className={`badge ${c.action === "confirm" ? "green" : "red"}`}>
                        {ACTION_LABEL[c.action] ?? c.action}
                      </span>
                      {c.resolution_status === "late" && (
                        <span className="badge warn" style={{ marginLeft: 4 }}>逾期後補</span>
                      )}
                    </td>
                    <td>
                      {name}
                      {c.declared_role && <div className="muted">{c.declared_role}</div>}
                    </td>
                    <td>
                      <span className={`badge identity-${identity.tone}`}>{identity.text}</span>
                    </td>
                    <td className="muted">{formatDateTime(c.server_received_at)}</td>
                    <td>
                      {c.receipt_status === "sent" ? (
                        <span className="muted">已送達</span>
                      ) : (
                        <span className="badge red">未送達</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {d.status === "pending" && (
        <div className="toolbar">
          <button className="btn ghost" onClick={resend} disabled={resending}>
            {resending ? "重送中…" : "重新送出卡片"}
          </button>
          <span className="muted" style={{ alignSelf: "center" }}>
            若群組沒收到卡片，可以再送一次。
          </span>
        </div>
      )}

      {canPublish && (
        <div className="toolbar">
          <button className="btn" onClick={publish} disabled={publishing}>
            {publishing ? "推播中…" : "推播到業主群組"}
          </button>
          <span className="muted" style={{ alignSelf: "center" }}>
            推播後業主會在 LINE 收到卡片，點擊即記錄確認人與時間。
          </span>
        </div>
      )}
    </div>
  );
}
