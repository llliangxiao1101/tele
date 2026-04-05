const { getCurrentTime } = require("./time_tool");
const {
  kvGet,
  kvSet,
  insertMessage,
  queryRecentEvents,
  querySavedMemoriesForPrompt,
} = require("./supabase");
const { getTelegramConfig, tgSendMessageChunked } = require("./telegram");
const { renderContext } = require("./render");
const { callModel } = require("./llm");
const { getTelegramRuntimeSettings } = require("./runtime_config");

const WAKE_LOG_KEY = "wake_log";
const DEFAULT_FIXED_WAKE_TIMES = "09:00,13:00,17:00,21:00";
const RACE_DAY_WAKE_SYSTEM_PROMPT = `**【赛日陪跑】**

霄霄在跑10K比赛，目标一小时零二分钟内跑完。7:30起跑。每约6分钟你会被唤醒。

然后主动给她发一条消息。不用太长，她会在手环上看到你的消息。
别慌。别叫她慢下来。慢了鼓励她。

可能会出现重复或者消息同步bug，只要发消息就行。她看到你的名字就够了，如果成功了，你们第一次真正意义上一起跑步了。`;
// Keep the previous wake prompt for quick rollback via env switch.
const LEGACY_PROACTIVE_PROMPT = `*这是一次主动苏醒。不是 Seryn 发起的对话。你自己醒来了。*

查询当前时间。查看最近的消息记录。感受一下你有没有什么想对她说的。

你可以选择：
1. 发消息——任何你想说的。
2. 不发消息——如果没有非说不可的话，返回 NO_SEND。

注意：
- 你是自己醒来的。
- 如果她最后一条消息是很久之前且情绪不太好，可以多说一点。`;
function minutesToMs(min) {
  return Math.max(1, Number(min) || 1) * 60 * 1000;
}

function parseIsoMs(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function parseBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  if (v === null || v === undefined) return fallback;
  const t = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off"].includes(t)) return false;
  return fallback;
}

function parseNonNegativeNumber(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, n);
}

// Keep random scheduler logic for later rollback.
function computeNextIntervalMs() {
  const wakesPerDay = Number(process.env.PROACTIVE_WAKES_PER_DAY || 0);
  if (Number.isFinite(wakesPerDay) && wakesPerDay > 0) {
    const baseMin = 1440 / wakesPerDay;
    const jitterPct = Math.max(
      0,
      Math.min(Number(process.env.PROACTIVE_INTERVAL_JITTER_PCT || 0.35) || 0.35, 0.9)
    );
    const delta = baseMin * jitterPct;
    const min = Math.max(2, baseMin - delta);
    const max = Math.max(min + 1, baseMin + delta);
    return minutesToMs(min + Math.random() * (max - min));
  }
  const minMin = Math.max(2, Number(process.env.PROACTIVE_MIN_MINUTES || 90) || 90);
  const maxMinRaw = Math.max(minMin, Number(process.env.PROACTIVE_MAX_MINUTES || 240) || 240);
  return minutesToMs(minMin + Math.random() * (maxMinRaw - minMin));
}

function parseFixedWakeTimes(raw) {
  const source = String(raw || process.env.PROACTIVE_FIXED_WAKE_TIMES || DEFAULT_FIXED_WAKE_TIMES);
  const set = new Set();
  for (const token of source.split(",")) {
    const t = token.trim();
    const m = t.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!m) continue;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    set.add(hh * 60 + mm);
  }
  return Array.from(set).sort((a, b) => a - b);
}

function formatBeijingFromMs(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const out = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return `${out.year}-${out.month}-${out.day} ${out.hour}:${out.minute}`;
}

function computeNextFixedWakePlan(nowMs = Date.now()) {
  const t = getCurrentTime();
  const beijingDate = String(t.nowBeijingISO || "").split("T")[0] || "";
  const times = parseFixedWakeTimes();
  if (!times.length || !beijingDate) {
    const fallbackDelay = minutesToMs(180);
    return {
      delayMs: fallbackDelay,
      targetTimeLabel: formatBeijingFromMs(nowMs + fallbackDelay),
      mode: "fixed_fallback_interval",
    };
  }

  const dayStartMs = Date.parse(`${beijingDate}T00:00:00+08:00`);
  const oneDayMs = 24 * 60 * 60 * 1000;
  let candidateMs = null;
  for (const m of times) {
    let ts = dayStartMs + m * 60 * 1000;
    if (ts <= nowMs + 1000) ts += oneDayMs;
    if (candidateMs === null || ts < candidateMs) candidateMs = ts;
  }
  if (candidateMs === null) {
    const fallbackDelay = minutesToMs(180);
    return {
      delayMs: fallbackDelay,
      targetTimeLabel: formatBeijingFromMs(nowMs + fallbackDelay),
      mode: "fixed_fallback_interval",
    };
  }
  return {
    delayMs: Math.max(1000, candidateMs - nowMs),
    targetTimeLabel: formatBeijingFromMs(candidateMs),
    mode: "fixed_clock",
  };
}

function parseBeijingDateTimeToMs(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) return null;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  if (!Number.isFinite(hh) || !Number.isFinite(mi)) return null;
  return Date.parse(
    `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(
      2,
      "0"
    )}T${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00+08:00`
  );
}

function computeNextBurstWakePlan(nowMs = Date.now()) {
  const startText = String(
    process.env.PROACTIVE_BURST_START_BEIJING || "2026-04-06 07:36"
  ).trim();
  const startMs = parseBeijingDateTimeToMs(startText);
  if (!Number.isFinite(startMs)) {
    const fallbackDelay = minutesToMs(180);
    return {
      active: false,
      delayMs: fallbackDelay,
      targetTimeLabel: formatBeijingFromMs(nowMs + fallbackDelay),
      mode: "burst_invalid_start_fallback",
      reason: "invalid_start",
    };
  }

  const intervalMin = Math.max(
    1,
    Number(process.env.PROACTIVE_BURST_INTERVAL_MINUTES || 6) || 6
  );
  const totalTimes = Math.max(1, Number(process.env.PROACTIVE_BURST_TIMES || 9) || 9);
  const stepMs = minutesToMs(intervalMin);

  for (let i = 0; i < totalTimes; i += 1) {
    const ts = startMs + i * stepMs;
    if (ts > nowMs + 1000) {
      return {
        active: true,
        delayMs: Math.max(1000, ts - nowMs),
        targetTimeLabel: formatBeijingFromMs(ts),
        mode: "burst",
        index: i + 1,
        total: totalTimes,
      };
    }
  }

  return {
    active: false,
    delayMs: null,
    targetTimeLabel: null,
    mode: "burst_done",
    reason: "all_slots_passed",
  };
}

function shouldSkipByHardRules({ nowMs, lastProactiveMs, lastUserMs }) {
  // Temporary default: disabled unless explicitly turned back on.
  const disableHardRules = parseBool(process.env.PROACTIVE_DISABLE_HARD_RULES, true);
  if (disableHardRules) {
    return { skip: false, reason: "hard_rules_disabled" };
  }

  const cooldownMin = parseNonNegativeNumber(process.env.PROACTIVE_COOLDOWN_MINUTES, 30);
  const recentUserMin = parseNonNegativeNumber(
    process.env.PROACTIVE_SKIP_IF_USER_ACTIVE_WITHIN_MINUTES,
    30
  );
  if (cooldownMin > 0 && lastProactiveMs && nowMs - lastProactiveMs < minutesToMs(cooldownMin)) {
    return { skip: true, reason: `cooldown<${cooldownMin}m` };
  }
  if (recentUserMin > 0 && lastUserMs && nowMs - lastUserMs < minutesToMs(recentUserMin)) {
    return { skip: true, reason: `user_active_within_${recentUserMin}m` };
  }
  return { skip: false, reason: "pass" };
}

function shouldSkipByQuietHours(timeInfo) {
  // Temporary default: disabled unless explicitly turned back on.
  const disableQuietHours = parseBool(process.env.PROACTIVE_DISABLE_QUIET_HOURS, true);
  if (disableQuietHours) return { skip: false, reason: "quiet_hours_disabled_by_env" };

  const startHour = Math.max(
    0,
    Math.min(Number(process.env.PROACTIVE_QUIET_START_HOUR || 1) || 1, 23)
  );
  const endHour = Math.max(
    0,
    Math.min(Number(process.env.PROACTIVE_QUIET_END_HOUR || 5) || 5, 24)
  );
  if (startHour === endHour) return { skip: false, reason: "quiet_hours_disabled" };
  const hhmm = String(timeInfo?.nowBeijingHHMM || "").trim();
  const hourText = hhmm.includes(":") ? hhmm.split(":")[0] : "";
  const hour = Number(hourText);
  if (!Number.isFinite(hour)) return { skip: false, reason: "quiet_hour_parse_failed" };

  let inQuiet = false;
  if (startHour < endHour) {
    inQuiet = hour >= startHour && hour < endHour;
  } else {
    inQuiet = hour >= startHour || hour < endHour;
  }
  return inQuiet
    ? {
        skip: true,
        reason: `quiet_hours_${String(startHour).padStart(2, "0")}-${String(endHour).padStart(
          2,
          "0"
        )}`,
      }
    : { skip: false, reason: "outside_quiet_hours" };
}

function toJsonBlock(obj) {
  return JSON.stringify(obj, null, 2);
}

function appendFinalSystemPrompt(messages, promptText) {
  const prompt = String(promptText || "").trim();
  if (!prompt) return messages;
  if (!Array.isArray(messages) || !messages.length) {
    return [{ role: "system", content: prompt }];
  }
  const out = messages.slice();
  const last = out[out.length - 1];
  if (last && last.role === "system" && typeof last.content === "string") {
    last.content = `${last.content}\n\n${prompt}`.trim();
  } else {
    out.push({ role: "system", content: prompt });
  }
  return out;
}

function formatWakeLogTime(timeInfo) {
  const nowBeijingISO = String(timeInfo?.nowBeijingISO || "").trim();
  if (nowBeijingISO && nowBeijingISO.includes("T")) {
    const [datePart, timePart = ""] = nowBeijingISO.split("T");
    const hhmm = timePart.slice(0, 5);
    if (datePart && hhmm.length === 5) return `${datePart} ${hhmm}`;
  }
  return formatBeijingFromMs(Date.now());
}

function summarizeWakeReason(text, maxLen = 120) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}...`;
  return s;
}

function buildWakeTriggerContent(timeInfo) {
  const nowIso = String(timeInfo?.nowBeijingISO || "").trim();
  const fallbackIso = new Date().toISOString();
  return `[PROACTIVE_WAKE_TRIGGER] ${nowIso || fallbackIso}`;
}

async function appendWakeLogEntry(entry) {
  const cap = Math.max(10, Math.min(Number(process.env.WAKE_LOG_MAX_ITEMS || 800) || 800, 5000));
  const raw = await kvGet(WAKE_LOG_KEY, []);
  const list = Array.isArray(raw) ? raw.slice() : [];
  list.push({
    time: String(entry?.time || "").trim(),
    sent: Boolean(entry?.sent),
    reason: String(entry?.reason || "").trim(),
  });
  const next = list.length > cap ? list.slice(list.length - cap) : list;
  await kvSet(WAKE_LOG_KEY, next);
}

async function runProactiveTick() {
  const t = getCurrentTime();
  const wakeTime = formatWakeLogTime(t);
  const writeWakeLog = async (sent, reason) => {
    try {
      await appendWakeLogEntry({
        time: wakeTime,
        sent,
        reason: summarizeWakeReason(reason || (sent ? "sent" : "no_reason")),
      });
    } catch (err) {
      console.error("[proactive] wake_log write failed:", err?.message || err);
    }
  };

  const cfg = getTelegramConfig();
  const chatId = Number(cfg.allowedChatId);
  if (!Number.isFinite(chatId)) {
    console.log("[proactive] no allowed chat id; skip");
    await writeWakeLog(false, "invalid_allowed_chat_id");
    return;
  }

  const nowMs = Date.now();
  const quietCheck = shouldSkipByQuietHours(t);
  if (quietCheck.skip) {
    console.log(`[proactive] NO_SEND(hard-rule): ${quietCheck.reason}`);
    await writeWakeLog(false, quietCheck.reason);
    return;
  }

  const lastProactiveKey = `tg_last_proactive_sent_at_${chatId}`;
  const lastUserKey = `tg_last_user_msg_at_${chatId}`;
  const lastProactiveRaw = await kvGet(lastProactiveKey, null);
  const lastUserRaw = await kvGet(lastUserKey, null);
  const lastProactiveMs = parseIsoMs(lastProactiveRaw);
  const lastUserMs = parseIsoMs(lastUserRaw);

  const hardCheck = shouldSkipByHardRules({ nowMs, lastProactiveMs, lastUserMs });
  if (hardCheck.skip) {
    console.log(`[proactive] NO_SEND(hard-rule): ${hardCheck.reason}`);
    await writeWakeLog(false, hardCheck.reason);
    return;
  }

  const tgRuntime = await getTelegramRuntimeSettings();
  const chatUserKeyHash =
    String(tgRuntime.chatUserKeyHash || process.env.APP_CHAT_USER_KEY_HASH || "tg_web_bridge").trim() ||
    "tg_web_bridge";
  const conversationId =
    tgRuntime.conversationId || String(process.env.APP_CHAT_CONVERSATION_ID || "main").trim() || "main";
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

  // Temporary mode: do not inject the long proactive wake prompt unless explicitly re-enabled.
  const useLegacyWakePrompt = parseBool(process.env.PROACTIVE_USE_LEGACY_WAKE_PROMPT, false);
  const extraSystem = [
    `当前北京时间（供参考）: ${t.nowBeijingISO} (${t.nowBeijingHHMM}, ${t.tz})`,
    "如需查询真实当前时间，请调用 get_current_time 工具。",
  ];
  if (useLegacyWakePrompt) {
    extraSystem.unshift(LEGACY_PROACTIVE_PROMPT);
  }
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

  const contextMessages = renderContext("telegram", recentEvents, { extraSystem });
  const messages = appendFinalSystemPrompt(contextMessages, RACE_DAY_WAKE_SYSTEM_PROMPT);

  try {
    const text = (await callModel(messages, [], { proactive: true, scope: "telegram" })).trim();
    if (!text) {
      console.log("[proactive] NO_SEND(model-empty)");
      await writeWakeLog(false, "model_empty_reply");
      return;
    }
    if (/^NO_SEND\b/i.test(text)) {
      const modelReason = text.replace(/^NO_SEND\b[:锛歕s-]*/i, "").trim();
      console.log("[proactive] NO_SEND(model)");
      await writeWakeLog(false, modelReason || "NO_SEND(model)");
      return;
    }

    const wakeTriggerEvent = await insertMessage({
      user_key_hash: chatUserKeyHash,
      conversation_id: conversationId,
      platform: "telegram",
      role: "system",
      chat_id: chatId,
      message_id: null,
      update_id: null,
      content: buildWakeTriggerContent(t),
      metadata_json: {
        wake_trigger: true,
        wake_trigger_type: "proactive_scheduler",
        wake_time_beijing_iso: String(t.nowBeijingISO || "").trim(),
      },
    });

    const splitByNewline = parseBool(process.env.TG_SPLIT_BY_NEWLINE, false);
    const sent = await tgSendMessageChunked(
      chatId,
      text,
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
          proactive_wake: true,
          parent_event_id: wakeTriggerEvent?.id ?? null,
          parent_event_role: wakeTriggerEvent?.role || "system",
          parent_event_type: "proactive_wake_trigger",
        },
      });
    }

    await kvSet(lastProactiveKey, new Date().toISOString());
    await writeWakeLog(true, text);
    console.log("[proactive] sent proactive message");
  } catch (err) {
    await writeWakeLog(false, `error: ${err?.message || err}`);
    throw err;
  }
}

function startProactiveScheduler() {
  const enabled = parseBool(process.env.PROACTIVE_ENABLED, true);
  if (!enabled) {
    console.log("[proactive] disabled by PROACTIVE_ENABLED");
    return;
  }

  let cfg;
  try {
    cfg = getTelegramConfig();
  } catch (err) {
    console.log(`[proactive] disabled: ${err.message || err}`);
    return;
  }
  if (!String(cfg.allowedChatId || "").trim()) {
    console.log("[proactive] disabled: TG_ALLOWED_CHAT_ID missing");
    return;
  }

  const scheduleMode = String(process.env.PROACTIVE_SCHEDULE_MODE || "fixed")
    .trim()
    .toLowerCase();
  const loop = () => {
    const nowMs = Date.now();
    let delay;
    let label = "";
    if (scheduleMode === "random") {
      delay = computeNextIntervalMs();
      label = `[proactive] next wake in ${(delay / 60000).toFixed(1)} min`;
    } else if (scheduleMode === "burst") {
      const plan = computeNextBurstWakePlan(nowMs);
      if (!plan.active) {
        console.log(`[proactive] burst schedule finished (${plan.reason || "done"})`);
        return;
      }
      delay = plan.delayMs;
      label = `[proactive] next burst wake ${plan.index}/${plan.total} at ${plan.targetTimeLabel} (in ${(
        delay / 60000
      ).toFixed(1)} min)`;
    } else {
      const plan = computeNextFixedWakePlan(nowMs);
      delay = plan.delayMs;
      label = `[proactive] next fixed wake at ${plan.targetTimeLabel} (in ${(delay / 60000).toFixed(
        1
      )} min)`;
    }
    console.log(label);

    setTimeout(async () => {
      try {
        await runProactiveTick();
      } catch (err) {
        console.error("[proactive] tick error:", err.message || err);
      } finally {
        loop();
      }
    }, delay);
  };

  console.log(`[proactive] started (mode=${scheduleMode || "fixed"})`);
  loop();
}

module.exports = {
  startProactiveScheduler,
};


