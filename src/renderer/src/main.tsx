import "@fontsource/commit-mono/400.css";
import "@fontsource/commit-mono/400-italic.css";
import "@fontsource/commit-mono/500.css";
import "@fontsource/commit-mono/700.css";
import "@fontsource/ibm-plex-sans-condensed/400.css";
import "@fontsource/ibm-plex-sans-condensed/500.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CrashScreen } from "./components/Crash";

document.documentElement.dataset.platform = window.moire.platform;

// A button clicked with the mouse gives focus back, so the next shortcut neither draws a focus ring on it nor presses it again.
document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button") : null;
  if (event.detail > 0 && button && button === document.activeElement) button.blur();
}, true);

// Dev-only: MOIRE_PREFS='{"theme":"light","layout":"unified","file":"src/a.ts"}' presets the UI for screenshots.
const { prefs } = await window.moire.devHooks();
for (const [key, value] of Object.entries(prefs ?? {})) localStorage.setItem(`moire.${key}`, value);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
);
