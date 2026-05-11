import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import fs from "node:fs";
import { QUEUE_NAME, REDIS_URL } from "./config.js";
import { store } from "./store.js";
import { TASK_DEFINITIONS } from "./tasks.js";

const redisConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

export const queue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
});

export async function enqueueRun(run) {
  await queue.add(
    "run-task",
    {
      runId: run.id,
      task: run.task,
      params: run.params || {},
    },
    {
      removeOnComplete: 100,
      removeOnFail: 200,
    }
  );
}

function writeRunLog(runId, text) {
  const logPath = store.getRunLogPath(runId);
  fs.appendFileSync(logPath, `${text}\n`, "utf8");
}

export function createWorker() {
  return new Worker(
    QUEUE_NAME,
    async (job) => {
      const { runId, task, params } = job.data || {};
      const run = store.getRun(runId);
      if (!run) throw new Error("Run introuvable");
      const def = TASK_DEFINITIONS[task];
      if (!def) throw new Error(`Tache inconnue: ${task}`);

      store.updateRun(runId, {
        status: "running",
      });
      writeRunLog(runId, `[START] ${new Date().toISOString()} task=${task}`);
      writeRunLog(runId, `[INPUT] ${JSON.stringify(params || {})}`);
      try {
        const result = await def.run(store.getRunLogPath(runId), params || {});
        writeRunLog(runId, `[DONE] ${new Date().toISOString()} result=${JSON.stringify(result)}`);
        store.updateRun(runId, {
          status: "success",
          return_code: 0,
          ended_at: new Date().toISOString(),
          error: "",
        });
      } catch (error) {
        const errorMsg = String(error?.message || error);
        writeRunLog(runId, `[ERROR] ${new Date().toISOString()} ${errorMsg}`);
        store.updateRun(runId, {
          status: "failed",
          return_code: 1,
          ended_at: new Date().toISOString(),
          error: errorMsg,
        });
      }
    },
    {
      connection: redisConnection,
      concurrency: 1,
    }
  );
}
