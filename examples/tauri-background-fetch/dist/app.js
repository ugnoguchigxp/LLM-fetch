(() => {
  "use strict";
  const invoke = window.__TAURI__?.core?.invoke;
  const form = document.querySelector("#fetch-form");
  const url = document.querySelector("#url");
  const host = document.querySelector("#host");
  const reuse = document.querySelector("#reuse");
  const summary = document.querySelector("#summary");
  const output = document.querySelector("#output");
  let sessionId;

  const show = (label, value) => {
    summary.textContent = label;
    output.textContent = JSON.stringify(value, null, 2);
  };
  const call = async (command, request) => {
    if (!invoke) throw new Error("Tauri global API is unavailable.");
    return invoke(`plugin:llm-fetch|${command}`, request === undefined ? {} : { request });
  };
  const ensureSession = async () => {
    if (sessionId) return sessionId;
    const created = await call("create_session", { allowedHosts: [host.value] });
    sessionId = created.sessionId;
    return sessionId;
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    summary.textContent = "Fetching…";
    try {
      const request = {
        requestId: crypto.randomUUID(),
        url: url.value,
        requestedUse: "summarize",
      };
      if (reuse.checked) request.sessionId = await ensureSession();
      const result = await call("fetch", request);
      show(`${result.characterCount} characters via ${result.fetchMethod}`, result);
    } catch (error) {
      show("Fetch failed", error);
    }
  });
  document.querySelector("#status").addEventListener("click", async () => {
    try {
      show("Plugin status", await call("status"));
    } catch (error) {
      show("Status failed", error);
    }
  });
  document.querySelector("#close").addEventListener("click", async () => {
    if (!sessionId) return show("No reusable session is open", {});
    try {
      show("Session closed", await call("close_session", { sessionId }));
      sessionId = undefined;
    } catch (error) {
      show("Close failed", error);
    }
  });
})();
