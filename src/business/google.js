import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import {
  CALENDAR_ID,
  CALENDAR_NAME,
  EVENT_TAG,
  GOOGLE_CREDENTIALS_PATH,
  GOOGLE_TOKEN_PATH,
  YOUTUBE_PLAYLIST_ID,
} from "../config.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function formatDurationLabel(totalMinutesRaw) {
  const totalMinutes = Number(totalMinutesRaw || 0);
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return "";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}min`;
  return `${hours}h${String(minutes).padStart(2, "0")}`;
}

function ensureTokenDir() {
  fs.mkdirSync(path.dirname(GOOGLE_TOKEN_PATH), { recursive: true });
}

function getOAuthClient() {
  if (!fs.existsSync(GOOGLE_CREDENTIALS_PATH)) {
    throw new Error(
      `Google credentials manquants: fichier introuvable a ${GOOGLE_CREDENTIALS_PATH}. ` +
      "Verifier le montage Docker et la variable GOOGLE_CREDENTIALS_PATH."
    );
  }
  if (!fs.existsSync(GOOGLE_TOKEN_PATH)) {
    throw new Error(
      `Google token manquant: fichier introuvable a ${GOOGLE_TOKEN_PATH}. ` +
      "Le token OAuth doit etre genere via le script d'autorisation."
    );
  }
  let credentials;
  try {
    credentials = readJson(GOOGLE_CREDENTIALS_PATH);
  } catch (err) {
    throw new Error(`credentials.json illisible: ${err.message}`);
  }
  let token;
  try {
    token = readJson(GOOGLE_TOKEN_PATH);
  } catch (err) {
    throw new Error(`token.json illisible: ${err.message}`);
  }
  const meta = credentials.installed || credentials.web;
  if (!meta?.client_id || !meta?.client_secret) {
    throw new Error("credentials.json invalide: client_id ou client_secret manquant.");
  }
  if (!token?.refresh_token && !token?.access_token) {
    throw new Error(
      "token.json invalide: ni access_token ni refresh_token presents. " +
      "Re-generer le token via le script d'autorisation."
    );
  }
  const client = new google.auth.OAuth2(meta.client_id, meta.client_secret, (meta.redirect_uris || [])[0]);
  client.setCredentials(token);
  client.on("tokens", (tokens) => {
    try {
      ensureTokenDir();
      const current = fs.existsSync(GOOGLE_TOKEN_PATH) ? readJson(GOOGLE_TOKEN_PATH) : {};
      fs.writeFileSync(GOOGLE_TOKEN_PATH, JSON.stringify({ ...current, ...tokens }, null, 2), "utf8");
    } catch {
      // ignore token persist errors
    }
  });
  return client;
}

async function resolveCalendarId(calendarApi) {
  if (CALENDAR_ID) return CALENDAR_ID;
  const list = await calendarApi.calendarList.list();
  const existing = (list.data.items || []).find((c) => c.summary === CALENDAR_NAME);
  if (existing?.id) return existing.id;
  const created = await calendarApi.calendars.insert({
    requestBody: { summary: CALENDAR_NAME, timeZone: "Europe/Paris" },
  });
  return created.data.id;
}

function sessionToEvent(session, details = {}, trailerUrl = "") {
  const start = new Date(session.date_time);
  const duration = Number(details.duration || session.duration || 120);
  const end = new Date(start.getTime() + duration * 60_000);
  const durationLabel = formatDurationLabel(duration);
  const synopsis = String(details.synopsis || "").trim();
  const link = String(trailerUrl || details.youtube_url || "").trim();
  const warning = String(details.warning || "").trim();

  const parts = [];

  if (durationLabel) parts.push(`dur\u00e9e : ${durationLabel}`);
  if (details.director) parts.push(`R\u00e9alisateur : ${details.director}`);
  if (details.actors) parts.push(`Acteurs : ${details.actors}`);

  if (warning) {
    parts.push("");
    parts.push(`Tout public avec avertissement : ${warning}`);
  }

  if (synopsis) {
    parts.push("");
    parts.push(synopsis);
  }

  if (link) {
    parts.push("");
    parts.push(link);
  }

  parts.push("");
  parts.push(`Tag: ${EVENT_TAG}`);

  return {
    summary: session.title,
    location: "Cin\u00e9glonne",
    description: parts.join("\n"),
    start: { dateTime: start.toISOString(), timeZone: "Europe/Paris" },
    end: { dateTime: end.toISOString(), timeZone: "Europe/Paris" },
  };
}

function noop() {}

function formatEventTimeRange(item) {
  const startRaw = item?.start?.dateTime || item?.start?.date || "";
  const endRaw = item?.end?.dateTime || item?.end?.date || "";
  const start = startRaw ? new Date(startRaw) : null;
  const end = endRaw ? new Date(endRaw) : null;
  const startLabel = start && !Number.isNaN(start.getTime()) ? start.toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : String(startRaw || "-");
  const endLabel = end && !Number.isNaN(end.getTime()) ? end.toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : String(endRaw || "-");
  return `${startLabel} -> ${endLabel}`;
}

export async function checkGoogleConfig(options = {}) {
  const onLog = typeof options.onLog === "function" ? options.onLog : noop;
  onLog("Google: chargement des credentials/token OAuth.");
  const oauth = getOAuthClient();
  onLog("Google: client OAuth initialise.");
  const calendarApi = google.calendar({ version: "v3", auth: oauth });
  const youtubeApi = google.youtube({ version: "v3", auth: oauth });
  onLog("Google: test acces Calendar API.");
  await calendarApi.calendarList.list({ maxResults: 1 });
  onLog("Google: test acces YouTube API.");
  await youtubeApi.channels.list({ mine: true, part: ["id"], maxResults: 1 });
  onLog("Google: configuration valide.");
}

export async function syncCalendarAndYoutube({ sessions, filmDetails, trailers }, options = {}) {
  const onLog = typeof options.onLog === "function" ? options.onLog : noop;
  onLog("Google: initialisation des clients API.");
  const oauth = getOAuthClient();
  const calendarApi = google.calendar({ version: "v3", auth: oauth });
  const youtubeApi = google.youtube({ version: "v3", auth: oauth });

  onLog("Google: resolution de l'identifiant calendar.");
  let calendarId;
  try {
    calendarId = await resolveCalendarId(calendarApi);
  } catch (err) {
    const code = err?.response?.status || err?.code || "";
    if (code === 401 || code === "UNAUTHENTICATED" || String(err?.message).includes("invalid_grant")) {
      throw new Error(
        "Google API: token OAuth expire ou revoque (code " + code + "). " +
        "Re-generer le token via le script d'autorisation Google."
      );
    }
    throw new Error(`Google API: echec resolution calendar (${code}): ${err.message}`);
  }
  onLog(`Google: calendar cible = ${calendarId}`);

  onLog("Google: suppression de TOUS les evenements tagues (sans restriction de date).");
  const tagNormalized = EVENT_TAG.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  let deletedEvents = 0;
  let pageToken = "";
  do {
    const existing = await calendarApi.events.list({
      calendarId,
      singleEvents: true,
      maxResults: 250,
      pageToken: pageToken || undefined,
    });
    const existingItems = existing.data.items || [];
    for (const item of existingItems) {
      if (!item.id) continue;
      const desc = (item.description || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const summ = (item.summary || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const loc = (item.location || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      if (desc.includes(tagNormalized) || summ.includes(tagNormalized) || loc.includes(tagNormalized)) {
        try {
          await calendarApi.events.delete({ calendarId, eventId: item.id });
          deletedEvents += 1;
        } catch (deleteErr) {
          onLog(`Google: ECHEC suppression event ${item.id}: ${deleteErr.message}`);
        }
      }
    }
    pageToken = String(existing.data.nextPageToken || "");
  } while (pageToken);
  onLog(`Google: evenements supprimes = ${deletedEvents}.`);

  let createdEvents = 0;
  onLog(`Google: creation de ${sessions.length} evenement(s) depuis les seances.`);
  for (const session of sessions) {
    const details = filmDetails?.[session.title] || {};
    const trailer = trailers?.[session.title] || details.youtube_url || "";
    const event = sessionToEvent(session, details, trailer);
    await calendarApi.events.insert({ calendarId, requestBody: event });
    createdEvents += 1;
    onLog(`Google: evenement cree [${createdEvents}/${sessions.length}] "${session.title}"`);
  }

  let playlistUpdated = false;
  if (YOUTUBE_PLAYLIST_ID) {
    onLog(`YouTube: nettoyage playlist ${YOUTUBE_PLAYLIST_ID}.`);
    const playlistItems = await youtubeApi.playlistItems.list({
      playlistId: YOUTUBE_PLAYLIST_ID,
      part: ["id", "snippet"],
      maxResults: 50,
    });
    const playlistExisting = playlistItems.data.items || [];
    onLog(`YouTube: ${playlistExisting.length} item(s) existant(s).`);
    let playlistDeleted = 0;
    for (const item of playlistExisting) {
      if (!item.id) continue;
      await youtubeApi.playlistItems.delete({ id: item.id });
      playlistDeleted += 1;
    }
    onLog(`YouTube: item(s) supprimes = ${playlistDeleted}.`);

    const trailerList = Object.values(trailers || {});
    let inserted = 0;
    let skipped = 0;
    for (const trailerUrl of trailerList) {
      const m = String(trailerUrl).match(/[?&]v=([a-zA-Z0-9_-]+)/);
      if (!m) {
        skipped += 1;
        continue;
      }
      await youtubeApi.playlistItems.insert({
        part: ["snippet"],
        requestBody: {
          snippet: {
            playlistId: YOUTUBE_PLAYLIST_ID,
            resourceId: {
              kind: "youtube#video",
              videoId: m[1],
            },
          },
        },
      });
      inserted += 1;
    }
    onLog(`YouTube: insertions=${inserted}, ignores=${skipped}.`);
    playlistUpdated = true;
  } else {
    onLog("YouTube: playlist non configuree, etape ignoree.");
  }

  return { createdEvents, playlistUpdated };
}

export async function purgeCalendarEventsFromDate(fromDateIso, options = {}) {
  const onLog = typeof options.onLog === "function" ? options.onLog : noop;
  const fromDate = new Date(String(fromDateIso || ""));
  if (Number.isNaN(fromDate.getTime())) {
    throw new Error("Date de purge invalide.");
  }

  onLog(`Google purge: initialisation a partir de ${fromDate.toISOString()}.`);
  const oauth = getOAuthClient();
  const calendarApi = google.calendar({ version: "v3", auth: oauth });
  const calendarId = await resolveCalendarId(calendarApi);
  onLog(`Google purge: calendar cible = ${calendarId}`);

  let pageToken = "";
  let listed = 0;
  let deleted = 0;

  do {
    const listRes = await calendarApi.events.list({
      calendarId,
      singleEvents: true,
      orderBy: "startTime",
      timeMin: fromDate.toISOString(),
      maxResults: 250,
      pageToken: pageToken || undefined,
    });
    const items = listRes.data.items || [];
    listed += items.length;
    onLog(`Google purge: page recue (${items.length} evenement(s)).`);

    for (const item of items) {
      if (!item.id) continue;
      const summary = String(item.summary || "(sans titre)");
      const timeRange = formatEventTimeRange(item);
      await calendarApi.events.delete({ calendarId, eventId: item.id });
      deleted += 1;
      onLog(`Google purge: evenement supprime [${deleted}] "${summary}" (${timeRange})`);
    }

    pageToken = String(listRes.data.nextPageToken || "");
  } while (pageToken);

  onLog(`Google purge: termine. list\u00e9s=${listed}, supprimes=${deleted}.`);
  return {
    calendarId,
    fromDate: fromDate.toISOString(),
    listed,
    deleted,
  };
}
