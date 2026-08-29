import { useEffect, useState } from "react";
import { api, type Project } from "./api";
import { Setup } from "./views/Setup";
import { ProjectList } from "./views/ProjectList";
import { DecisionList } from "./views/DecisionList";
import { DigestList } from "./views/DigestList";
import { DecisionDetail } from "./views/DecisionDetail";

type View =
  | { name: "projects" }
  | { name: "decisions"; project: Project }
  | { name: "decision"; project: Project; decisionId: string };

export function App() {
  const [view, setView] = useState<View>({ name: "projects" });
  // null = still loading, false = no organization yet and setup must run first.
  const [ready, setReady] = useState<boolean | null>(null);
  // Bumped after a publish so the list behind reflects the new state when the
  // user navigates back.
  const [reloadKey, setReloadKey] = useState(0);
  const [tab, setTab] = useState<"digests" | "decisions">("digests");

  useEffect(() => {
    api
      .org()
      .then((r) => setReady(r.organization !== null))
      // A failure here is more likely to be a missing organization than a
      // broken deployment, and setup is harmless to show either way.
      .catch(() => setReady(false));
  }, []);

  return (
    <div className="app">
      <header className="top">
        <h1>定案</h1>
        <span className="sub">裝修決策記錄</span>
      </header>

      {ready === true && view.name !== "projects" && (
        <div className="crumbs">
          <button onClick={() => setView({ name: "projects" })}>案子</button>
          {" ／ "}
          {view.name === "decisions" ? (
            <span>{view.project.name}</span>
          ) : (
            <>
              <button onClick={() => setView({ name: "decisions", project: view.project })}>
                {view.project.name}
              </button>
              {" ／ 決策卡"}
            </>
          )}
        </div>
      )}

      {ready === null && <div className="empty">載入中…</div>}

      {ready === false && <Setup onDone={() => setReady(true)} />}

      {ready === true && view.name === "projects" && (
        <ProjectList onOpenProject={(project) => setView({ name: "decisions", project })} />
      )}

      {ready === true && view.name === "decisions" && (
        <>
          {/* Minutes first: they appear every day, where decision cards
              arrive a handful of times per project. */}
          <div className="toolbar">
            <button
              className={tab === "digests" ? "btn" : "btn ghost"}
              onClick={() => setTab("digests")}
            >
              討論記錄
            </button>
            <button
              className={tab === "decisions" ? "btn" : "btn ghost"}
              onClick={() => setTab("decisions")}
            >
              決策卡
            </button>
          </div>

          {tab === "digests" && (
            <DigestList project={view.project} onPromoted={() => setReloadKey((n) => n + 1)} />
          )}
        </>
      )}

      {ready === true && view.name === "decisions" && tab === "decisions" && (
        <DecisionList
          project={view.project}
          reloadKey={reloadKey}
          onOpenDecision={(decisionId) =>
            setView({ name: "decision", project: view.project, decisionId })
          }
        />
      )}

      {ready === true && view.name === "decision" && (
        <DecisionDetail
          decisionId={view.decisionId}
          onPublished={() => setReloadKey((n) => n + 1)}
        />
      )}

      <div className="footnote">
        本系統產出的是可驗證的決策稽核紀錄，用以輔助釐清雙方溝通過程，
        非法律文件，不等同公證或具備自動法律效力。
      </div>
    </div>
  );
}
