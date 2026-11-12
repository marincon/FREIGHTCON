// FREIGHTCON — staff user management (Supabase Edge Function, Deno)
// Called from Internal → Customers with the staff member's own session (Authorization: Bearer <jwt>).
// Only staff (profiles.is_admin) may call it. Uses the service role, which never leaves this function.
//
//   { action: "create",  email, full_name, company?, phone?, customer_id?, office_id?, cover_type?, is_admin?, password?, send_link? }
//       → creates the login already confirmed (no verification e-mail), activates the profile and assigns
//         customer, office and cover type. Optionally sends a "set your password" link.
//   { action: "disable", user_id }   → is_active = false, login blocked (history kept)
//   { action: "enable",  user_id }   → is_active = true, login allowed again
//   { action: "delete",  user_id }   → login removed and personal data anonymised (shipments, quotations and the
//         change log stay), then a confirmation e-mail goes to the staff member who deleted the user.
//
// Deploy:  supabase functions deploy admin-manage-user
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. APP_URL as for notify.

import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const COVER = ["one_off", "open_cover", "policy"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    // who is calling?
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "not signed in" }, 401);
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u?.user) return json({ error: "not signed in" }, 401);
    const { data: me } = await admin.from("profiles").select("id,email,full_name,is_admin,is_active").eq("id", u.user.id).single();
    if (!me?.is_admin || me.is_active === false) return json({ error: "not authorised" }, 403);

    const b = await req.json().catch(() => ({}));
    const action = String(b.action || "");

    if (action === "create") {
      const email = String(b.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Please enter a valid e-mail address." }, 400);
      const name = String(b.full_name || "").trim().slice(0, 150);
      if (name.length < 2) return json({ error: "Please enter the user's name." }, 400);
      const cover = b.cover_type ? String(b.cover_type) : null;
      if (cover && !COVER.includes(cover)) return json({ error: "invalid cover type" }, 400);
      const password = b.password ? String(b.password) : crypto.randomUUID() + "Aa1!";
      if (password.length < 10) return json({ error: "The password needs at least 10 characters." }, 400);
      const { data: created, error: ce } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { full_name: name, company: b.company || "", phone: b.phone || "", created_by_staff: me.email },
      });
      if (ce || !created?.user) return json({ error: ce?.message || "could not create the user" }, 400);
      const id = created.user.id;
      // the profile row is created by the signup trigger; make sure it exists, then activate and assign
      let office: any = null;
      if (b.office_id) { const r = await admin.from("offices").select("id,customer_id,name").eq("id", b.office_id).single(); office = r.data; }
      const custId = office?.customer_id ?? (b.customer_id || null);
      let groupId: number | null = null;
      if (custId) groupId = (await admin.from("customers").select("group_id").eq("id", custId).single()).data?.group_id ?? null;
      const [first, ...rest] = name.split(/\s+/);
      const patch: Record<string, unknown> = {
        first_name: first, last_name: rest.join(" ") || null, group_id: groupId,
        email, full_name: name, company: b.company || null, phone: b.phone || null,
        approved: true, rejected: false, is_active: true, approved_at: new Date().toISOString(),
        is_admin: !!b.is_admin, cover_type: cover,
        customer_id: custId, office_id: office?.id ?? null,
      };
      const up = await admin.from("profiles").upsert({ id, ...patch }, { onConflict: "id" });
      if (up.error) return json({ error: up.error.message }, 400);
      let link: string | null = null;
      if (b.send_link !== false) {
        const gl = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: env("APP_URL").replace(/\/$/, "") + "/index.html" } });
        link = gl.data?.properties?.action_link ?? null;
        let customer = null;
        if (patch.customer_id) customer = (await admin.from("customers").select("name").eq("id", patch.customer_id).single()).data?.name ?? null;
        await admin.from("outbox").insert({ kind: "user_created", payload: { email, name, customer, staff_name: me.full_name || me.email, link } });
      }
      return json({ ok: true, user_id: id, link });
    }

    const userId = String(b.user_id || "");
    if (!userId) return json({ error: "user_id required" }, 400);
    if (userId === me.id) return json({ error: "You cannot do this to your own account." }, 400);
    const { data: target } = await admin.from("profiles").select("id,email,full_name,company,customer_id,office_id,deleted_at").eq("id", userId).single();
    if (!target) return json({ error: "user not found" }, 404);

    if (action === "disable" || action === "enable") {
      const on = action === "enable";
      const r = await admin.from("profiles").update({ is_active: on, disabled_at: on ? null : new Date().toISOString() }).eq("id", userId);
      if (r.error) return json({ error: r.error.message }, 400);
      // blocks new sign-ins and refreshes at the auth level as well
      await admin.auth.admin.updateUserById(userId, { ban_duration: on ? "none" : "876000h" });
      return json({ ok: true });
    }

    if (action === "delete") {
      if (target.deleted_at) return json({ error: "already deleted" }, 400);
      const at = new Date().toISOString();
      let customer = null, office = null;
      if (target.customer_id) customer = (await admin.from("customers").select("name").eq("id", target.customer_id).single()).data?.name ?? null;
      if (target.office_id) office = (await admin.from("offices").select("name").eq("id", target.office_id).single()).data?.name ?? null;
      // anonymise the profile, keep the records that belong to it (shipments, quotations, invoices, audit)
      const anon = `deleted-${userId.slice(0, 8)}@deleted.invalid`;
      const r = await admin.from("profiles").update({
        email: anon, full_name: "Deleted user", phone: null, internal_note: null, is_active: false, approved: false,
        deleted_at: at, disabled_at: at, office_id: null, referral_code: null,
      }).eq("id", userId);
      if (r.error) return json({ error: r.error.message }, 400);
      // remove the login: change the address, ban, and drop all sessions
      await admin.auth.admin.updateUserById(userId, { email: anon, ban_duration: "876000h", user_metadata: { deleted_at: at } });
      await admin.auth.admin.signOut(userId).catch(() => null);
      await admin.from("audit_log").insert({ user_id: me.id, user_name: me.full_name || me.email, entity: "user", entity_id: userId,
        summary: `User deleted and anonymised: ${target.full_name || ""} <${target.email}>${customer ? " (" + customer + ")" : ""}`, reason: b.reason || null });
      await admin.from("outbox").insert({ kind: "user_deleted", payload: {
        at, deleted_name: target.full_name, deleted_email: target.email, customer, office, staff_name: me.full_name, staff_email: me.email } });
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
