function platformLabel(platform) {
  return platform === "telegram" ? "Telegram" : "Web";
}

function normalizeContent(content) {
  return typeof content === "string" ? content : String(content ?? "");
}

function pickEventTimestamp(event) {
  const fromPlatform = normalizeContent(event?.created_at_platform || "").trim();
  if (fromPlatform) return fromPlatform;
  const fromServer = normalizeContent(event?.created_at || "").trim();
  return fromServer;
}

function withTimestampPrefix(content, timestamp) {
  const ts = normalizeContent(timestamp).trim();
  if (!ts) return content;
  return `\u3010\u65f6\u95f4\u6233\u3011${ts}\n${content}`;
}

function renderContext(currentPlatform, recentEvents, options = {}) {
  const out = [];
  const extraSystem = Array.isArray(options.extraSystem) ? options.extraSystem : [];
  const recentTimestampCount = Math.max(
    0,
    Math.min(Number(options.recentTimestampCount ?? 10) || 10, 200)
  );

  for (const line of extraSystem) {
    const text = normalizeContent(line).trim();
    if (text) out.push({ role: "system", content: text });
  }

  const prepared = [];
  for (const event of recentEvents || []) {
    const role = event.role;
    const platform = event.platform || currentPlatform;
    const content = normalizeContent(event.content).trim();
    if (!content) continue;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    prepared.push({
      role,
      platform,
      content,
      timestamp: pickEventTimestamp(event),
    });
  }

  const messageIndexes = prepared
    .map((item, idx) => {
      const isChatMessage = item.role === "user" || item.role === "assistant";
      const isTelegram = String(item.platform || "").trim().toLowerCase() === "telegram";
      return isChatMessage && isTelegram ? idx : -1;
    })
    .filter((idx) => idx >= 0);
  const timestampedIndexes = new Set(messageIndexes.slice(-recentTimestampCount));

  let prevPlatform = null;
  for (let i = 0; i < prepared.length; i += 1) {
    const event = prepared[i];
    const role = event.role;
    const platform = event.platform;
    const content = event.content;

    if (prevPlatform && platform !== prevPlatform) {
      out.push({
        role: "system",
        content: `\u3010\u5207\u6362\u5230 ${platformLabel(platform)}\u3011`,
      });
    }

    if (role === "user" || role === "assistant") {
      const finalContent = timestampedIndexes.has(i)
        ? withTimestampPrefix(content, event.timestamp)
        : content;
      out.push({ role, content: finalContent });
    } else if (options.includeSystemEvents === true) {
      out.push({ role: "system", content });
    }
    prevPlatform = platform;
  }

  return out;
}

module.exports = {
  renderContext,
};
