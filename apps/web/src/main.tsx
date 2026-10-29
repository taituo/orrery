import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";

try {
  const t = localStorage.getItem("orrery.theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch {
  /* ignore */
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
