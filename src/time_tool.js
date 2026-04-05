function pad2(n) {
  return String(n).padStart(2, "0");
}

function getDatePartsInTZ(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const out = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

function getCurrentTime() {
  const now = new Date(Date.now());
  const tz = "Asia/Shanghai";
  const p = getDatePartsInTZ(now, tz);
  const nowBeijingISO =
    `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
  return {
    nowUtcISO: now.toISOString(),
    nowBeijingISO,
    nowBeijingHHMM: `${pad2(Number(p.hour))}:${pad2(Number(p.minute))}`,
    tz,
  };
}

const GET_CURRENT_TIME_TOOL = {
  type: "function",
  function: {
    name: "get_current_time",
    description:
      "Get current real server time and Beijing time context (Asia/Shanghai).",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
};

module.exports = {
  getCurrentTime,
  GET_CURRENT_TIME_TOOL,
};
