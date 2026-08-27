import { useState } from "react";
import type { Project } from "./api";
import { ProjectList } from "./views/ProjectList";
import { DecisionList } from "./views/DecisionList";
import { DecisionDetail } from "./views/DecisionDetail";

type View =
  | { name: "projects" }
  | { name: "decisions"; project: Project }
  | { name: "decision"; project: Project; decisionId: string };

export function App() {
  const [view, setView] = useState<View>({ name: "projects" });
  // Bumped after a publish so the list behind reflects the new state when the
  // user navigates back.
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="app">
      <header className="top">
        <h1>定案</h1>
        <span className="sub">裝修決策記錄</span>
      </header>

      {view.name !== "projects" && (
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

      {view.name === "projects" && (
        <ProjectList onOpenProject={(project) => setView({ name: "decisions", project })} />
      )}

      {view.name === "decisions" && (
        <DecisionList
          project={view.project}
          reloadKey={reloadKey}
          onOpenDecision={(decisionId) =>
            setView({ name: "decision", project: view.project, decisionId })
          }
        />
      )}

      {view.name === "decision" && (
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
