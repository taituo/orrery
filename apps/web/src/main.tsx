import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jost";
import { App } from "./app";
import { readTheme } from "./lib/theme";
import "./styles.css";

// Apply the saved theme before the first paint (auto = no attribute).
const theme = readTheme();
if (theme !== "auto") document.documentElement.setAttribute("data-theme", theme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
