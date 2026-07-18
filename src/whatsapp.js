import { config } from "./config.js";

export async function sendWhatsApp(body) {
  const { accountSid, authToken, from, to } = config.whatsapp;
  if (!accountSid || !authToken || !from || !to) {
    return { sent: false, message: "WhatsApp is not configured yet." };
  }

  const payload = new URLSearchParams({ From: from, To: to, Body: body });
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: payload
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`WhatsApp ${response.status}: ${result.message || "request failed"}`);
  return { sent: true, sid: result.sid };
}
