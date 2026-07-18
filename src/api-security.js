import { timingSafeEqual } from "node:crypto";

export function isLoopbackHost(host) {
  const value = String(host || "").trim().toLowerCase();
  return value === "localhost" || value === "::1";
}

export function assertSafeServerConfig({ host, apiToken }) {
  if (!isLoopbackHost(host) && !apiToken) {
    throw new Error("PLANNER_HOST is public but PLANNER_API_TOKEN is not configured. Keep the planner on loopback or set a bearer token first.");
  }
}

export function validBearerToken(header, apiToken) {
  if (!apiToken || typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(apiToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function apiAuthMiddleware({ host, apiToken }) {
  return (req, res, next) => {
    if (!apiToken && isLoopbackHost(host)) return next();
    if (validBearerToken(req.get("authorization"), apiToken)) return next();
    res.status(401).json({ error: "Bearer authentication is required." });
  };
}

export function securityHeaders(_req, res, next) {
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  next();
}
