require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const {
  ensureDefaultKv,
  insertMessage,
  queryRecentEvents,
  queryConversationOptions,
  queryChatUserKeyOptions,
} = require("./supabase");
const { renderContext } = require("./render");
const { callModel } = require("./llm");
const { startTelegramPoller } = require("./poller");
const { startProactiveScheduler } = require("./proactive");
const { getCurrentTime } = require("./time_tool");
const { renderMiniAppHtml } = require("./miniapp_page");
const {
  redactSecret,
  getTelegramRuntimeSettings,
  setTelegramLlmBaseUrl,
  setTelegramLlmApiKey,
  setTelegramLlmModel,
  setTelegramSystemPrompt,
  setTelegramImmediateReplyEnabled,
  setTelegramContextEventsLimit,
  setTelegramConversationId,
  setTelegramChatUserKeyHash,
} = require("./runtime_config");

function numberEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function firstUserMessage(body) {
  if (typeof body?.message === "string" && body.message.trim()) {
    return body.message.trim();
  }
  if (Array.isArray(body?.messages)) {
    const u = [...body.messages]
      .reverse()
      .find((m) => m && m.role === "user" && typeof m.content === "string" && m.content.trim());
    return u?.content?.trim() || "";
  }
  return "";
}

function parseBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  if (v === null || v === undefined) return fallback;
  const t = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off"].includes(t)) return false;
  return fallback;
}

function verifyTelegramWebAppInitData(initData, botToken) {
  const raw = String(initData || "").trim();
  const token = String(botToken || "").trim();
  if (!raw || !token) return { ok: false, reason: "missing_init_data_or_token" };

  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing_hash" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const isValid = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
  if (!isValid) return { ok: false, reason: "bad_signature" };

  let userId = null;
  const userRaw = params.get("user");
  if (userRaw) {
    try {
      userId = JSON.parse(userRaw)?.id ?? null;
    } catch {}
  }
  return { ok: true, userId };
}

async function boot() {
  await ensureDefaultKv();

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      now: new Date().toISOString(),
      time: getCurrentTime(),
    });
  });

  app.get("/miniapp", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(renderMiniAppHtml());
  });

  async function verifyMiniAppRequest(req, res, next) {
    try {
      const insecure = parseBool(process.env.TG_MINIAPP_ALLOW_INSECURE, false);
      if (insecure) return next();
      const initData = String(req.body?.initData || "").trim();
      const botToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
      const out = verifyTelegramWebAppInitData(initData, botToken);
      if (!out.ok) {
        return res.status(401).json({ error: "miniapp_auth_failed", reason: out.reason });
      }
      const allowedChatId = String(process.env.TG_ALLOWED_CHAT_ID || "").trim();
      if (allowedChatId && String(out.userId || "") !== allowedChatId) {
        return res.status(403).json({ error: "forbidden_user" });
      }
      return next();
    } catch (err) {
      return res.status(401).json({ error: "miniapp_auth_failed", detail: err.message || String(err) });
    }
  }

  app.post("/api/tg-mini/config/get", verifyMiniAppRequest, async (_req, res) => {
    try {
      const cfg = await getTelegramRuntimeSettings();
      const selectedUserKeyHash = String(cfg.chatUserKeyHash || "").trim();
      const availableUserKeys = await queryChatUserKeyOptions({ limit: 50 });
      const availableConversations = await queryConversationOptions({
        limit: 200,
        userKeyHash: selectedUserKeyHash,
      });
      if (!availableConversations.some((x) => x.conversationId === cfg.conversationId)) {
        availableConversations.unshift({
          conversationId: cfg.conversationId,
          conversationName: "",
          messageCount: 0,
          lastCreatedAt: null,
        });
      }
      return res.json({
        ok: true,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        systemPrompt: cfg.systemPrompt,
        immediateReplyEnabled: cfg.immediateReplyEnabled,
        contextEventsLimit: cfg.contextEventsLimit,
        conversationId: cfg.conversationId,
        chatUserKeyHash: selectedUserKeyHash,
        availableUserKeys,
        availableConversations,
        apiKeyMasked: redactSecret(cfg.apiKey),
      });
    } catch (err) {
      return res.status(500).json({ error: "config_get_failed", detail: err.message || String(err) });
    }
  });

  app.post("/api/tg-mini/config/set", verifyMiniAppRequest, async (req, res) => {
    try {
      const baseUrl = String(req.body?.baseUrl || "").trim();
      const model = String(req.body?.model || "").trim();
      const apiKey = String(req.body?.apiKey || "").trim();
      const prompt = String(req.body?.prompt || "").trim();
      const immediate = parseBool(req.body?.immediateReplyEnabled, true);
      const contextEventsLimit = req.body?.contextEventsLimit;
      const conversationId = String(req.body?.conversationId || "").trim();
      const chatUserKeyHash = String(req.body?.chatUserKeyHash || "").trim();

      if (baseUrl) await setTelegramLlmBaseUrl(baseUrl);
      if (model) await setTelegramLlmModel(model);
      if (apiKey) await setTelegramLlmApiKey(apiKey);
      await setTelegramSystemPrompt(prompt);
      await setTelegramImmediateReplyEnabled(immediate);
      if (contextEventsLimit !== undefined && contextEventsLimit !== null && String(contextEventsLimit).trim() !== "") {
        await setTelegramContextEventsLimit(contextEventsLimit);
      }
      if (conversationId) {
        await setTelegramConversationId(conversationId);
      }
      if (chatUserKeyHash) {
        await setTelegramChatUserKeyHash(chatUserKeyHash);
      }

      const cfg = await getTelegramRuntimeSettings();
      const selectedUserKeyHash = String(cfg.chatUserKeyHash || "").trim();
      const availableUserKeys = await queryChatUserKeyOptions({ limit: 50 });
      const availableConversations = await queryConversationOptions({
        limit: 200,
        userKeyHash: selectedUserKeyHash,
      });
      if (!availableConversations.some((x) => x.conversationId === cfg.conversationId)) {
        availableConversations.unshift({
          conversationId: cfg.conversationId,
          conversationName: "",
          messageCount: 0,
          lastCreatedAt: null,
        });
      }
      return res.json({
        ok: true,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        systemPrompt: cfg.systemPrompt,
        immediateReplyEnabled: cfg.immediateReplyEnabled,
        contextEventsLimit: cfg.contextEventsLimit,
        conversationId: cfg.conversationId,
        chatUserKeyHash: selectedUserKeyHash,
        availableUserKeys,
        availableConversations,
        apiKeyMasked: redactSecret(cfg.apiKey),
      });
    } catch (err) {
      return res.status(500).json({ error: "config_set_failed", detail: err.message || String(err) });
    }
  });

  async function handleWebChat(req, res) {
    try {
      const userText = firstUserMessage(req.body);
      if (!userText) {
        return res.status(400).json({ error: "message is required" });
      }

      const userEvent = await insertMessage({
        platform: "web",
        role: "user",
        content: userText,
      });

      const limit = numberEnv(
        "WEB_CONTEXT_EVENTS_LIMIT",
        100,
        20,
        200
      );
      const recentEvents = await queryRecentEvents({ limit });
      const messages = renderContext("web", recentEvents, {
        extraSystem: [
          "\u5982\u6709\u5fc5\u8981\u53ef\u4ee5\u8c03\u7528\u5de5\u5177 get_current_time \u83b7\u53d6\u5f53\u524d\u771f\u5b9e\u65f6\u95f4\u3002",
        ],
      });
      const reply = (await callModel(messages, [], { scope: "web" })).trim();

      await insertMessage({
        platform: "web",
        role: "assistant",
        content: reply || "\u6211\u5728\u3002",
        metadata_json: {
          parent_event_id: userEvent?.id ?? null,
          parent_event_role: "user",
          parent_event_type: "web_user_message",
        },
      });

      return res.json({ reply: reply || "\u6211\u5728\u3002" });
    } catch (err) {
      console.error("[web] /api/web/chat error:", err.message || err);
      return res.status(500).json({ error: "internal_error", detail: err.message || String(err) });
    }
  }

  app.post("/api/web/chat", handleWebChat);

  app.post("/api/chat", async (req, res) => {
    return handleWebChat(req, res);
  });

  const host = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
  const port = numberEnv("PORT", 3310, 1, 65535);
  app.listen(port, host, () => {
    console.log(`[server] listening on ${host}:${port}`);
    console.log("[server] immediate reply default is controlled by kv.tg_immediate_reply_enabled");
  });

  startTelegramPoller().catch((err) => {
    console.error("[poller] fatal:", err.message || err);
  });
  startProactiveScheduler();
}

boot().catch((err) => {
  console.error("[boot] fatal:", err.message || err);
  process.exit(1);
});
