import { useEffect, useState } from "react";
import type { Summary } from "../types.ts";
export const STATUS: Record<string, string> = {
  editing: "Editing",
  reviewing: "In review",
  revise: "Awaiting revision",
  done: "All decided",
  build_failed: "Publish failed",
  building: "Publishing",
};
export function Overview() {
  const [tasks, setTasks] = useState<(Summary & { url: string })[]>([]),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/tasks");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (!cancelled) {
          setTasks(data.tasks);
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) timer = setTimeout(poll, 2500);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  const visible = tasks.filter(
    (t) =>
      `${t.title} ${t.task}`.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "all" || t.state === filter),
  );
  return (
    <>
      <header className="bar">
        <a className="brand" href="/">
          LaTeX Review
        </a>
        <span className="status">{tasks.length} open reviews</span>
      </header>
      <main id="paper" className="index">
        <div className="document">
          <div className="overview-heading">
            <h1>All reviews</h1>
          </div>
          <div className="task-tools">
            <input
              type="search"
              aria-label="Search reviews"
              placeholder="Search by title or task name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Filter reviews"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All tasks</option>
              <option value="reviewing">Awaiting your review</option>
              <option value="building">Publishing</option>
              <option value="revise">Awaiting revision</option>
              <option value="done">All decided</option>
            </select>
          </div>
          {error && <p role="alert">{error}</p>}
          <ul className="task-list">
            {visible.map((task) => {
              const total = Object.values(task.counts).reduce(
                  (a, b) => a + b,
                  0,
                ),
                decided = total - task.counts.pending;
              return (
                <li key={task.task}>
                  <a
                    className="task-card"
                    href={`/?task=${encodeURIComponent(task.task)}`}
                  >
                    <div className="task-heading">
                      <h2>{task.title}</h2>
                      <span className="status" data-state={task.state}>
                        {STATUS[task.state]}
                      </span>
                    </div>
                    <div className="task-meta">
                      <span className="task-name">{task.task}</span>
                      <span>
                        {task.round
                          ? `Round ${task.round}`
                          : "Not published yet"}
                      </span>
                    </div>
                    {total > 0 && (
                      <div className="task-progress">
                        <span className="track">
                          <i style={{ width: `${(100 * decided) / total}%` }} />
                        </span>
                        <span>
                          {decided} of {total} decided
                        </span>
                      </div>
                    )}
                    <div className="task-footer">
                      <div className="task-counts">
                        {Object.entries(task.counts)
                          .filter(([, n]) => n)
                          .map(([kind, n]) => (
                            <span key={kind} data-kind={kind}>
                              {n} {kind}
                            </span>
                          ))}
                      </div>
                      <span className="task-open">
                        {task.counts.pending ? "Review →" : "Open →"}
                      </span>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
          {!visible.length && (
            <p className="empty">
              {tasks.length
                ? "No reviews match this filter."
                : "No open reviews yet. Start a task from your document repository."}
            </p>
          )}
        </div>
      </main>
    </>
  );
}
