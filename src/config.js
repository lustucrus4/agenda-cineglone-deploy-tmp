import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const APP_ROOT = path.resolve(__dirname, "..");
export const DATA_DIR = process.env.AGENDA_DATA_DIR || path.join(APP_ROOT, "runtime");
export const RUNS_DIR = path.join(DATA_DIR, "runs");
export const RUNS_FILE = path.join(DATA_DIR, "runs.json");
export const SCHEDULES_FILE = path.join(DATA_DIR, "schedules.json");
export const API_LOG_FILE = path.join(DATA_DIR, "api.log");
export const CRON_LOG_FILE = process.env.AGENDA_CRON_LOG_FILE || path.join(DATA_DIR, "cron.log");

export const PORT = Number(process.env.PORT || 8090);
export const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
export const QUEUE_NAME = process.env.AGENDA_QUEUE_NAME || "agenda-cineglone-runs";
export const SCHEDULER_TICK_MS = Number(process.env.AGENDA_SCHEDULER_TICK_MS || 15000);
export const MAX_LOG_LINES = Number(process.env.AGENDA_API_MAX_LOG_LINES || 10000);

export const AUTH_API_BASE = String(process.env.AGENDA_AUTH_API_BASE || "https://auth.lab211.fr").replace(/\/+$/, "");
export const AUTH_SITE_KEY = String(process.env.AGENDA_AUTH_SITE_KEY || "agenda-cineglone").trim().toLowerCase();
export const AUTH_TIMEOUT_MS = Number(process.env.AGENDA_AUTH_TIMEOUT_MS || 8000);

export const CORS_ORIGINS = String(
  process.env.AGENDA_API_ALLOWED_ORIGINS || "https://agenda-cineglone.lab211.fr,https://agenda.lab211.fr"
)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

export const CINEGLONNE_URL = process.env.CINEGLONNE_URL || "https://www.cineglonne.fr/";
export const DEFAULT_MOVIE_DURATION_MIN = Number(process.env.DEFAULT_MOVIE_DURATION_MIN || 120);
export const YOUTUBE_PLAYLIST_ID = process.env.YOUTUBE_PLAYLIST_ID || "";
export const CALENDAR_ID = process.env.CALENDAR_ID || "";
export const CALENDAR_NAME = process.env.CALENDAR_NAME || "Cine Glonne";
export const EVENT_TAG = process.env.EVENT_TAG || "Cinéglonne";
export const GOOGLE_CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH || path.join(APP_ROOT, "credentials", "credentials.json");
export const GOOGLE_TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || path.join(APP_ROOT, "credentials", "token.json");
