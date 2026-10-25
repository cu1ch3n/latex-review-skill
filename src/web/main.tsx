import { createRoot } from "react-dom/client";
import { ReviewApp } from "./review.tsx";
import { Overview } from "./overview.tsx";
import "./style.css";
const params = new URLSearchParams(location.search),
  task = params.get("task"),
  round = Number(params.get("round")) || null;
createRoot(document.getElementById("root")!).render(
  task ? <ReviewApp task={task} pinned={round} /> : <Overview />,
);
