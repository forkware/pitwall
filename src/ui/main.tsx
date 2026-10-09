import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { connect, getState } from "./api.ts";
import { App } from "./components/App.tsx";
import { navigateToSelf, stash, takeOverReloads } from "./reload.ts";

document.documentElement.lang = navigator.language;
connect();
// Drawn before the first frame, so a view transition from the page before a reload goes straight to the app.
const root = createRoot(document.getElementById("root")!);
flushSync(() =>
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);

if (import.meta.hot) {
  takeOverReloads(
    (event, listener) => import.meta.hot!.on(event, listener),
    () => {
      stash(sessionStorage, getState().data);
      navigateToSelf(location);
    },
  );
}
