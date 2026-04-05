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
  tgDownloadImageAsDataUrl,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(ms) || 1)));
}

function parseIsoMs(v) {
  const t = Date.parse(String(v || "").trim());
  return Number.isFinite(t) ? t : null;
}

function makePollerOwnerId() {
  const host = String(process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || "local").trim();
  return `poller:${host}:${process.pid}`;
}

async function tryAcquirePollerLock({ lockKey, ownerId, leaseMs }) {
  const nowMs = Date.now();
  const current = await kvGet(lockKey, null);
  const currentOwner = String(current?.owner || "").trim();
  const currentExpireMs = parseIsoMs(current?.expires_at);
  const lockActive = Boolean(currentOwner && currentExpireMs && currentExpireMs > nowMs);

  if (lockActive && currentOwner !== ownerId) {
    const retryAfterMs = Math.max(1000, Math.min(currentExpireMs - nowMs, 5000));
    return { acquired: false, owner: currentOwner, retryAfterMs };
  }

  await kvSet(lockKey, {
    owner: ownerId,
    expires_at: new Date(nowMs + leaseMs).toISOString(),
    updated_at: new Date(nowMs).toISOString(),
  });

  const verify = await kvGet(lockKey, null);
  const verifyOwner = String(verify?.owner || "").trim();
  const verifyExpireMs = parseIsoMs(verify?.expires_at);
  const acquired = Boolean(verifyOwner === ownerId && verifyExpireMs && verifyExpireMs > Date.now());
  if (!acquired) {
    return { acquired: false, owner: verifyOwner || "unknown", retryAfterMs: 2000 };
  }
  return { acquired: true, owner: ownerId, retryAfterMs: 0 };
}

function pickLargestTelegramPhoto(photoSizes) {
  const list = Array.isArray(photoSizes) ? photoSizes : [];
  if (!list.length) return null;
  let best = null;
  let bestScore = -1;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const fileId = String(item.file_id || "").trim();
    if (!fileId) continue;
    const bySize = Number(item.file_size);
    const byResolution = Number(item.width || 0) * Number(item.height || 0);
    const score = Number.isFinite(bySize) && bySize > 0 ? bySize : byResolution;
    if (!Number.isFinite(score) || score <= bestScore) continue;
    best = item;
    bestScore = score;
  }
  return best;
}

function extractTelegramIncomingInput(message) {
  const text = String(message?.text || message?.caption || "").trim();
  let imageFileId = "";
  let imageMimeType = "";

  const bestPhoto = pickLargestTelegramPhoto(message?.photo);
  if (bestPhoto) {
    imageFileId = String(bestPhoto.file_id || "").trim();
    imageMimeType = "image/jpeg";
  }

  const doc = message?.document;
  if (!imageFileId && doc && typeof doc === "object") {
    const docMime = String(doc.mime_type || "").trim().toLowerCase();
    if (docMime.startsWith("image/")) {
      imageFileId = String(doc.file_id || "").trim();
      imageMimeType = docMime;
    }
  }

  return {
    text,
    imageFileId,
    imageMimeType,
  };
}

function buildStoredUserContent({ text = "", hasImage = false } = {}) {
  const safeText = String(text || "").trim();
  if (safeText) return safeText;
  if (hasImage) return "[image]";
  return "";
}

function buildMultimodalUserContent({ text = "", imageDataUrl = "" } = {}) {
  const parts = [];
  const promptText =
    String(text || "").trim() || "Please analyze this image and provide a concise summary.";
  parts.push({
    type: "text",
    text: promptText,
  });
  const safeImageDataUrl = String(imageDataUrl || "").trim();
  if (safeImageDataUrl) {
    parts.push({
      type: "image_url",
      image_url: {
        url: safeImageDataUrl,
      },
    });
  }
  return parts;
}

function replaceLastUserMessageContentWithMultimodal(messages, multimodalContent) {
  const list = Array.isArray(messages) ? [...messages] : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (!item || item.role !== "user") continue;
    list[i] = {
      ...item,
      content: multimodalContent,
    };
    return list;
  }
  list.push({
    role: "user",
    content: multimodalContent,
  });
  return list;
}

async function handleTelegramMessage(message, updateId) {
  const cfg = getTelegramConfig();
  const chatId = Number(message?.chat?.id);
  const allowed = String(cfg.allowedChatId || "");
  if (!allowed) return;
  if (String(chatId) !== allowed) {
    console.log(`[poller] ignore chat=${chatId}, allowed=${allowed}`);
    return;
  }

  const input = extractTelegramIncomingInput(message);
  const text = input.text;
  if (!text && !input.imageFileId) return;

  let imageDataUrl = "";
  if (input.imageFileId) {
    try {
      imageDataUrl = await tgDownloadImageAsDataUrl({
        fileId: input.imageFileId,
        mimeTypeHint: input.imageMimeType,
      });
      console.log(`[poller] downloaded telegram image file_id=${input.imageFileId}`);
    } catch (err) {
      console.warn(
        `[poller] telegram image download failed file_id=${input.imageFileId} err=${err?.message || err}`
      );
    }
  }

  const textForStorage = sanitizeForStorage(text);
  const tgRuntime = await getTelegramRuntimeSettings();
  const chatUserKeyHash =
    String(tgRuntime.chatUserKeyHash || process.env.APP_CHAT_USER_KEY_HASH || "tg_web_bridge").trim() ||
    "tg_web_bridge";
  const conversationId =
    tgRuntime.conversationId || String(process.env.APP_CHAT_CONVERSATION_ID || "main").trim() || "main";

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
    content: buildStoredUserContent({
      text: textForStorage,
      hasImage: Boolean(input.imageFileId),
    }),
    created_at_platform: createdAtPlatform,
    metadata_json: {
      ...(input.imageFileId
        ? {
            has_image: true,
            image_file_id: input.imageFileId,
            image_mime_type: input.imageMimeType || "",
            image_downloaded: Boolean(imageDataUrl),
          }
        : {}),
    },
  });

  await kvSet(`tg_last_user_msg_at_${chatId}`, new Date().toISOString());

  if (textForStorage) {
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
      `銆愪汉鏍兼彁绀鸿瘝銆慭n${toJsonBlock({
        persona_prompt: tgRuntime.systemPrompt,
      })}`
    );
  }
  if (memoryLines.length) {
    extraSystem.push(
      `銆愯蹇嗗簱銆慭n${toJsonBlock({
        memory_items: memoryLines,
      })}`
    );
  }
  const baseMessages = renderContext("telegram", recentEvents, {
    extraSystem,
  });
  const messages = imageDataUrl
    ? replaceLastUserMessageContentWithMultimodal(
        baseMessages,
        buildMultimodalUserContent({
          text: textForStorage,
          imageDataUrl,
        })
      )
    : baseMessages;

  if (input.imageFileId && !imageDataUrl && !textForStorage) {
    const hint = "I received the image, but failed to download it. Please resend it or add a short text note.";
    await tgSendMessageChunked(chatId, hint);
    return;
  }

  let reply = "";
  try {
    reply = (await callModel(messages, [], { proactive: false, scope: "telegram" })).trim();
  } catch (err) {
    const detail = err?.response?.status
      ? `HTTP ${err.response.status}`
      : err?.message || String(err);
    console.error(`[poller] model call failed: ${detail}`);
    const hint =
      "\u62b1\u6b49\uff0c\u6211\u521a\u624d\u8c03\u7528\u6a21\u578b\u5931\u8d25\u4e86\u3002\u8bf7\u5148\u7528 /cfg \u68c0\u67e5 base_url\u3001model\u3001api_key\u3002";
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
        parent_event_type: input.imageFileId
          ? "telegram_user_message_with_image"
          : "telegram_user_message",
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

  const lockEnabled = parseBool(process.env.TG_POLLER_LOCK_ENABLED, true);
  const lockKey = `tg_poller_lock_${chatId}`;
  const ownerId = makePollerOwnerId();
  const lockLeaseMs = Math.max(
    (Number(cfg.pollingTimeoutSec) || 20) * 1000 + 10000,
    Number(process.env.TG_POLLER_LOCK_LEASE_MS || 90000) || 90000
  );
  let hasLeaderLock = false;

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
      if (lockEnabled) {
        const lock = await tryAcquirePollerLock({
          lockKey,
          ownerId,
          leaseMs: lockLeaseMs,
        });
        if (!lock.acquired) {
          if (hasLeaderLock) {
            console.warn(`[poller] leader lock lost, owner=${lock.owner}`);
            hasLeaderLock = false;
          }
          await sleep(lock.retryAfterMs || 2000);
          continue;
        }
        if (!hasLeaderLock) {
          hasLeaderLock = true;
          console.log(`[poller] leader lock acquired owner=${ownerId}`);
        }
      }

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
        if (!message) continue;
        await handleTelegramMessage(message, updateId);
      }
    } catch (err) {
      if (Number(err?.response?.status) === 409) {
        hasLeaderLock = false;
        console.warn("[poller] 409 conflict detected, will retry with lock backoff");
        await sleep(5000);
        continue;
      }
      console.error("[poller] loop error:", err.message || err);
      await sleep(3000);
    }
  }
}

module.exports = {
  startTelegramPoller,
};
