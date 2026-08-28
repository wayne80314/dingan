import { useState } from "react";
import { api } from "../api";

interface Props {
  onDone: () => void;
}

/**
 * First run.
 *
 * Everything else hangs off an organization row, so before one exists the
 * dashboard has nothing to show and no way forward. This is the one screen
 * that has to work against an empty database.
 */
export function Setup({ onDone }: Props) {
  const [name, setName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.createOrg({ name: name.trim(), taxId: taxId.trim() || undefined });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: "1.05rem" }}>初次設定</h2>
      <div className="card">
        <div className="muted" style={{ marginBottom: "0.9rem" }}>
          先登記您的公司，之後建立的案子與決策紀錄都會歸屬在這個名稱底下。
          公司名稱會出現在匯出的追加減帳表上。
        </div>

        {error && <div className="alert error">{error}</div>}

        <div style={{ display: "grid", gap: "0.6rem", maxWidth: 420 }}>
          <label>
            <div className="muted">公司／工作室名稱（必填）</div>
            <input
              autoFocus
              value={name}
              placeholder="例：示範室內設計有限公司"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              style={{ width: "100%" }}
            />
          </label>
          <label>
            <div className="muted">統一編號（選填，會印在請款附件上）</div>
            <input
              inputMode="numeric"
              value={taxId}
              placeholder="例：12345678"
              onChange={(e) => setTaxId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              style={{ width: "100%" }}
            />
          </label>
          <div>
            <button className="btn" onClick={submit} disabled={saving || !name.trim()}>
              {saving ? "建立中…" : "完成設定"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
