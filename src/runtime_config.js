const { kvGet, kvSet } = require("./supabase");

const KEYS = {
  tgBaseUrl: "tg_llm_base_url",
  tgApiKey: "tg_llm_api_key",
  tgModel: "tg_llm_model",
  tgPrompt: "tg_system_prompt",
  tgImmediate: "tg_immediate_reply_enabled",
  tgContextLimit: "tg_context_events_limit",
  tgConversationId: "tg_conversation_id",
  tgChatUserKeyHash: "tg_chat_user_key_hash",
};

function safeText(v) {
  return typeof v === "string" ? v.trim() : "";
}

function redactSecret(secret) {
  const s = safeText(secret);
  if (!s) return "(empty)";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function clampContextEventsLimit(value, fallback = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(20, Math.min(Math.round(n), 200));
}

function normalizeConversationId(value, fallback = "main") {
  const raw = safeText(value);
  if (!raw) return fallback || "main";
  return raw.slice(0, 160);
}

async function getTelegramLlmConfig() {
  const envBase = safeText(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1");
  const envKey = safeText(process.env.OPENAI_API_KEY || "");
  const envModel = safeText(process.env.OPENAI_MODEL || "gpt-4o-mini");

  const [kvBase, kvKey, kvModel] = await Promise.all([
    kvGet(KEYS.tgBaseUrl, null),
    kvGet(KEYS.tgApiKey, null),
    kvGet(KEYS.tgModel, null),
  ]);

  return {
    baseUrl: safeText(kvBase) || envBase,
    apiKey: safeText(kvKey) || envKey,
    model: safeText(kvModel) || envModel,
  };
}

async function getTelegramRuntimeSettings() {
  const llm = await getTelegramLlmConfig();
  const envContextLimit = clampContextEventsLimit(
    process.env.TG_CONTEXT_EVENTS_LIMIT || 100,
    100
  );
  const envConversationId = normalizeConversationId(process.env.APP_CHAT_CONVERSATION_ID || "main", "main");
  const envUserKeyHash = safeText(process.env.APP_CHAT_USER_KEY_HASH || "tg_web_bridge");
  const [kvPrompt, kvImmediate, kvContextLimit, kvConversationId, kvChatUserKeyHash] = await Promise.all([
    kvGet(KEYS.tgPrompt, null),
    kvGet(KEYS.tgImmediate, true),
    kvGet(KEYS.tgContextLimit, null),
    kvGet(KEYS.tgConversationId, null),
    kvGet(KEYS.tgChatUserKeyHash, null),
  ]);
  const immediate =
    kvImmediate === true || String(kvImmediate || "").trim().toLowerCase() === "true";
  return {
    ...llm,
    systemPrompt: safeText(kvPrompt),
    immediateReplyEnabled: immediate,
    contextEventsLimit: clampContextEventsLimit(kvContextLimit, envContextLimit),
    conversationId: normalizeConversationId(kvConversationId, envConversationId),
    chatUserKeyHash: safeText(kvChatUserKeyHash) || envUserKeyHash,
  };
}

async function setTelegramLlmBaseUrl(baseUrl) {
  await kvSet(KEYS.tgBaseUrl, safeText(baseUrl));
}

async function setTelegramLlmApiKey(apiKey) {
  await kvSet(KEYS.tgApiKey, safeText(apiKey));
}

async function setTelegramLlmModel(model) {
  await kvSet(KEYS.tgModel, safeText(model));
}

async function setTelegramSystemPrompt(prompt) {
  await kvSet(KEYS.tgPrompt, safeText(prompt));
}

async function setTelegramImmediateReplyEnabled(enabled) {
  await kvSet(KEYS.tgImmediate, Boolean(enabled));
}

async function setTelegramContextEventsLimit(limit) {
  await kvSet(KEYS.tgContextLimit, clampContextEventsLimit(limit, 100));
}

async function setTelegramConversationId(conversationId) {
  await kvSet(
    KEYS.tgConversationId,
    normalizeConversationId(conversationId, process.env.APP_CHAT_CONVERSATION_ID || "main")
  );
}

async function setTelegramChatUserKeyHash(userKeyHash) {
  const key = safeText(userKeyHash);
  if (!key) return;
  await kvSet(KEYS.tgChatUserKeyHash, key);
}

module.exports = {
  KEYS,
  redactSecret,
  clampContextEventsLimit,
  normalizeConversationId,
  getTelegramLlmConfig,
  getTelegramRuntimeSettings,
  setTelegramLlmBaseUrl,
  setTelegramLlmApiKey,
  setTelegramLlmModel,
  setTelegramSystemPrompt,
  setTelegramImmediateReplyEnabled,
  setTelegramContextEventsLimit,
  setTelegramConversationId,
  setTelegramChatUserKeyHash,
};
