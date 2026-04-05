const {
  kvGet,
  kvSet,
  insertMessage,
  queryRecentEvents,
  querySavedMemoriesForPrompt,
} = require("./supabase");
const {
  getTelegramConfig,
  tgGetUpdates,
  tgSendMessageChunked,
  tgSetMyCommands,
  tgSetChatMenuButton,
} = require("./telegram");
const { renderContext } = require("./render");
const { callModel } = require("./llm");
const { handleTelegramAdminCommand, telegramCommandList } = require("./tg_admin");
const { getTelegramRuntimeSettings } = require("./runtime_config");

function parseBool(v, fallback) {
  if (typeof v === "boolean") return v;
  if (v === null || v === undefined) return fallback;
  const t = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off"].includes(t)) return false;
  return fallback;
}

function sanitizeForStorage(text) {
  const raw = String(text || "");
  if (/^\/set_key\b/i.test(raw)) {
    return "/set_key [REDACTED]";
  }
  return raw;
}

function toJsonBlock(obj) {
  return JSON.stringify(obj, null, 2);
}

async function handleTelegramTextMessage(message, updateId) {
  const cfg = getTelegramConfig();
  const chatId = Number(message?.chat?.id);
  const allowed = String(cfg.allowedChatId || "");
  if (!allowed) return;
  if (String(chatId) !== allowed) {
    console.log(`[poller] ignore chat=${chatId}, allowed=${allowed}`);
    return;
  }
  const text = String(message.text || "").trim();
  if (!text) return;
  const textForStorage = sanitizeForStorage(text);
  const tgRuntime = await getTelegramRuntimeSettings();
  const chatUserKeyHash =
    String(tgRuntime.chatUserKeyHash || process.env.APP_CHAT_USER_KEY_HASH || "tg_web_bridge").trim() ||
    "tg_web_bridge";
  const conversationId = tgRuntime.conversationId || String(process.env.APP_CHAT_CONVERSATION_ID || "main").trim() || "main";

  const createdAtPlatform = Number.isFinite(message.date)
    ? new Date(message.date * 1000).toISOString()
    : null;
  const userEvent = await insertMessage({
    user_key_hash: chatUserKeyHash,
    conversation_id: conversationId,
    platform: "telegram",
    role: "user",
    chat_id: chatId,
    message_id: message.message_id ?? null,
    update_id: updateId ?? null,
    content: textForStorage,
    created_at_platform: createdAtPlatform,
  });

  await kvSet(`tg_last_user_msg_at_${chatId}`, new Date().toISOString());

  const admin = await handleTelegramAdminCommand(text);
  if (admin.handled) {
    const sentAdmin = await tgSendMessageChunked(chatId, admin.reply || "ok");
    for (const item of sentAdmin) {
      const m = item.telegramMessage;
      await insertMessage({
        user_key_hash: chatUserKeyHash,
        conversation_id: conversationId,
        platform: "telegram",
        role: "assistant",
        chat_id: chatId,
        message_id: m?.message_id ?? null,
        update_id: null,
        content: item.chunk,
        created_at_platform: Number.isFinite(m?.date) ? new Date(m.date * 1000).toISOString() : null,
        metadata_json: {
          is_admin_reply: true,
          parent_event_id: userEvent?.id ?? null,
          parent_event_role: "user",
          parent_event_type: "telegram_user_message",
        },
      });
    }
    return;
  }

  const immediate = parseBool(await kvGet("tg_immediate_reply_enabled", true), true);
  if (!immediate) {
    console.log("[poller] tg_immediate_reply_enabled=false, skip immediate reply");
    return;
  }

  const contextLimit = tgRuntime.contextEventsLimit || 100;
  const recentEvents = await queryRecentEvents({
    limit: contextLimit,
    chatId,
    conversationId,
    userKeyHash: chatUserKeyHash,
  });
  const memoryLines = await querySavedMemoriesForPrompt({
    limit: Math.max(1, Math.min(Number(process.env.TG_MEMORY_ITEMS_LIMIT || 120) || 120, 500)),
  });
  const extraSystem = [
    "\u4f60\u662f\u4e00\u4e2a\u6e29\u548c\u3001\u771f\u8bda\u7684\u5bf9\u8bdd\u52a9\u624b\u3002",
    "\u5982\u6709\u5fc5\u8981\u53ef\u4ee5\u8c03\u7528\u5de5\u5177 get_current_time \u83b7\u53d6\u5f53\u524d\u771f\u5b9e\u65f6\u95f4\u3002",
  ];
  if (tgRuntime.systemPrompt) {
    extraSystem.push(
      `【人格提示词】\n${toJsonBlock({
        persona_prompt: tgRuntime.systemPrompt,
      })}`
    );
  }
  if (memoryLines.length) {
    extraSystem.push(
      `【记忆库】\n${toJsonBlock({
        memory_items: memoryLines,
      })}`
    );
  }
  const messages = renderContext("telegram", recentEvents, {
    extraSystem,
  });
  let reply = "";
  try {
    reply = (await callModel(messages, [], { proactive: false, scope: "telegram" })).trim();
  } catch (err) {
    const detail = err?.response?.status
      ? `HTTP ${err.response.status}`
      : (err?.message || String(err));
    console.error(`[poller] model call failed: ${detail}`);
    const hint = "抱歉，我刚才调用模型失败了。请先用 /cfg 检查 base_url、model、api_key。";
    await tgSendMessageChunked(chatId, hint);
    return;
  }
  if (!reply) return;

  const splitByNewline = parseBool(process.env.TG_SPLIT_BY_NEWLINE, false);
  const sent = await tgSendMessageChunked(
    chatId,
    reply,
    splitByNewline ? { splitByNewline: true } : {}
  );
  for (const item of sent) {
    const m = item.telegramMessage;
    await insertMessage({
      user_key_hash: chatUserKeyHash,
      conversation_id: conversationId,
      platform: "telegram",
      role: "assistant",
      chat_id: chatId,
      message_id: m?.message_id ?? null,
      update_id: null,
      content: item.chunk,
      created_at_platform: Number.isFinite(m?.date) ? new Date(m.date * 1000).toISOString() : null,
      metadata_json: {
        parent_event_id: userEvent?.id ?? null,
        parent_event_role: "user",
        parent_event_type: "telegram_user_message",
      },
    });
  }
}

async function startTelegramPoller() {
  let cfg;
  try {
    cfg = getTelegramConfig();
  } catch (err) {
    console.log(`[poller] disabled: ${err.message || err}`);
    return;
  }
  const chatId = String(cfg.allowedChatId || "").trim();
  if (!chatId) {
    console.log("[poller] TG_ALLOWED_CHAT_ID missing; poller disabled.");
    return;
  }

  const offsetKey = `tg_offset_${chatId}`;
  let offsetValue = await kvGet(offsetKey, null);
  let offset = Number.isInteger(offsetValue) ? offsetValue : Number(offsetValue);
  if (!Number.isInteger(offset)) offset = undefined;

  try {
    await tgSetMyCommands(telegramCommandList());
    console.log("[poller] telegram command menu updated");
  } catch (err) {
    console.warn("[poller] setMyCommands failed:", err.message || err);
  }

  const miniAppUrl = String(process.env.TG_MINIAPP_URL || "").trim();
  if (miniAppUrl) {
    try {
      await tgSetChatMenuButton(miniAppUrl);
      console.log("[poller] chat menu mini app button updated");
    } catch (err) {
      console.warn("[poller] setChatMenuButton failed:", err.message || err);
    }
  }

  console.log("[poller] started");
  while (true) {
    try {
      const updates = await tgGetUpdates({
        offset,
        timeoutSec: cfg.pollingTimeoutSec,
      });
      if (!updates.length) continue;

      for (const update of updates) {
        const updateId = Number(update.update_id);
        if (Number.isInteger(updateId)) {
          offset = updateId + 1;
          await kvSet(offsetKey, offset);
        }
        const message = update.message;
        if (!message || typeof message.text !== "string") continue;
        await handleTelegramTextMessage(message, updateId);
      }
    } catch (err) {
      console.error("[poller] loop error:", err.message || err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

module.exports = {
  startTelegramPoller,
};
