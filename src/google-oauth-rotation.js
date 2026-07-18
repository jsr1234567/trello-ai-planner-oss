import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import { config } from "./config.js";

export const googlePlannerScopes = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks"
];

const authorizationStates = new Map();

function oauthClient() {
  if (!config.calendar.clientId || !config.calendar.clientSecret) throw new Error("Google OAuth client credentials are not configured.");
  return new google.auth.OAuth2(config.calendar.clientId, config.calendar.clientSecret, config.calendar.redirectUri);
}

export function beginGooglePlannerAuthorization(now = Date.now()) {
  for (const [state, expiresAt] of authorizationStates) if (expiresAt <= now) authorizationStates.delete(state);
  const state = randomBytes(32).toString("base64url");
  authorizationStates.set(state, now + 10 * 60 * 1000);
  const authorizationUrl = oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: googlePlannerScopes,
    state
  });
  return { authorizationUrl, state };
}

export async function exchangeGooglePlannerAuthorization({ code, state }, now = Date.now()) {
  const expiresAt = authorizationStates.get(state);
  authorizationStates.delete(state);
  if (!code || !expiresAt || expiresAt <= now) throw new Error("Google authorization state is missing or expired.");
  const { tokens } = await oauthClient().getToken(code);
  if (!tokens.refresh_token) throw new Error("Google did not issue a refresh token. Start authorization again.");
  return { refreshToken: tokens.refresh_token };
}

export function replaceEnvironmentAssignment(source, name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid environment variable name.");
  if (!value || /[\r\n]/.test(value)) throw new Error("Secret values must be a single non-empty line.");
  const line = `${name}=${value}`;
  const expression = new RegExp(`^${name}=.*$`, "m");
  return expression.test(source)
    ? source.replace(expression, line)
    : `${source.replace(/\n?$/, "\n")}${line}\n`;
}
