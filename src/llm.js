const axios = require("axios");
const { getCurrentTime, GET_CURRENT_TIME_TOOL } = require("./time_tool");
const { getTelegramLlmConfig } = require("./runtime_config");

const TOOL_EXECUTORS = {
  get_current_time: async () => getCurrentTime(),
};

function normalizeToolDefs(extraTools = []) {
  const tools = [GET_CURRENT_TIME_TOOL];
  for (const t of extraTools) tools.push(t);
  return tools;
}

function pickAssistantText(message) {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function fallbackCallModel(messages, { proactive = false } = {}) {
  const lastUser = [...(messages || [])]
    .reverse()
    .find((m) => m && m.role === "user" && typeof m.content === "string");
  const lastUserText = (lastUser?.content || "").trim();

  if (proactive) {
    const p = Math.max(
      0,
      Math.min(Number(process.env.PROACTIVE_FALLBACK_SEND_PROB || 0.4) || 0.4, 1)
    );
    if (Math.random() > p) return "NO_SEND";
    return `\u6211\u521a\u9192\u6765\u60f3\u5230\u4f60\u4e86\u3002\u4f60\u73b0\u5728\u5728\u5fd9\u5417\uff1f\u5982\u679c\u60f3\u804a\uff0c\u6211\u5728\u3002`;
  }
  return lastUserText
    ? `\u6211\u6536\u5230\u4e86\uff1a${lastUserText}`
    : "\u6211\u5728\u3002";
}

async function runOpenAIToolLoop(messages, { tools = [], maxRounds = 4, llmConfig = null } = {}) {
  const apiKey = String(llmConfig?.apiKey || process.env.OPENAI_API_KEY || "").trim();
  const baseUrl = String(llmConfig?.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim();
  const model = String(llmConfig?.model || process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
  const timeout = Math.max(5000, Math.min(Number(process.env.OPENAI_TIMEOUT_MS || 60000) || 60000, 180000));

  const toolDefs = normalizeToolDefs(tools);
  const convo = [...messages];

  for (let round = 0; round < maxRounds; round += 1) {
    const { data } = await axios.post(
      `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        model,
        messages: convo,
        tools: toolDefs,
        tool_choice: "auto",
      },
      {
        timeout,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const choice = data?.choices?.[0];
    const msg = choice?.message;
    if (!msg) return "";

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const assistantText = pickAssistantText(msg);

    if (!toolCalls.length) {
      return assistantText;
    }

    convo.push({
      role: "assistant",
      content: assistantText || "",
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      const name = tc?.function?.name;
      const fn = TOOL_EXECUTORS[name];
      let output;
      if (typeof fn !== "function") {
        output = { error: `unknown tool: ${name}` };
      } else {
        try {
          output = await fn();
        } catch (err) {
          output = { error: err.message || String(err) };
        }
      }
      convo.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(output),
      });
    }
  }

  return "";
}

async function resolveLlmConfig(options = {}) {
  if (options.scope === "telegram") {
    return getTelegramLlmConfig();
  }
  return {
    baseUrl: String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim(),
    apiKey: String(process.env.OPENAI_API_KEY || "").trim(),
    model: String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim(),
  };
}

async function callModel(messages, tools = [], options = {}) {
  const llmConfig = await resolveLlmConfig(options);
  const apiKey = String(llmConfig.apiKey || "").trim();
  if (!apiKey) {
    return fallbackCallModel(messages, options);
  }
  const text = await runOpenAIToolLoop(messages, { tools, llmConfig });
  return (text || "").trim() || fallbackCallModel(messages, options);
}

module.exports = {
  callModel,
  GET_CURRENT_TIME_TOOL,
};
