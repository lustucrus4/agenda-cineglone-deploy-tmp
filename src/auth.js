import axios from "axios";
import { AUTH_API_BASE, AUTH_SITE_KEY, AUTH_TIMEOUT_MS, CORS_ORIGINS } from "./config.js";

function corsOrigin(origin) {
  if (!origin) return "";
  return CORS_ORIGINS.includes(origin) ? origin : "";
}

export function applyCors(req, res) {
  const allowed = corsOrigin(req.headers.origin || "");
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
}

export function corsPreflight(req, res, next) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
}

export async function requireAgendaRole(req, res, next) {
  try {
    applyCors(req, res);
    const authHeader = String(req.headers.authorization || "");
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ detail: "Bearer token manquant." });
    }
    const token = authHeader.slice("Bearer ".length).trim();
    const [meOut, accessOut] = await Promise.all([
      axios.get(`${AUTH_API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: AUTH_TIMEOUT_MS,
      }),
      axios.get(`${AUTH_API_BASE}/api/auth/access/${AUTH_SITE_KEY}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: AUTH_TIMEOUT_MS,
      }),
    ]);
    if (!accessOut?.data?.allowed) {
      return res.status(403).json({ detail: "Acces refuse pour ce role." });
    }
    req.user = meOut.data || null;
    req.access = accessOut.data || null;
    return next();
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    if (status === 401 || status === 403) {
      return res.status(status).json({ detail: "Session invalide." });
    }
    return res.status(503).json({ detail: "Service auth indisponible." });
  }
}
