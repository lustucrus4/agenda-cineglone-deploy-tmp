import fs from "node:fs";
import { API_LOG_FILE } from "./config.js";

function line(level, message, meta = null) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta } : {}),
  };
  return JSON.stringify(payload);
}

export function log(level, message, meta = null) {
  const out = line(level, message, meta);
  if (level === "error") {
    console.error(out);
  } else {
    console.log(out);
  }
  try {
    fs.appendFileSync(API_LOG_FILE, `${out}\n`, "utf8");
  } catch {
    // ignore file logging errors
  }
}
