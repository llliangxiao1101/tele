const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const APP_CHAT_USER_KEY_HASH = String(
  process.env.APP_CHAT_USER_KEY_HASH || "tg_web_bridge"
).trim();
const APP_CHAT_CONVERSATION_ID = String(
  process.env.APP_CHAT_CONVERSATION_ID || "main"
).trim();
const APP_MEMORY_USER_KEY_HASH = String(
  process.env.APP_MEMORY_USER_KEY_HASH ||
    process.env.TG_MEMORY_USER_KEY_HASH ||
    APP_CHAT_USER_KEY_HASH
).trim();
const HAS_EXPLICIT_MEMORY_KEY = Boolean(
  String(process.env.APP_MEMORY_USER_KEY_HASH || process.env.TG_MEMORY_USER_KEY_HASH || "").trim()
);

function normalizeConversationId(value, fallback = APP_CHAT_CONVERSATION_ID || "main") {
  const raw = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (!raw) return fallback || "main";
  return raw.slice(0, 160);
}

async function kvGet(key, fallback = null) {
  const { data, error } = await supabase.from("kv").select("value").eq("key", key).maybeSingle();
  if (error) {
    throw new Error(`kvGet(${key}) failed: ${error.message}`);
  }
  if (!data) return fallback;
  return data.value;
}

async function kvSet(key, value) {
  const payload = { key, value, updated_at: new Date().toISOString() };
  const { error } = await supabase.from("kv").upsert(payload, { onConflict: "key" });
  if (error) {
    throw new Error(`kvSet(${key}) failed: ${error.message}`);
  }
  return true;
}

function normalizeMetadata(event) {
  const metadata =
    event && event.metadata_json && typeof event.metadata_json === "object"
      ? { ...event.metadata_json }
      : {};
  if (event.chat_id !== null && event.chat_id !== undefined) {
    metadata.chat_id = event.chat_id;
  }
  if (event.message_id !== null && event.message_id !== undefined) {
    metadata.message_id = event.message_id;
  }
  if (event.update_id !== null && event.update_id !== undefined) {
    metadata.update_id = event.update_id;
  }
  if (event.created_at_platform) {
    metadata.created_at_platform = event.created_at_platform;
  }
  return metadata;
}

function mapRowToEvent(row) {
  const metadata = row?.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
  return {
    id: row?.id ?? null,
    platform: row?.platform || "web",
    role: row?.role || "user",
    content: row?.content || "",
    created_at: row?.created_at || null,
    chat_id: metadata.chat_id ?? null,
    message_id: metadata.message_id ?? null,
    update_id: metadata.update_id ?? null,
    created_at_platform: metadata.created_at_platform ?? null,
    metadata_json: metadata,
  };
}

function formatMemoryTimestampForPrompt(rawTimestamp) {
  const text = typeof rawTimestamp === "string" ? rawTimestamp.trim() : "";
  if (!text) return "";
  const dt = new Date(text);
  if (!Number.isFinite(dt.getTime())) return "";
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(dt);
  const find = (type) => parts.find((p) => p.type === type)?.value || "";
  const yyyy = find("year");
  const mm = find("month");
  const dd = find("day");
  const hh = find("hour");
  const mi = find("minute");
  if (!yyyy || !mm || !dd || !hh || !mi) return "";
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeMemoryLine(row, index) {
  const metadata =
    row?.metadata_json && typeof row.metadata_json === "object" && !Array.isArray(row.metadata_json)
      ? row.metadata_json
      : {};
  const confirmed = metadata.confirmed !== false;
  const head = `${confirmed ? "记忆" : "候选"} ${String(index + 1)}`;
  const ts = formatMemoryTimestampForPrompt(
    metadata.timestamp || metadata.created_at || row?.created_at || ""
  );
  const safeTitle = String(metadata.memory_id || "").trim() || "未命名";
  const oneLineContent = String(row?.content || "")
    .replace(/\s+/g, " ")
    .trim();
  const oneLineAnchor = String(metadata.anchor_quote || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLineContent) return "";
  const tsPart = ts ? ` [${ts}]` : "";
  const anchorPart = oneLineAnchor ? ` 引用: "${oneLineAnchor}"` : "";
  return `${head}${tsPart} {${safeTitle}}: ${oneLineContent}${anchorPart}`;
}

async function insertMessage(event) {
  const userKeyHash = String(event?.user_key_hash || APP_CHAT_USER_KEY_HASH).trim() || APP_CHAT_USER_KEY_HASH;
  const conversationId = normalizeConversationId(event?.conversation_id, APP_CHAT_CONVERSATION_ID);
  const row = {
    user_key_hash: userKeyHash,
    conversation_id: conversationId,
    platform: event.platform || "web",
    role: event.role,
    content: event.content,
    metadata_json: normalizeMetadata(event),
  };
  const { data, error } = await supabase
    .from("app_chat_messages")
    .insert(row)
    .select("*")
    .single();
  if (error) {
    throw new Error(`insertMessage failed: ${error.message}`);
  }
  return mapRowToEvent(data);
}

async function queryRecentEvents({ limit = 100, chatId = null, conversationId = null, userKeyHash = null } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const fetchLimit = Math.max(safeLimit, Math.min(safeLimit * 4, 1000));
  const resolvedConversationId = normalizeConversationId(conversationId, APP_CHAT_CONVERSATION_ID);
  const resolvedUserKeyHash =
    String(userKeyHash === null || userKeyHash === undefined ? APP_CHAT_USER_KEY_HASH : userKeyHash).trim() ||
    APP_CHAT_USER_KEY_HASH;
  const { data, error } = await supabase
    .from("app_chat_messages")
    .select("id, platform, role, content, created_at, metadata_json")
    .eq("user_key_hash", resolvedUserKeyHash)
    .eq("conversation_id", resolvedConversationId)
    .is("deleted_at", null)
    .order("id", { ascending: false })
    .limit(fetchLimit);

  if (error) {
    throw new Error(`queryRecentEvents failed: ${error.message}`);
  }
  let rows = (data || []).map(mapRowToEvent);
  if (chatId !== null && chatId !== undefined) {
    const chatIdText = String(chatId);
    rows = rows.filter((item) => {
      if (item.platform !== "telegram") return true;
      return String(item.chat_id ?? "") === chatIdText;
    });
  }
  rows = rows.reverse();
  return rows.slice(-safeLimit);
}

async function queryConversationOptions({ userKeyHash = null, limit = 200 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
  const fetchLimit = Math.max(safeLimit, Math.min(safeLimit * 30, 6000));
  const resolvedUserKeyHash =
    String(userKeyHash === null || userKeyHash === undefined ? APP_CHAT_USER_KEY_HASH : userKeyHash).trim() ||
    APP_CHAT_USER_KEY_HASH;

  const { data, error } = await supabase
    .from("app_chat_messages")
    .select("conversation_id, created_at")
    .eq("user_key_hash", resolvedUserKeyHash)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(fetchLimit);

  if (error) {
    throw new Error(`queryConversationOptions failed: ${error.message}`);
  }

  const seen = new Map();
  for (const row of data || []) {
    const conversationId = normalizeConversationId(row?.conversation_id, "");
    if (!conversationId) continue;
    if (!seen.has(conversationId)) {
      seen.set(conversationId, {
        conversationId,
        conversationName: "",
        messageCount: 0,
        lastCreatedAt: row?.created_at || null,
      });
      if (seen.size >= safeLimit) break;
    }
    const item = seen.get(conversationId);
    item.messageCount += 1;
  }

  try {
    const syncRow = await supabase
      .from("app_sync_state")
      .select("state_json, updated_at")
      .eq("user_key_hash", resolvedUserKeyHash)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const state = syncRow?.data?.state_json;
    const sessions = Array.isArray(state?.sessions)
      ? state.sessions
      : Array.isArray(state?.conversations)
      ? state.conversations
      : [];
    const nameById = new Map();
    for (const s of sessions) {
      const id = normalizeConversationId(s?.id, "");
      if (!id) continue;
      const name = String(s?.name || "").trim();
      if (name && !nameById.has(id)) nameById.set(id, name);
    }
    for (const item of seen.values()) {
      item.conversationName = nameById.get(item.conversationId) || "";
    }
  } catch {
    // noop: name enrichment is best-effort
  }

  return Array.from(seen.values());
}

async function queryChatUserKeyOptions({ limit = 30 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
  const fetchLimit = Math.max(2000, Math.min(safeLimit * 400, 20000));
  const { data, error } = await supabase
    .from("app_chat_messages")
    .select("user_key_hash, conversation_id, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(fetchLimit);
  if (error) {
    throw new Error(`queryChatUserKeyOptions failed: ${error.message}`);
  }
  const byKey = new Map();
  for (const row of data || []) {
    const key = String(row?.user_key_hash || "").trim();
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, {
        userKeyHash: key,
        messageCount: 0,
        conversationCount: 0,
        lastCreatedAt: row?.created_at || null,
        _conversations: new Set(),
      });
    }
    const item = byKey.get(key);
    item.messageCount += 1;
    const cid = normalizeConversationId(row?.conversation_id, "");
    if (cid && !item._conversations.has(cid)) {
      item._conversations.add(cid);
      item.conversationCount += 1;
    }
  }
  return Array.from(byKey.values())
    .map((item) => ({
      userKeyHash: item.userKeyHash,
      messageCount: item.messageCount,
      conversationCount: item.conversationCount,
      lastCreatedAt: item.lastCreatedAt,
    }))
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, safeLimit);
}

async function querySavedMemoriesForPrompt({ limit = 120, userKeyHash = null } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 120, 500));
  let keyHash = String(
    userKeyHash === null || userKeyHash === undefined ? APP_MEMORY_USER_KEY_HASH : userKeyHash
  ).trim();
  if (!keyHash) return [];

  const fetchLimit = Math.max(safeLimit, Math.min(safeLimit * 4, 1000));
  let { data, error } = await supabase
    .from("app_saved_memories")
    .select("id, content, metadata_json, created_at, user_key_hash")
    .eq("user_key_hash", keyHash)
    .order("id", { ascending: true })
    .limit(fetchLimit);

  if (error) {
    throw new Error(`querySavedMemoriesForPrompt failed: ${error.message}`);
  }

  // Auto-fallback for single-user setups: if current key has no memory rows,
  // pick latest memory owner key unless user explicitly pinned memory key.
  if ((!data || !data.length) && !HAS_EXPLICIT_MEMORY_KEY) {
    const alt = await supabase
      .from("app_saved_memories")
      .select("user_key_hash")
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!alt.error && alt.data && String(alt.data.user_key_hash || "").trim()) {
      const latestKey = String(alt.data.user_key_hash).trim();
      if (latestKey && latestKey !== keyHash) {
        keyHash = latestKey;
        const retry = await supabase
          .from("app_saved_memories")
          .select("id, content, metadata_json, created_at, user_key_hash")
          .eq("user_key_hash", keyHash)
          .order("id", { ascending: true })
          .limit(fetchLimit);
        if (retry.error) {
          throw new Error(`querySavedMemoriesForPrompt fallback failed: ${retry.error.message}`);
        }
        data = retry.data || [];
      }
    }
  }

  const sorted = (data || [])
    .slice()
    .sort((a, b) => {
      const metaA =
        a?.metadata_json && typeof a.metadata_json === "object" && !Array.isArray(a.metadata_json)
          ? a.metadata_json
          : {};
      const metaB =
        b?.metadata_json && typeof b.metadata_json === "object" && !Array.isArray(b.metadata_json)
          ? b.metadata_json
          : {};
      const orderA = toFiniteNumber(metaA.order_index);
      const orderB = toFiniteNumber(metaB.order_index);
      if (orderA !== null && orderB !== null && orderA !== orderB) return orderA - orderB;
      if (orderA !== null && orderB === null) return -1;
      if (orderA === null && orderB !== null) return 1;
      return (Number(a?.id) || 0) - (Number(b?.id) || 0);
    })
    .slice(0, safeLimit);

  return sorted.map((row, idx) => normalizeMemoryLine(row, idx)).filter(Boolean);
}

async function ensureDefaultKv() {
  const key = "tg_immediate_reply_enabled";
  const current = await kvGet(key, null);
  if (current === null) {
    const defaultVal = String(process.env.TG_IMMEDIATE_REPLY_DEFAULT || "true")
      .trim()
      .toLowerCase();
    const enabled = !["false", "0", "off", "no"].includes(defaultVal);
    await kvSet(key, enabled);
  }
}

module.exports = {
  supabase,
  kvGet,
  kvSet,
  insertMessage,
  insertEvent: insertMessage,
  queryRecentEvents,
  queryConversationOptions,
  queryChatUserKeyOptions,
  querySavedMemoriesForPrompt,
  normalizeConversationId,
  ensureDefaultKv,
};
