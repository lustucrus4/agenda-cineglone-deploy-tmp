import fs from "node:fs";
import { scrapeSessionsAndDetails } from "./business/scraper.js";
import { checkGoogleConfig, purgeCalendarEventsFromDate, syncCalendarAndYoutube } from "./business/google.js";

function writeLine(logFile, text) {
  fs.appendFileSync(logFile, `${text}\n`, "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

async function runCheckConfig(logFile) {
  writeLine(logFile, `[${nowIso()}] Verification de la configuration Google...`);
  await checkGoogleConfig({
    onLog: (line) => writeLine(logFile, `[${nowIso()}] ${line}`),
  });
  writeLine(logFile, `[${nowIso()}] OK: configuration Google valide.`);
  return { ok: true };
}

async function runDebugScraper(logFile) {
  writeLine(logFile, `[${nowIso()}] Debug scraper: demarrage.`);
  const out = await scrapeSessionsAndDetails({
    onLog: (line) => writeLine(logFile, `[${nowIso()}] ${line}`),
  });
  writeLine(logFile, `[${nowIso()}] Seances: ${out.sessions.length}, films: ${Object.keys(out.film_details).length}`);
  writeLine(logFile, JSON.stringify(out.sessions.slice(0, 10), null, 2));
  return { ok: true, sessions: out.sessions.length };
}

async function runDebugDescriptions(logFile) {
  writeLine(logFile, `[${nowIso()}] Debug descriptions: demarrage.`);
  const out = await scrapeSessionsAndDetails({
    onLog: (line) => writeLine(logFile, `[${nowIso()}] ${line}`),
  });
  writeLine(logFile, JSON.stringify(out.film_details, null, 2));
  return { ok: true, films: Object.keys(out.film_details).length };
}

async function runFullSync(logFile) {
  writeLine(logFile, `[${nowIso()}] Full sync: scraping cineglonne.`);
  const out = await scrapeSessionsAndDetails({
    onLog: (line) => writeLine(logFile, `[${nowIso()}] ${line}`),
  });
  writeLine(logFile, `[${nowIso()}] Seances trouvees: ${out.sessions.length}`);
  if (!out.sessions.length) {
    throw new Error("Aucune seance trouvee.");
  }
  writeLine(logFile, `[${nowIso()}] Sync Google Calendar/YouTube.`);
  const syncOut = await syncCalendarAndYoutube({
    sessions: out.sessions,
    filmDetails: out.film_details,
    trailers: out.trailers,
  }, {
    onLog: (line) => writeLine(logFile, `[${nowIso()}] ${line}`),
  });
  writeLine(logFile, `[${nowIso()}] Evenements crees: ${syncOut.createdEvents}`);
  writeLine(logFile, `[${nowIso()}] Playlist mise a jour: ${syncOut.playlistUpdated ? "oui" : "non"}`);
  return { ok: true, sessions: out.sessions.length, ...syncOut };
}

async function runGooglePurgeFromDate(logFile, params = {}) {
  const fromDateRaw = String(params?.from_date || "").trim();
  if (!fromDateRaw) {
    throw new Error("from_date requis (ISO).");
  }
  const parsed = new Date(fromDateRaw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("from_date invalide.");
  }
  writeLine(logFile, `[${nowIso()}] Purge Google Calendar a partir de ${parsed.toISOString()}.`);
  const details = await purgeCalendarEventsFromDate(parsed.toISOString(), {
    onLog: (line) => writeLine(logFile, `[${nowIso()}] ${line}`),
  });
  writeLine(logFile, `[${nowIso()}] Purge terminee: ${details.deleted || 0} evenement(s) supprime(s).`);
  return { ok: true, ...details };
}

export const TASK_DEFINITIONS = {
  full_sync: {
    id: "full_sync",
    label: "Synchronisation complete",
    command: "node task full_sync",
    run: runFullSync,
  },
  check_config: {
    id: "check_config",
    label: "Verification config",
    command: "node task check_config",
    run: runCheckConfig,
  },
  debug_scraper: {
    id: "debug_scraper",
    label: "Debug scraping",
    command: "node task debug_scraper",
    run: runDebugScraper,
  },
  debug_descriptions: {
    id: "debug_descriptions",
    label: "Debug descriptions",
    command: "node task debug_descriptions",
    run: runDebugDescriptions,
  },
  google_purge_from_date: {
    id: "google_purge_from_date",
    label: "Google Calendar - Purge a partir d'une date",
    command: "node task google_purge_from_date --from-date <ISO>",
    schedule_supported: false,
    inputs: [
      {
        key: "from_date",
        type: "datetime-local",
        label: "Date de suppression (inclus)",
        required: true,
      },
    ],
    run: runGooglePurgeFromDate,
  },
};
