import axios from "axios";
import * as cheerio from "cheerio";
import { CINEGLONNE_URL, DEFAULT_MOVIE_DURATION_MIN } from "../config.js";

function parseShortDate(text) {
  const m = String(text || "").trim().match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (candidate.getTime() < now.getTime() - 24 * 3600 * 1000) {
    year += 1;
  }
  return { year, month, day };
}

function parseFrenchTime(text) {
  const m = String(text || "").trim().match(/(\d{1,2})h(\d{2})/i);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function getParisOffsetMs(utcMs) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+0";
  const m = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2] || 0);
  const minutes = Number(m[3] || 0);
  return sign * (hours * 60 + minutes) * 60_000;
}

function combineDateTime(date, hm) {
  if (!date || !hm) return null;
  const localMs = Date.UTC(date.year, date.month - 1, date.day, hm.hour, hm.minute, 0);
  let utcMs = localMs;
  for (let i = 0; i < 2; i += 1) {
    const offsetMs = getParisOffsetMs(utcMs);
    utcMs = localMs - offsetMs;
  }
  return new Date(utcMs);
}

function normalizeYoutubeUrl(rawUrl) {
  const src = String(rawUrl || "").trim();
  if (!src) return "";
  const full = src.startsWith("//") ? `https:${src}` : src;
  const m = full.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]+)/i);
  if (!m) return "";
  return `https://www.youtube.com/watch?v=${m[1]}`;
}

function extractSynopsis($film, filmHtml, bodyText) {
  const directCandidates = [
    "#resume",
    ".resume",
    ".synopsis",
    ".film-synopsis",
    ".movie-synopsis",
    "[data-role='resume']",
  ];
  for (const selector of directCandidates) {
    const txt = $film(selector).first().text().replace(/\s+/g, " ").trim();
    if (txt && txt.length >= 40) return txt;
  }

  const resumeIdMatch =
    String(filmHtml || "").match(/\/resumes\/(\d{1,10})/) ||
    String(filmHtml || "").match(/resume[s]?["'\s:=/]+(\d{1,10})/i);
  if (resumeIdMatch) {
    const endpointTag = `RESUME_ENDPOINT:${resumeIdMatch[1]}`;
    return endpointTag;
  }

  let cleaned = String(bodyText || "");
  const cutTokens = [
    "Date Heure",
    "Voir la liste compl\u00e8te",
    "Mentions l\u00e9gales",
    "R\u00e9alisation du site",
    "var xhr = new XMLHttpRequest",
    "$.get(",
  ];
  for (const token of cutTokens) {
    const idx = cleaned.indexOf(token);
    if (idx > 0) {
      cleaned = cleaned.slice(0, idx).trim();
      break;
    }
  }
  return cleaned.slice(0, 1200).trim();
}

function noop() {}

export async function scrapeSessionsAndDetails(options = {}) {
  const onLog = typeof options.onLog === "function" ? options.onLog : noop;
  const out = {
    sessions: [],
    film_details: {},
    trailers: {},
  };
  onLog(`Scraper: requete page accueil ${CINEGLONNE_URL}`);
  const home = await axios.get(CINEGLONNE_URL, { timeout: 15000 });
  onLog(`Scraper: page accueil chargee (${home.status})`);
  const $ = cheerio.load(home.data);
  const rows = $("table tbody tr");
  onLog(`Scraper: ${rows.length} ligne(s) detectee(s) dans le tableau des seances.`);
  const filmUrlsByTitle = {};
  let skippedPast = 0;
  let skippedInvalid = 0;
  let skippedNoTitle = 0;

  rows.each((_idx, row) => {
    const cells = $(row).find("td");
    if (cells.length < 3) return;
    const dateText = $(cells[0]).text().trim();
    const hourText = $(cells[1]).text().trim();
    const title = $(cells[2]).text().trim();
    if (!title) {
      skippedNoTitle += 1;
      return;
    }
    const date = parseShortDate(dateText);
    const hm = parseFrenchTime(hourText);
    const dt = combineDateTime(date, hm);
    if (!dt) {
      skippedInvalid += 1;
      return;
    }
    const link = $(cells[cells.length - 1]).find("a[href]").attr("href") || "";
    const filmUrl = link.startsWith("/films/") ? `${CINEGLONNE_URL.replace(/\/$/, "")}${link}` : "";
    if (filmUrl && !filmUrlsByTitle[title]) filmUrlsByTitle[title] = filmUrl;
    out.sessions.push({
      title,
      date_time: dt.toISOString(),
      duration: DEFAULT_MOVIE_DURATION_MIN,
      film_url: filmUrl || null,
    });
  });
  onLog(
    `Scraper: seances valides=${out.sessions.length}, ignorees_passees=${skippedPast}, ignorees_invalides=${skippedInvalid}, ignorees_sans_titre=${skippedNoTitle}.`
  );

  let filmFetchOk = 0;
  let filmFetchErr = 0;
  onLog(`Scraper: recuperation des details pour ${Object.keys(filmUrlsByTitle).length} film(s).`);
  for (const [title, filmUrl] of Object.entries(filmUrlsByTitle)) {
    try {
      onLog(`Scraper: details film "${title}" -> ${filmUrl}`);
      const filmPage = await axios.get(filmUrl, { timeout: 15000 });
      const $film = cheerio.load(filmPage.data);
      const details = {
        format: null,
        duration: null,
        director: null,
        actors: null,
        synopsis: null,
        warning: null,
        youtube_url: null,
        additional_info: [],
        genre: null,
      };

      const bodyText = $film("body").text().replace(/\s+/g, " ").trim();
      const durationMatch = bodyText.match(/dur[\u00e9e]e?\s*:\s*(\d+)h(\d+)/i) || bodyText.match(/dur[\u00e9e]e?\s*:\s*(\d+)\s*min/i);
      if (durationMatch) {
        details.duration = durationMatch[2] ? Number(durationMatch[1]) * 60 + Number(durationMatch[2]) : Number(durationMatch[1]);
      }
      const dirMatch = bodyText.match(/R[\u00e9e]alisateur\s*:\s*([^:]+?)Acteurs/i);
      if (dirMatch) details.director = dirMatch[1].trim();
      const actMatch = bodyText.match(/Acteurs?\s*:\s*([^:]+?)(Tout public|Synopsis|$)/i);
      if (actMatch) details.actors = actMatch[1].trim();

      const iframeSrc = $film("iframe[src*='youtube.com/embed']").attr("src") || "";
      const youtubeUrl = normalizeYoutubeUrl(iframeSrc);
      if (youtubeUrl) {
        details.youtube_url = youtubeUrl;
        out.trailers[title] = youtubeUrl;
        onLog(`Scraper: bande-annonce detectee pour "${title}"`);
      }

      details.synopsis = extractSynopsis($film, filmPage.data, bodyText);
      if (String(details.synopsis).startsWith("RESUME_ENDPOINT:")) {
        const resumeId = String(details.synopsis).split(":")[1] || "";
        const base = CINEGLONNE_URL.replace(/\/$/, "");
        const resumeUrl = `${base}/resumes/${resumeId}`;
        try {
          const resumeRes = await axios.get(resumeUrl, { timeout: 15000 });
          const resumeText = String(resumeRes.data || "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (resumeText) {
            details.synopsis = resumeText;
            onLog(`Scraper: synopsis charge via endpoint /resumes/${resumeId} pour "${title}"`);
          } else {
            details.synopsis = "";
          }
        } catch {
          onLog(`Scraper: endpoint /resumes/${resumeId} indisponible pour "${title}"`);
          details.synopsis = "";
        }
      }
      out.film_details[title] = details;
      filmFetchOk += 1;
      onLog(
        `Scraper: details OK "${title}" (duree=${details.duration || "?"}min, real=${details.director ? "oui" : "non"}, acteurs=${details.actors ? "oui" : "non"})`
      );
    } catch (error) {
      filmFetchErr += 1;
      onLog(`Scraper: ECHEC details "${title}" -> ${String(error?.message || error)}`);
    }
  }
  onLog(
    `Scraper: details termines. ok=${filmFetchOk}, erreurs=${filmFetchErr}, bandes_annonces=${Object.keys(out.trailers).length}.`
  );

  return out;
}
