import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { DATA_DIR, RUNS_DIR, RUNS_FILE, SCHEDULES_FILE } from "./config.js";

const TASK_IDS = ["full_sync", "check_config", "debug_scraper", "debug_descriptions"];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function defaultSchedule(taskId) {
  return {
    task: taskId,
    enabled: false,
    first_run_at: nowIso(),
    frequency_minutes: 1440,
    next_run_at: nowIso(),
    last_run_at: null,
    last_error: "",
  };
}

function recomputeNextRun(schedule) {
  const first = new Date(schedule.first_run_at || nowIso());
  const freq = Math.max(1, Number(schedule.frequency_minutes || 1440));
  const now = Date.now();
  let next = first.getTime();
  if (schedule.last_run_at) {
    next = new Date(schedule.last_run_at).getTime() + freq * 60_000;
  }
  while (next < now - freq * 60_000) {
    next += freq * 60_000;
  }
  return new Date(next).toISOString();
}

class AgendaStore {
  constructor() {
    ensureDir(DATA_DIR);
    ensureDir(RUNS_DIR);
    this.runs = Array.isArray(loadJson(RUNS_FILE, [])) ? loadJson(RUNS_FILE, []) : [];
    const rawSchedules = loadJson(SCHEDULES_FILE, {});
    this.schedules = {};
    for (const taskId of TASK_IDS) {
      const merged = {
        ...defaultSchedule(taskId),
        ...(rawSchedules?.[taskId] || {}),
      };
      merged.next_run_at = recomputeNextRun(merged);
      this.schedules[taskId] = merged;
    }
    this.persistSchedules();
    this.persistRuns();
  }

  refreshSchedulesFromDisk() {
    const rawSchedules = loadJson(SCHEDULES_FILE, {});
    const nextSchedules = {};
    for (const taskId of TASK_IDS) {
      const merged = {
        ...defaultSchedule(taskId),
        ...(rawSchedules?.[taskId] || {}),
      };
      merged.next_run_at = recomputeNextRun(merged);
      nextSchedules[taskId] = merged;
    }
    this.schedules = nextSchedules;
  }

  refreshRunsFromDisk() {
    const diskRuns = loadJson(RUNS_FILE, []);
    this.runs = Array.isArray(diskRuns) ? diskRuns : [];
  }

  persistRuns() {
    saveJson(RUNS_FILE, this.runs.slice(0, 2000));
  }

  persistSchedules() {
    saveJson(SCHEDULES_FILE, this.schedules);
  }

  listRuns(limit = 50) {
    this.refreshRunsFromDisk();
    return this.runs.slice(0, Math.max(1, Math.min(limit, 200)));
  }

  getRun(runId) {
    this.refreshRunsFromDisk();
    return this.runs.find((r) => r.id === runId) || null;
  }

  addRun(payload) {
    this.refreshRunsFromDisk();
    const run = {
      id: uuidv4().replace(/-/g, ""),
      started_at: nowIso(),
      ended_at: null,
      return_code: null,
      status: "queued",
      ...payload,
    };
    this.runs.unshift(run);
    this.persistRuns();
    return run;
  }

  updateRun(runId, updates) {
    this.refreshRunsFromDisk();
    const idx = this.runs.findIndex((r) => r.id === runId);
    if (idx < 0) return null;
    this.runs[idx] = { ...this.runs[idx], ...updates };
    this.persistRuns();
    return this.runs[idx];
  }

  listSchedules() {
    this.refreshSchedulesFromDisk();
    return this.schedules;
  }

  updateSchedule(taskId, nextValues) {
    this.refreshSchedulesFromDisk();
    const current = this.schedules[taskId] || defaultSchedule(taskId);
    const merged = { ...current, ...nextValues };
    const firstRunChanged = Object.prototype.hasOwnProperty.call(nextValues, "first_run_at");
    const frequencyChanged = Object.prototype.hasOwnProperty.call(nextValues, "frequency_minutes");
    if (firstRunChanged || frequencyChanged) {
      merged.last_run_at = null;
    }
    merged.frequency_minutes = Math.max(1, Number(merged.frequency_minutes || 1440));
    merged.next_run_at = recomputeNextRun(merged);
    this.schedules[taskId] = merged;
    this.persistSchedules();
    return merged;
  }

  markScheduledRun(taskId) {
    const current = this.schedules[taskId];
    if (!current) return null;
    return this.updateSchedule(taskId, {
      last_run_at: nowIso(),
      last_error: "",
    });
  }

  markScheduleError(taskId, message) {
    const current = this.schedules[taskId];
    if (!current) return null;
    return this.updateSchedule(taskId, {
      last_error: String(message || ""),
    });
  }

  getRunLogPath(runId) {
    return path.join(RUNS_DIR, `${runId}.log`);
  }
}

export const store = new AgendaStore();
export const TASK_IDS_LIST = TASK_IDS;
