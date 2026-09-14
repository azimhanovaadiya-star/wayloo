import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Offline vision-model cache (best-effort): the service worker intercepts the
// one-time TensorFlow.js model download and serves it from Cache Storage on
// later runs, so WAYLO's vision engine works fully offline once installed.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline caching is best-effort — the model still loads when online */
    });
  });
}
