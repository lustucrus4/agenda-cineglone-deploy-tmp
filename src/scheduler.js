import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { SCHEDULER_TICK_MS, CRON_LOG_FILE } from "./config.js";
import { store } from "./store.js";
import { TASK_DEFINITIONS } from "./tasks.js";
import { enqueueRun } from "./queue.js";
import { log } from "./logger.js";

function nowMs() {
  return Date.now();
}

function cronLog(message, meta = null, level = "info") {
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta } : {}),
  });
  try {
    fs.mkdirSync(path.dirname(CRON_LOG_FILE), { recursive: true });
    fs.appendFileSync(CRON_LOG_FILE, `${payload}\n`, "utf8");
  } catch {
    // ignore cron log file errors
  }
}

async function tick() {
  const schedules = store.listSchedules();
  for (const [taskId, schedule] of Object.entries(schedules)) {
    if (!TASK_DEFINITIONS[taskId]) continue;
    if (!schedule?.enabled) continue;
    const nextTs = new Date(schedule.next_run_at || 0).getTime();
    if (!Number.isFinite(nextTs) || nextTs > nowMs()) continue;

    const inProgress = store.listRuns(200).some((r) => r.task === taskId && r.status === "running");
    if (inProgress) {
      store.markScheduleError(taskId, "Execution ignoree: tache deja en cours.");
      continue;
    }

    const run = store.addRun({
      task: taskId,
      command: TASK_DEFINITIONS[taskId].command,
      trigger: "scheduled",
      log_file: store.getRunLogPath(`scheduled-${Date.now()}`),
    });
    run.log_file = store.getRunLogPath(run.id);
    store.updateRun(run.id, { log_file: run.log_file });
    await enqueueRun(run);
    store.markScheduledRun(taskId);
    log("info", "Scheduled run enqueued", { taskId, runId: run.id });
    cronLog("Scheduled run enqueued", { taskId, runId: run.id });
  }
}

setInterval(() => {
  tick().catch((error) => {
    log("error", "Scheduler tick failed", { error: String(error?.message || error) });
    cronLog("Scheduler tick failed", { error: String(error?.message || error) }, "error");
  });
}, SCHEDULER_TICK_MS);

log("info", "Agenda scheduler started", { tickMs: SCHEDULER_TICK_MS });
cronLog("Agenda scheduler started", { tickMs: SCHEDULER_TICK_MS });
