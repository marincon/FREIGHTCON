# Updates einspielen

## Update 2026-10-20e: eigenes Tarifmodell (Warenklassen-Faktoren)
1. Supabase → SQL Editor → `supabase/update_2026-10-20e.sql` → Run.
2. GitHub: Inhalt der Website-ZIP hochladen, Commit, Seite mit Strg + Shift + R neu laden.
Voraussetzung: c und d wurden vorher ausgeführt.

## Update 2026-10-20d: Agrarprodukte quotierbar
Supabase → SQL Editor → `supabase/update_2026-10-20d.sql` → Run. Nur Datenbank, keine Website-Änderung.

## Update 2026-10-20c: Tarifierung nach Bertling-Schema (Zonen-Matrizen)

1. Supabase → SQL Editor → New query → kompletten Inhalt von `supabase/update_2026-10-20c.sql` einfügen → Run.
   Erwartet: "Success. No rows returned".
   Achtung: Ein erneutes Ausführen setzt Matrizen und Länderzonen auf den Stand dieser Datei zurück.
2. GitHub: den INHALT der Website-ZIP hochladen (alle HTML-Dateien + Ordner assets), Commit.
3. Seite mit Strg + Shift + R neu laden.

Voraussetzung: update_2026-10-20b.sql wurde vorher ausgeführt.

## Neuinstallation (leeres Supabase-Projekt)
Reihenfolge im SQL Editor: schema.sql → seed.sql → update_2026-10-20c.sql → update_2026-10-20d.sql → update_2026-10-20e.sql
(update_2026-10-20b ist in schema.sql bereits enthalten.)
