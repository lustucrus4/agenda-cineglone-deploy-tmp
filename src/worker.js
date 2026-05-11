import "dotenv/config";
import { createWorker } from "./queue.js";
import { log } from "./logger.js";

const worker = createWorker();

worker.on("completed", (job) => {
  log("info", "Job completed", { id: job.id, name: job.name });
});

worker.on("failed", (job, err) => {
  log("error", "Job failed", { id: job?.id, error: String(err?.message || err) });
});

log("info", "Agenda worker started");
