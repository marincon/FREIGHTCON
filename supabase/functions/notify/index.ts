// FREIGHTCON — alert sender (Supabase Edge Function, Deno)
// Called by a Database Webhook on INSERT into public.outbox.
// Sends Telegram messages to the staff group and e-mails via SMTP (e.g. IONOS),
// then marks the outbox row as processed.
//
// Secrets (Dashboard → Edge Functions → notify → Secrets, or `supabase secrets set`):
//   WEBHOOK_SECRET        shared secret, also set as header "x-webhook-secret" on the webhook
//   TELEGRAM_BOT_TOKEN    from @BotFather
//   TELEGRAM_CHAT_ID      the group chat id (negative number for groups)
//   SMTP_HOST             e.g. smtp.ionos.de
//   SMTP_PORT             465 (SSL) or 587 (STARTTLS)
//   SMTP_USER / SMTP_PASS mailbox login
//   SMTP_FROM             e.g. "FREIGHTCON <alerts@freightcon.com>"
//   APP_URL               e.g. https://freightcon.com  (links in e-mails)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.14";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const APP = env("APP_URL").replace(/\/$/, "");

type Row = { id: number; kind: string; payload: Record<string, any>; processed_at: string | null };

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (n: unknown, cur: unknown) => (n == null || n === "" ? "" : (cur === "USD" ? "$" : cur === "EUR" ? "€" : String(cur ?? "") + " ") +
  Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const when = (v: unknown) => v ? new Date(String(v)).toLocaleString("en-GB", { timeZone: "Europe/Berlin", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (Berlin)" : "";

async function settings(): Promise<Record<string, any>> {
  const { data } = await sb.from("settings").select("key,value");
  const s: Record<string, any> = {};
  (data ?? []).forEach((r: any) => (s[r.key] = r.value));
  return s;
}

// ---------- Telegram ----------
async function telegram(text: string) {
  const token = env("TELEGRAM_BOT_TOKEN"), chat = env("TELEGRAM_CHAT_ID");
  if (!token || !chat) return "telegram: not configured";
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return r.ok ? "telegram: sent" : "telegram: " + r.status + " " + (await r.text()).slice(0, 120);
}

// ---------- e-mail ----------
let transport: any = null;
function mailer() {
  if (transport) return transport;
  if (!env("SMTP_HOST") || !env("SMTP_USER")) return null;
  const port = Number(env("SMTP_PORT", "465"));
  transport = nodemailer.createTransport({ host: env("SMTP_HOST"), port, secure: port === 465, auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") } });
  return transport;
}
function layout(brand: string, legal: string, title: string, bodyHtml: string, cta?: { href: string; label: string }) {
  return `<!doctype html><html><body style="margin:0;background:#EDF1F2;font-family:Arial,Helvetica,sans-serif;color:#12232A">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden">
    <tr><td style="background:#0C3640;padding:18px 26px;border-bottom:4px solid #E9A23B;color:#fff;font-weight:bold;font-size:18px;letter-spacing:.04em">${esc(brand)}</td></tr>
    <tr><td style="padding:26px">
      <h1 style="margin:0 0 14px;font-size:20px;color:#0C3640">${esc(title)}</h1>
      ${bodyHtml}
      ${cta ? `<p style="margin:24px 0 6px"><a href="${esc(cta.href)}" style="background:#137C83;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold;display:inline-block">${esc(cta.label)}</a></p>` : ""}
    </td></tr>
    <tr><td style="padding:16px 26px;background:#F6F8F9;color:#5E6E75;font-size:12px">${esc(legal || brand)}</td></tr>
  </table></td></tr></table></body></html>`;
}
const kv = (rows: [string, unknown][]) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.5">${rows.filter((r) => r[1] != null && r[1] !== "")
    .map(([k, v]) => `<tr><td style="color:#5E6E75;padding:3px 16px 3px 0;vertical-align:top">${esc(k)}</td><td style="font-weight:bold;padding:3px 0">${esc(v)}</td></tr>`).join("")}</table>`;

async function email(to: string[], subject: string, html: string, bcc: string[] = []) {
  const t = mailer();
  if (!t) return "email: not configured";
  const list = [...new Set(to.filter(Boolean).map((x) => x.trim().toLowerCase()))];
  const bccList = [...new Set(bcc.filter(Boolean).map((x) => x.trim().toLowerCase()))].filter((x) => !list.includes(x));
  if (!list.length && !bccList.length) return "email: no recipient";
  await t.sendMail({ from: env("SMTP_FROM", env("SMTP_USER")), to: list.length ? list : bccList, bcc: list.length ? bccList : undefined, subject, html });
  return "email: sent to " + (list.length + bccList.length);
}

// ---------- event → messages ----------
async function handle(row: Row) {
  const s = await settings();
  const brand = s.brand_name || "FREIGHTCON", legal = s.company_legal || "";
  const tgOn = s.telegram_enabled !== false, mailOn = s.email_enabled !== false;
  const cc: string[] = s.alert_cc ? [String(s.alert_cc)] : [];
  const staff: string[] = Array.isArray(s.staff_emails) ? s.staff_emails : [];
  const p = row.payload || {};
  const who = [p.company, p.name].filter(Boolean).join(", ") || p.email || "";
  const route = p.origin && p.dest ? `${p.origin_place ? p.origin_place + ", " : ""}${p.origin} → ${p.dest_place ? p.dest_place + ", " : ""}${p.dest}` : "";
  const out: string[] = [];
  const staffMail = async (subject: string, title: string, rows: [string, unknown][], link = APP + "/app.html#admin") => {
    if (mailOn) out.push(await email(staff.length ? staff : cc, subject, layout(brand, legal, title, kv(rows), { href: link, label: "Open in " + brand }), staff.length ? cc : []));
  };
  const custMail = async (subject: string, title: string, html: string, cta?: { href: string; label: string }) => {
    if (mailOn && p.email) out.push(await email([p.email], subject, layout(brand, legal, title, html, cta), cc));
  };

  switch (row.kind) {
    case "quote_request": {
      if (tgOn) out.push(await telegram(`📦 <b>New quotation request ${esc(p.ref)}</b>\n${esc(who)}\n${esc(route)}\n${esc(p.goods)}\nSum insured ${esc(money(p.sum_insured, p.currency))}` +
        (p.premium != null ? `\nIndication ${esc(money(p.premium, p.currency))}` : `\nStatus: ${esc(p.status)}`) + (p.comment ? `\n💬 ${esc(p.comment)}` : "")));
      await staffMail(`New request ${p.ref} — ${p.company || p.email}`, "New quotation request", [["Reference", p.ref], ["Customer", who], ["E-mail", p.email], ["Route", route], ["Goods", p.goods],
        ["Sum insured", money(p.sum_insured, p.currency)], ["Indication", p.premium != null ? money(p.premium, p.currency) : p.status], ["Message", p.comment]]);
      await custMail(`We received your request ${p.ref}`, "Thank you for your request",
        `<p style="font-size:14px;line-height:1.6">We received your quotation request <b>${esc(p.ref)}</b> and are working on it. You are notified as soon as the quotation is ready.</p>` +
        kv([["Route", route], ["Goods", p.goods], ["Sum insured", money(p.sum_insured, p.currency)]]), { href: APP + "/app.html#quotes", label: "My quotations" });
      break;
    }
    case "quotation_sent":
      await custMail(`Your quotation ${p.ref}${p.version > 1 ? " (version " + p.version + ")" : ""} is ready`, "Your quotation is ready",
        `<p style="font-size:14px;line-height:1.6">Your quotation for <b>${esc(p.ref)}</b> is ready. Review it and accept it online before it expires.</p>` +
        kv([["Total premium", money(p.total, p.currency)], ["Valid until", when(p.valid_until)]]), { href: APP + "/app.html#quotes", label: "Review quotation" });
      break;
    case "quotation_response":
      if (tgOn) out.push(await telegram(`${p.accepted ? "✅" : "❌"} <b>${esc(p.ref)} ${p.accepted ? "ACCEPTED" : "declined"}</b>\n${esc(who)}\n${esc(money(p.total, p.currency))}` + (p.note ? `\n💬 ${esc(p.note)}` : "") + (p.accepted ? "\n➡️ Confirm with the insurer and issue the cover note." : "")));
      await staffMail(`${p.ref} ${p.accepted ? "accepted" : "declined"} by ${p.company || p.email}`, p.accepted ? "Quotation accepted" : "Quotation declined",
        [["Reference", p.ref], ["Customer", who], ["Total", money(p.total, p.currency)], ["Message", p.note]]);
      break;
    case "cover_note_issued":
      await custMail(`Cover note ${p.number} for ${p.ref}`, "Your shipment is covered",
        `<p style="font-size:14px;line-height:1.6">Cover is confirmed. Download your cover note <b>${esc(p.number)}</b> in ${esc(brand)}.</p>`, { href: APP + "/app.html#quotes", label: "Download cover note" });
      if (tgOn) out.push(await telegram(`🛡 Cover note <b>${esc(p.number)}</b> issued for ${esc(p.ref)} (${esc(who)})`));
      break;
    case "new_registration":
      if (tgOn) out.push(await telegram(`👤 <b>New registration</b>\n${esc(who)}\n${esc(p.email)}${p.country ? "\n" + esc(p.country) : ""}${p.referred ? "\n🎁 via invitation link" : ""}\n➡️ Activate under Internal → Customers.`));
      await staffMail(`New registration: ${p.company || p.email}`, "New registration to activate", [["Company", p.company], ["Name", p.name], ["E-mail", p.email], ["Country", p.country], ["Invited", p.referred ? "Yes" : "No"]]);
      break;
    case "account_approved":
      await custMail(`Your ${brand} account is active`, "Welcome aboard",
        `<p style="font-size:14px;line-height:1.6">Your account is active. You can now calculate cargo insurance indications and request quotations online.</p>`, { href: APP + "/index.html", label: "Log in" });
      break;
    case "feedback":
      if (tgOn) out.push(await telegram(`💬 <b>Feedback</b> from ${esc(who)}\n${esc(p.message)}`));
      await staffMail(`Feedback from ${p.company || p.email}`, "New feedback", [["From", who], ["E-mail", p.email], ["Message", p.message]]);
      break;
    case "deletion_request":
      if (tgOn) out.push(await telegram(`🗑 <b>Account deletion requested</b>\n${esc(who)}\n${esc(p.email)}`));
      await staffMail(`Deletion request: ${p.email}`, "Account deletion requested", [["Customer", who], ["E-mail", p.email]]);
      break;
    case "test":
      if (tgOn) out.push(await telegram(`🔔 Test alert from ${esc(brand)}`));
      if (mailOn) out.push(await email(staff.length ? staff : cc, `${brand} test e-mail`, layout(brand, legal, "Test e-mail", "<p>E-mail alerts work.</p>")));
      break;
    default:
      out.push("ignored kind " + row.kind);
  }
  return out.join("; ") || (tgOn || mailOn ? "nothing to send" : "alerts switched off");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const secret = env("WEBHOOK_SECRET");
  if (!secret || req.headers.get("x-webhook-secret") !== secret) return new Response("forbidden", { status: 403 });
  let body: any;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
  const rec: Row | undefined = body?.record;
  if (!rec?.id) return new Response("no record", { status: 400 });
  // re-read the row (never trust the webhook body alone) and skip duplicates
  const { data: row } = await sb.from("outbox").select("*").eq("id", rec.id).maybeSingle();
  if (!row) return new Response("unknown row", { status: 404 });
  if (row.processed_at) return new Response("already processed", { status: 200 });
  let result: string;
  try { result = await handle(row as Row); }
  catch (e) { result = "error: " + String((e as Error)?.message ?? e).slice(0, 300); }
  await sb.from("outbox").update({ processed_at: new Date().toISOString(), result }).eq("id", row.id);
  return new Response(JSON.stringify({ ok: !result.startsWith("error"), result }), { headers: { "content-type": "application/json" } });
});
