function renderMiniAppHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Telegram Config Panel</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root { --bg:#0f1115; --fg:#f4f4f4; --muted:#9da3ae; --card:#1a1f29; --line:#2a3242; --accent:#6ee7b7; }
    * { box-sizing:border-box; }
    body { margin:0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--bg); color:var(--fg); }
    .wrap { max-width:760px; margin:0 auto; padding:20px; }
    h1 { margin:0 0 16px; font-size:20px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:14px; }
    label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
    input, textarea, select { width:100%; border:1px solid var(--line); border-radius:10px; background:#0c1017; color:var(--fg); padding:10px; }
    textarea { min-height:110px; resize:vertical; }
    .row { display:grid; grid-template-columns:1fr; gap:12px; }
    .btns { display:flex; gap:10px; margin-top:10px; }
    button { border:1px solid var(--line); background:#0c1017; color:var(--fg); border-radius:10px; padding:10px 14px; cursor:pointer; }
    button.primary { border-color:#1f8f6a; background:#0f2a21; color:var(--accent); }
    .status { font-size:12px; color:var(--muted); min-height:18px; margin-top:8px; }
    .hint { font-size:12px; color:var(--muted); margin-top:8px; }
    .switch { display:flex; align-items:center; gap:8px; margin-top:8px; }
    .switch input { width:auto; }
    @media (min-width:720px){ .row.two { grid-template-columns:1fr 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Telegram Runtime Config</h1>
    <div class="card">
      <div class="row two">
        <div>
          <label>Base URL</label>
          <input id="baseUrl" placeholder="https://openrouter.ai/api/v1" />
        </div>
        <div>
          <label>Model</label>
          <input id="model" placeholder="openai/gpt-4o-mini" />
        </div>
      </div>
      <div class="row">
        <div>
          <label>API Key (leave blank to keep current)</label>
          <input id="apiKey" placeholder="sk-..." />
          <div class="hint" id="apiKeyHint"></div>
        </div>
        <div>
          <label>人格提示词</label>
          <textarea id="prompt" placeholder="只作用于 Telegram 的人格提示词..."></textarea>
        </div>
      </div>
      <div class="switch">
        <input type="checkbox" id="immediateReplyEnabled" />
        <label for="immediateReplyEnabled">Immediate reply enabled</label>
      </div>
      <div class="row two" style="margin-top:8px;">
        <div>
          <label>Context window size (events)</label>
          <input id="contextEventsLimit" type="number" min="20" max="200" step="1" placeholder="100" />
          <div class="hint">Range: 20 - 200. Used by immediate reply and proactive wake.</div>
        </div>
      </div>
      <div class="row two" style="margin-top:8px;">
        <div>
          <label>窗口名（conversation_id）</label>
          <select id="conversationId"></select>
          <div class="hint">Telegram 会按这个窗口读取/写入消息上下文。</div>
        </div>
      </div>
      <div class="btns">
        <button onclick="loadCfg()">Reload</button>
        <button class="primary" onclick="saveCfg()">Save</button>
      </div>
      <div class="status" id="status"></div>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById("status");
    const apiKeyHintEl = document.getElementById("apiKeyHint");
    const initData = (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) || "";
    const apiBase = window.location.origin;
    if (window.Telegram && window.Telegram.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
    }

    function setStatus(msg) { statusEl.textContent = msg || ""; }
    function boolVal(v) { return !!v; }
    function fillConversationOptions(list, selected) {
      const el = document.getElementById("conversationId");
      const options = Array.isArray(list) ? list : [];
      const picked = selected || "";
      const normalized = [];
      const seen = new Set();
      for (const item of options) {
        const id = String((item && item.conversationId) || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        normalized.push({
          id,
          name: String((item && item.conversationName) || "").trim(),
          count: Number((item && item.messageCount) || 0),
        });
      }
      if (picked && !seen.has(picked)) {
        normalized.unshift({ id: picked, name: "", count: 0 });
      }
      if (!normalized.length) {
        normalized.push({ id: picked || "main", name: "", count: 0 });
      }
      el.innerHTML = normalized
        .map((x) => {
          const title = x.name ? x.name + " | " : "";
          const suffix = x.count > 0 ? " (" + x.count + ")" : "";
          return '<option value="' + x.id + '">' + title + x.id + suffix + "</option>";
        })
        .join("");
      el.value = picked || normalized[0].id;
    }

    async function post(path, body) {
      const resp = await fetch(apiBase + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(body || {}), initData }),
      });
      const raw = await resp.text();
      let json = null;
      try {
        json = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error("HTTP " + resp.status + ": " + (raw.slice(0, 180) || "(empty response)"));
      }
      if (!resp.ok) {
        const reason = [json.error, json.reason, json.detail].filter(Boolean).join(" | ");
        throw new Error(reason || ("HTTP " + resp.status));
      }
      return json;
    }

    async function loadCfg() {
      try {
        setStatus("Loading...");
        const cfg = await post("/api/tg-mini/config/get");
        document.getElementById("baseUrl").value = cfg.baseUrl || "";
        document.getElementById("model").value = cfg.model || "";
        document.getElementById("prompt").value = cfg.systemPrompt || "";
        document.getElementById("immediateReplyEnabled").checked = boolVal(cfg.immediateReplyEnabled);
        document.getElementById("contextEventsLimit").value = cfg.contextEventsLimit || 100;
        fillConversationOptions(cfg.availableConversations, cfg.conversationId || "main");
        apiKeyHintEl.textContent = "Current key: " + (cfg.apiKeyMasked || "(empty)");
        setStatus("Loaded.");
      } catch (e) {
        setStatus("Load failed: " + (e.message || e));
      }
    }

    async function saveCfg() {
      try {
        setStatus("Saving...");
        const payload = {
          baseUrl: document.getElementById("baseUrl").value,
          model: document.getElementById("model").value,
          apiKey: document.getElementById("apiKey").value,
          prompt: document.getElementById("prompt").value,
          immediateReplyEnabled: document.getElementById("immediateReplyEnabled").checked,
          contextEventsLimit: Number(document.getElementById("contextEventsLimit").value || 100),
          conversationId: document.getElementById("conversationId").value,
        };
        const out = await post("/api/tg-mini/config/set", payload);
        fillConversationOptions(out.availableConversations, out.conversationId || payload.conversationId || "main");
        apiKeyHintEl.textContent = "Current key: " + (out.apiKeyMasked || "(empty)");
        document.getElementById("apiKey").value = "";
        setStatus("Saved.");
      } catch (e) {
        setStatus("Save failed: " + (e.message || e));
      }
    }

    loadCfg();
  </script>
</body>
</html>`;
}

module.exports = {
  renderMiniAppHtml,
};
