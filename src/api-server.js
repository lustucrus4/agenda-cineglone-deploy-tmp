import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { PORT, CRON_LOG_FILE, MAX_LOG_LINES, API_LOG_FILE } from "./config.js";
import { corsPreflight, requireAgendaRole } from "./auth.js";
import { store } from "./store.js";
import { TASK_DEFINITIONS } from "./tasks.js";
import { enqueueRun } from "./queue.js";
import { log } from "./logger.js";

function nowIso() {
  return new Date().toISOString();
}

function parseIso(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function isOrphanRun(run, olderThanMinutes) {
  const status = String(run?.status || "");
  if (status !== "queued" && status !== "running") return false;
  const started = parseIso(run?.started_at);
  if (!started) return false;
  const ageMs = Date.now() - started.getTime();
  return ageMs > Math.max(1, olderThanMinutes) * 60_000;
}

function tailFile(filePath, lines = 200) {
  try {
    const content = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    return content.slice(-Math.max(1, Math.min(lines, MAX_LOG_LINES)));
  } catch {
    return ["[INFO] Aucun log disponible pour le moment."];
  }
}

function ensureFileExists(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "", "utf8");
    }
  } catch {
    // ignore startup file creation errors
  }
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(corsPreflight);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", utc: nowIso() });
});

app.get("/api/tasks", requireAgendaRole, (req, res) => {
  const tasks = Object.values(TASK_DEFINITIONS).map((t) => ({
    id: t.id,
    label: t.label || t.id,
    command: t.command,
    inputs: Array.isArray(t.inputs) ? t.inputs : [],
    schedule_supported: t.schedule_supported !== false,
    schedule: store.listSchedules()[t.id],
  }));
  res.json({ tasks });
});

app.get("/api/schedules", requireAgendaRole, (req, res) => {
  res.json({ schedules: store.listSchedules() });
});

app.put("/api/schedules/:taskId", requireAgendaRole, (req, res) => {
  const taskId = String(req.params.taskId || "");
  if (!TASK_DEFINITIONS[taskId]) {
    return res.status(404).json({ detail: "Tache introuvable." });
  }
  const enabled = Boolean(req.body?.enabled);
  const firstRunRaw = String(req.body?.first_run_at || "");
  const freq = Number(req.body?.frequency_minutes || 0);
  if (!firstRunRaw || !Number.isFinite(freq) || freq < 1) {
    return res.status(400).json({ detail: "Payload schedule invalide." });
  }
  const parsed = new Date(firstRunRaw);
  if (Number.isNaN(parsed.getTime())) {
    return res.status(400).json({ detail: "first_run_at invalide." });
  }
  const schedule = store.updateSchedule(taskId, {
    enabled,
    first_run_at: parsed.toISOString(),
    frequency_minutes: Math.round(freq),
  });
  return res.json({ schedule });
});

app.post("/api/runs", requireAgendaRole, async (req, res) => {
  const task = String(req.body?.task || "");
  const params = req.body?.params && typeof req.body.params === "object" ? req.body.params : {};
  if (!TASK_DEFINITIONS[task]) {
    return res.status(400).json({ detail: "Tache inconnue." });
  }
  const currentRuns = store.listRuns(200).filter((r) => r.status === "running" && r.task === task);
  if (currentRuns.length) {
    return res.status(409).json({ detail: `Tache ${task} deja en cours.` });
  }
  const run = store.addRun({
    task,
    command: TASK_DEFINITIONS[task].command,
    params,
    trigger: "manual",
    log_file: store.getRunLogPath(uuidv4().replace(/-/g, "")),
  });
  run.log_file = store.getRunLogPath(run.id);
  store.updateRun(run.id, { log_file: run.log_file });
  fs.writeFileSync(run.log_file, "", "utf8");
  await enqueueRun(run);
  return res.json({ run });
});

app.get("/api/runs", requireAgendaRole, (req, res) => {
  const limit = Number(req.query.limit || 30);
  return res.json({ runs: store.listRuns(limit) });
});

app.post("/api/admin/runs/orphans", requireAgendaRole, async (req, res) => {
  const action = String(req.body?.action || "cleanup").trim().toLowerCase();
  const olderThanMinutes = Math.max(1, Number(req.body?.older_than_minutes || 30));
  if (action !== "cleanup" && action !== "requeue") {
    return res.status(400).json({ detail: "action doit etre 'cleanup' ou 'requeue'." });
  }

  const candidates = store.listRuns(500).filter((run) => isOrphanRun(run, olderThanMinutes));
  const now = nowIso();
  const out = {
    action,
    older_than_minutes: olderThanMinutes,
    scanned: candidates.length,
    cleaned: 0,
    requeued: 0,
    details: [],
  };

  for (const run of candidates) {
    const runId = String(run.id || "");
    if (!runId) continue;

    if (action === "cleanup") {
      store.updateRun(runId, {
        status: "failed",
        return_code: 1,
        ended_at: now,
        error: "Run orphelin nettoye automatiquement.",
      });
      out.cleaned += 1;
      out.details.push({ run_id: runId, task: run.task, status: "failed" });
      continue;
    }

    if (!TASK_DEFINITIONS[run.task]) {
      store.updateRun(runId, {
        status: "failed",
        return_code: 1,
        ended_at: now,
        error: "Run orphelin invalide (task inconnue).",
      });
      out.cleaned += 1;
      out.details.push({ run_id: runId, task: run.task, status: "failed_invalid_task" });
      continue;
    }

    const replay = store.addRun({
      task: run.task,
      command: TASK_DEFINITIONS[run.task].command,
      trigger: "orphan-requeue",
      log_file: store.getRunLogPath(uuidv4().replace(/-/g, "")),
    });
    replay.log_file = store.getRunLogPath(replay.id);
    store.updateRun(replay.id, { log_file: replay.log_file });
    fs.writeFileSync(replay.log_file, "", "utf8");
    await enqueueRun(replay);

    store.updateRun(runId, {
      status: "failed",
      return_code: 1,
      ended_at: now,
      error: `Run orphelin requeue vers ${replay.id}.`,
    });

    out.cleaned += 1;
    out.requeued += 1;
    out.details.push({ run_id: runId, task: run.task, status: "requeued", new_run_id: replay.id });
  }

  return res.json(out);
});

app.get("/api/runs/:runId", requireAgendaRole, (req, res) => {
  const run = store.getRun(String(req.params.runId || ""));
  if (!run) return res.status(404).json({ detail: "Run introuvable." });
  return res.json({ run });
});

app.get("/api/logs", requireAgendaRole, (req, res) => {
  const target = String(req.query.target || "cron");
  const lines = Number(req.query.lines || 1500);
  if (target === "cron") {
    return res.json({ target, lines: tailFile(CRON_LOG_FILE, lines) });
  }
  if (target === "api") {
    return res.json({ target, lines: tailFile(API_LOG_FILE, lines) });
  }
  if (target === "run") {
    const runId = String(req.query.run_id || "");
    if (!runId) return res.status(400).json({ detail: "run_id requis pour target=run." });
    const run = store.getRun(runId);
    if (!run) return res.status(404).json({ detail: "Run introuvable." });
    const runLogPath = String(run.log_file || "").trim() || store.getRunLogPath(runId);
    if (!run.log_file) {
      store.updateRun(runId, { log_file: runLogPath });
    }
    return res.json({ target, run_id: runId, lines: tailFile(runLogPath, lines) });
  }
  return res.status(400).json({ detail: "target invalide." });
});

ensureFileExists(API_LOG_FILE);
ensureFileExists(CRON_LOG_FILE);

app.listen(PORT, () => {
  log("info", "Agenda Node API started", { port: PORT });
});
