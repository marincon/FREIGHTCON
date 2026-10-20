# Update 2026-10-20b: Schiff, Incoterms, Firmenadresse

1. Supabase → SQL Editor → New query → Inhalt von `supabase/update_2026-10-20b.sql` einfügen → Run.
   Erwartet: "Success. No rows returned". Darf mehrfach laufen.
2. GitHub: `index.html` und den Ordner `assets` hochladen (überschreiben), Commit.
   `config.js` nicht anfassen.
3. Nur falls die Alerts schon laufen: Edge Function `notify` öffnen, Code durch
   `supabase/functions/notify/index.ts` ersetzen, Deploy.
4. Seite mit Strg + Shift + R neu laden.

Bestehende Kunden ohne Adresse: Internal → Customers → Kunde anklicken → Adresse eintragen,
oder der Kunde ergänzt sie selbst unter Avatar → My profile.
