import { useEffect, useState } from "react";
import { api, type DigestDetail, type DigestSummary, type Project } from "../api";
import { formatDateTime, formatTwd } from "../format";

interface Props {
  project: Project;
  onPromoted: () => void;
}

const KIND_LABEL: Record<string, string> = {
  decision: "已談定",
  pending: "待確認",
  cost: "費用",
  schedule: "工期",
  note: "備註",
};

const KIND_TONE: Record<string, string> = {
  decision: "green",
  cost: "warn",
  schedule: "warn",
  pending: "",
  note: "",
};

/**
 * Daily minutes.
 *
 * Read before the client sees anything: the whole reason the digest is held
 * back is that a person checks it first. So the interface leads with what the
 * summary is (a set of candidates), keeps every claim next to the messages it
 * came from, and makes publishing a deliberate act rather than the default.
 */
export function DigestList({ project, onPromoted }: Props) {
  const [digests, setDigests] = useState<DigestSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DigestDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    api
      .digests(project.id)
      .then((r) => setDigests(r.digests))
      .catch((e: Error) => setError(e.message));
  }, [project.id, reload]);

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    api
      .digest(openId)
      .then((d) => {
        setDetail(d);
        setDraft(d.digest.summary_text ?? "");
      })
      .catch((e: Error) => setError(e.message));
  }, [openId, reload]);

  if (error) return <div className="alert error">讀取失敗：{error}</div>;
  if (!digests) return <div className="empty">載入中…</div>;

  const save = async () => {
    if (!openId) return;
    setBusy(true);
    try {
      await api.editDigest(openId, draft);
      setNotice("已儲存修改。");
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!openId) return;
    setBusy(true);
    try {
      await api.publishDigest(openId);
      setNotice("已發佈到群組。");
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const promote = async (itemId: string) => {
    setBusy(true);
    try {
      const r = await api.promoteDigestItem(itemId);
      setNotice(`已建立決策卡草稿 ${r.decisionNo}，可到決策卡頁面補齊內容後推播。`);
      setReload((n) => n + 1);
      onPromoted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sourceText = (ids: string[]): string[] =>
    ids
      .map((id) => detail?.sources.find((s) => s.line_message_id === id))
      .filter(Boolean)
      .map((s) => `${s!.display_name_snapshot ?? "（未知）"}：${s!.text_content ?? ""}`);

  return (
    <div>
      {notice && <div className="alert info">{notice}</div>}

      {digests.length === 0 && (
        <div className="empty">
          還沒有討論記錄。機器人會在每天晚上整理當日對話，安靜的日子不會產生。
        </div>
      )}

      {digests.map((d) => {
        const isOpen = openId === d.id;
        return (
          <div key={d.id} className="card">
            <div
              className="row wrap"
              style={{ cursor: "pointer" }}
              onClick={() => setOpenId(isOpen ? null : d.id)}
            >
              <div>
                <div className="title">{d.digest_date} 討論記錄</div>
                <div className="muted">
                  {d.message_count} 則訊息／{d.item_count} 項重點
                  {d.segment_count > 1 && `　（討論量大，分 ${d.segment_count} 段處理）`}
                  {d.edited_at && "　已編修"}
                </div>
              </div>
              <div>
                {d.status === "published" ? (
                  <span className="badge green">已發佈</span>
                ) : d.status === "failed" ? (
                  <span className="badge red">整理失敗</span>
                ) : (
                  <span className="badge">待檢視</span>
                )}
              </div>
            </div>

            {isOpen && detail && detail.digest.id === d.id && (
              <div style={{ marginTop: "0.9rem", borderTop: "1px solid var(--line)", paddingTop: "0.9rem" }}>
                {d.status === "failed" ? (
                  <div className="alert error">整理失敗：{d.error ?? "未知原因"}</div>
                ) : (
                  <>
                    {/* Stated plainly, because the difference between a
                        suggestion and a record is the entire safety argument. */}
                    <div className="alert warn">
                      以下是 AI 依當日對話整理的<strong>決策候選</strong>，可能有誤或遺漏。
                      發佈到群組前請先確認內容，發佈後業主會看到。
                    </div>

                    {detail.items.map((item) => {
                      const ids = (() => {
                        try {
                          return JSON.parse(item.source_message_ids) as string[];
                        } catch {
                          return [];
                        }
                      })();
                      return (
                        <div key={item.id} style={{ padding: "0.6rem 0", borderBottom: "1px solid var(--line)" }}>
                          <div className="row wrap">
                            <div style={{ flex: 1 }}>
                              <span className={`badge ${KIND_TONE[item.kind] ?? ""}`}>
                                {KIND_LABEL[item.kind] ?? item.kind}
                              </span>{" "}
                              <strong>{item.title}</strong>
                              {item.amount_inc_tax_cents !== null && (
                                <span
                                  className={`amount ${item.amount_inc_tax_cents >= 0 ? "add" : "sub"}`}
                                  style={{ marginLeft: 8 }}
                                >
                                  {formatTwd(item.amount_inc_tax_cents, { withSign: true })}
                                </span>
                              )}
                              {item.detail && <div className="muted">{item.detail}</div>}

                              {/* Every claim sits next to what it came from,
                                  so it can be checked instead of trusted. */}
                              {sourceText(ids).length > 0 && (
                                <details style={{ marginTop: "0.3rem" }}>
                                  <summary className="muted" style={{ cursor: "pointer", fontSize: "0.82rem" }}>
                                    對照原始訊息（{ids.length} 則）
                                  </summary>
                                  <div className="muted" style={{ fontSize: "0.82rem", paddingTop: "0.3rem" }}>
                                    {sourceText(ids).map((t, i) => (
                                      <div key={i}>・{t}</div>
                                    ))}
                                  </div>
                                </details>
                              )}
                            </div>
                            <div>
                              {item.promoted_decision_id ? (
                                <span className="muted">已建卡</span>
                              ) : item.kind === "decision" || item.kind === "cost" ? (
                                <button
                                  className="btn ghost small"
                                  disabled={busy}
                                  onClick={() => promote(item.id)}
                                >
                                  轉成決策卡
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    <div style={{ marginTop: "0.9rem" }}>
                      <div className="muted" style={{ marginBottom: "0.3rem" }}>
                        發佈到群組的內容（可直接修改）
                      </div>
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={Math.min(16, Math.max(6, draft.split("\n").length + 1))}
                        style={{
                          width: "100%",
                          font: "inherit",
                          padding: "0.5rem",
                          border: "1px solid var(--line)",
                          borderRadius: 8,
                          lineHeight: 1.6,
                        }}
                      />
                    </div>

                    <div className="toolbar" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
                      <button className="btn ghost" onClick={save} disabled={busy}>
                        儲存修改
                      </button>
                      {d.status !== "published" && (
                        <button className="btn" onClick={publish} disabled={busy || !draft.trim()}>
                          發佈到群組
                        </button>
                      )}
                      {d.status === "published" && (
                        <span className="muted" style={{ alignSelf: "center" }}>
                          已於 {formatDateTime(d.published_at)} 發佈
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
