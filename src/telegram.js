const axios = require("axios");

function getTelegramConfig() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  return {
    token,
    allowedChatId: String(process.env.TG_ALLOWED_CHAT_ID || "").trim(),
    chunkSize: Math.max(1000, Math.min(Number(process.env.TG_REPLY_CHUNK_SIZE || 3500) || 3500, 4000)),
    pollingTimeoutSec: Math.max(1, Math.min(Number(process.env.TG_POLLING_TIMEOUT_SEC || 20) || 20, 50)),
  };
}

function apiBase(token) {
  return `https://api.telegram.org/bot${token}`;
}

async function tgGetUpdates({ offset, timeoutSec }) {
  const { token } = getTelegramConfig();
  const url = `${apiBase(token)}/getUpdates`;
  const params = {
    timeout: timeoutSec,
    allowed_updates: ["message"],
  };
  if (Number.isInteger(offset)) params.offset = offset;

  const { data } = await axios.get(url, {
    params,
    timeout: (timeoutSec + 10) * 1000,
  });
  if (!data || data.ok !== true) {
    throw new Error(`Telegram getUpdates failed: ${JSON.stringify(data)}`);
  }
  return data.result || [];
}

async function tgSendMessage(chatId, text) {
  const { token } = getTelegramConfig();
  const url = `${apiBase(token)}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  const { data } = await axios.post(url, payload, { timeout: 30000 });
  if (!data || data.ok !== true) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function tgSetMyCommands(commands) {
  const { token } = getTelegramConfig();
  const url = `${apiBase(token)}/setMyCommands`;
  const payload = { commands: Array.isArray(commands) ? commands : [] };
  const { data } = await axios.post(url, payload, { timeout: 30000 });
  if (!data || data.ok !== true) {
    throw new Error(`Telegram setMyCommands failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function tgSetChatMenuButton(url) {
  const { token } = getTelegramConfig();
  const safeUrl = String(url || "").trim();
  if (!safeUrl) return false;
  const apiUrl = `${apiBase(token)}/setChatMenuButton`;
  const payload = {
    menu_button: {
      type: "web_app",
      text: "Settings",
      web_app: { url: safeUrl },
    },
  };
  const { data } = await axios.post(apiUrl, payload, { timeout: 30000 });
  if (!data || data.ok !== true) {
    throw new Error(`Telegram setChatMenuButton failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

function splitByMaxLen(text, maxLen) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

function splitTelegramText(text, maxLen = 3500, options = {}) {
  const input = String(text || "").trim();
  if (!input) return [];
  const splitByNewline = options && options.splitByNewline === true;
  if (splitByNewline) {
    const lines = input
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    const source = lines.length ? lines : [input];
    const out = [];
    for (const line of source) {
      if (line.length <= maxLen) {
        out.push(line);
      } else {
        out.push(...splitByMaxLen(line, maxLen));
      }
    }
    return out;
  }
  if (input.length <= maxLen) return [input];

  const chunks = [];
  const paras = input.split("\n");
  let buf = "";
  for (const p of paras) {
    const line = buf ? `${buf}\n${p}` : p;
    if (line.length <= maxLen) {
      buf = line;
      continue;
    }
    if (buf) {
      chunks.push(buf);
      buf = "";
    }
    if (p.length <= maxLen) {
      buf = p;
      continue;
    }
    chunks.push(...splitByMaxLen(p, maxLen));
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function tgSendMessageChunked(chatId, text, options = {}) {
  const { chunkSize } = getTelegramConfig();
  const chunks = splitTelegramText(text, chunkSize, options);
  const sent = [];
  for (const c of chunks) {
    const msg = await tgSendMessage(chatId, c);
    sent.push({ chunk: c, telegramMessage: msg });
  }
  return sent;
}

module.exports = {
  getTelegramConfig,
  tgGetUpdates,
  tgSendMessage,
  tgSetMyCommands,
  tgSetChatMenuButton,
  tgSendMessageChunked,
  splitTelegramText,
};
