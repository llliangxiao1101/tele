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
} = require("./runtime_config");

function parseBoolText(v) {
  const t = String(v || "").trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(t)) return true;
  if (["off", "false", "0", "no"].includes(t)) return false;
  return null;
}

function helpText() {
  return [
    "Admin commands:",
    "/cfg - show telegram runtime config",
    "/panel - open mini app settings panel",
    "/set_model <model>",
    "/set_base <openai_compatible_base_url>",
    "/set_key <api_key>",
    "/set_prompt <text>",
    "/set_immediate on|off",
    "/set_ctx <20-200>",
    "/set_window <conversation_id>",
  ].join("\n");
}

async function cfgText() {
  const cfg = await getTelegramRuntimeSettings();
  return [
    "Telegram runtime config:",
    `base_url: ${cfg.baseUrl || "(empty)"}`,
    `model: ${cfg.model || "(empty)"}`,
    `api_key: ${redactSecret(cfg.apiKey)}`,
    `persona_prompt: ${cfg.systemPrompt ? "(set)" : "(empty)"}`,
    `immediate_reply: ${cfg.immediateReplyEnabled ? "on" : "off"}`,
    `context_events_limit: ${cfg.contextEventsLimit}`,
    `conversation_id: ${cfg.conversationId}`,
  ].join("\n");
}

async function handleTelegramAdminCommand(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("/")) return { handled: false };
  const [cmdRaw, ...argsArr] = raw.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const args = argsArr.join(" ").trim();

  if (cmd === "/start") {
    return { handled: true, reply: `Bot is ready.\n\n${helpText()}` };
  }

  if (cmd === "/help" || cmd === "/menu") {
    return { handled: true, reply: helpText() };
  }

  if (cmd === "/cfg") {
    return { handled: true, reply: await cfgText() };
  }

  if (cmd === "/panel") {
    const panelUrl = String(process.env.TG_MINIAPP_URL || "").trim();
    if (!panelUrl) {
      return { handled: true, reply: "TG_MINIAPP_URL is not configured yet." };
    }
    return { handled: true, reply: `Open settings panel:\n${panelUrl}` };
  }

  if (cmd === "/set_model") {
    if (!args) return { handled: true, reply: "Usage: /set_model <model>" };
    await setTelegramLlmModel(args);
    return { handled: true, reply: `ok, model set to: ${args}` };
  }

  if (cmd === "/set_base") {
    if (!args) return { handled: true, reply: "Usage: /set_base <url>" };
    await setTelegramLlmBaseUrl(args);
    return { handled: true, reply: `ok, base_url set to: ${args}` };
  }

  if (cmd === "/set_key") {
    if (!args) return { handled: true, reply: "Usage: /set_key <api_key>" };
    await setTelegramLlmApiKey(args);
    return { handled: true, reply: `ok, api_key set: ${redactSecret(args)}` };
  }

  if (cmd === "/set_prompt") {
    if (!args) return { handled: true, reply: "Usage: /set_prompt <text>" };
    await setTelegramSystemPrompt(args);
    return { handled: true, reply: "ok, prompt saved for telegram." };
  }

  if (cmd === "/set_immediate") {
    const enabled = parseBoolText(args);
    if (enabled === null) {
      return { handled: true, reply: "Usage: /set_immediate on|off" };
    }
    await setTelegramImmediateReplyEnabled(enabled);
    return { handled: true, reply: `ok, immediate_reply is now: ${enabled ? "on" : "off"}` };
  }

  if (cmd === "/set_ctx") {
    const n = Number(args);
    if (!Number.isFinite(n)) {
      return { handled: true, reply: "Usage: /set_ctx <20-200>" };
    }
    await setTelegramContextEventsLimit(n);
    const cfg = await getTelegramRuntimeSettings();
    return { handled: true, reply: `ok, context_events_limit is now: ${cfg.contextEventsLimit}` };
  }

  if (cmd === "/set_window") {
    if (!args) return { handled: true, reply: "Usage: /set_window <conversation_id>" };
    await setTelegramConversationId(args);
    const cfg = await getTelegramRuntimeSettings();
    return { handled: true, reply: `ok, conversation_id is now: ${cfg.conversationId}` };
  }

  return {
    handled: true,
    reply: `Unknown command: ${cmd}\n\n${helpText()}`,
  };
}

function telegramCommandList() {
  return [
    { command: "cfg", description: "show current telegram config" },
    { command: "panel", description: "open mini app settings panel" },
    { command: "set_model", description: "set telegram model" },
    { command: "set_base", description: "set telegram base url" },
    { command: "set_key", description: "set telegram api key" },
    { command: "set_prompt", description: "set telegram prompt" },
    { command: "set_immediate", description: "toggle immediate reply on/off" },
    { command: "set_ctx", description: "set context window size" },
    { command: "set_window", description: "set conversation id" },
  ];
}

module.exports = {
  handleTelegramAdminCommand,
  telegramCommandList,
};
