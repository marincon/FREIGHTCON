# FREIGHTCON

Cargo Insurance Indications, Quotations & Cover — Kundenportal für Transportversicherung nach dem EWRICON-Prinzip:
Kunde gibt Ware, Route und Wert ein → sieht sofort eine Indikation → fordert mit einem Klick eine Quotation an → nimmt sie online an → erhält Cover Note und Rechnung.

## Was drin ist

| Datei | Inhalt |
|---|---|
| `index.html` | Login, Registrierung (mit Einladungscode `?ref=`), Passwort vergessen / neu setzen |
| `app.html` + `assets/app.js` | Kundenbereich: Neue Sendung, Indikation, PDF, Quotation anfragen, My quotations (annehmen/ablehnen, Cover Note, Rechnungen), History, Profil, Passwort, Einladen, Meine Daten (Excel-Export, Löschantrag), Feedback, Dark Mode, Auto-Logout nach 60 Min. |
| `assets/admin.js` | Interner Bereich: Requests (To-do-Liste, Fallakte mit Stage/Owner/Follow-up, Notizen, Timeline), Quotation-Editor mit Versionen, Cover-Note-Editor, Rechnungs-Upload, Text für Versicherer, Overview, Customers (Freischalten, Rabatt, Referrals), Rates (Warengruppen, Regionen, Länder, Faktoren, Test-Rechnung), Insurers, Feedback, Settings (Wartung, Telegram/E-Mail an/aus, Test-Alert, Alert-Protokoll) |
| `assets/pdf.js` | PDFs für Indikation, Quotation, Cover Note |
| `assets/core.js`, `assets/style.css` | Gemeinsame Helfer und Design |
| `supabase/schema.sql` | Komplettes Datenbankschema inkl. Rechte (RLS) und aller Funktionen |
| `supabase/seed.sql` | Regionen, 241 Länder, 18 Warengruppen mit **Platzhalter-Raten** |
| `supabase/functions/notify/index.ts` | Edge Function für Telegram + E-Mail |
| `terms.html`, `privacy.html`, `imprint.html` | **Entwürfe**, müssen anwaltlich geprüft und ergänzt werden |
| `config.example.js` | Vorlage für `config.js` |

## Einrichtung (ca. 1 Stunde)

### 1. Supabase-Projekt
1. Neues Projekt auf supabase.com anlegen, Region **Frankfurt (eu-central-1)**.
2. SQL Editor → nacheinander ausführen: `supabase/schema.sql`, `supabase/seed.sql`, `supabase/update_2026-10-20c.sql`, `supabase/update_2026-10-20d.sql`, `supabase/update_2026-10-20e.sql`, `supabase/update_2026-10-20f.sql`, `supabase/update_2026-10-20g.sql`, `supabase/update_2026-10-20h.sql`, `supabase/update_2026-10-20i.sql`, `supabase/update_2026-10-20j.sql`, `supabase/update_2026-10-21k.sql`.
3. Authentication → URL Configuration: *Site URL* = deine Domain (z. B. `https://freightcon.com`), unter *Redirect URLs* `https://freightcon.com/index.html` eintragen.
4. Authentication → Providers → Email: „Confirm email“ an lassen.
5. Authentication → SMTP Settings: IONOS-Postfach eintragen (`smtp.ionos.de`, Port 465), damit Bestätigungs- und Passwort-Mails von deiner Adresse kommen.

### 2. Erster Admin
Auf der Seite registrieren, E-Mail bestätigen, dann im SQL Editor:
```sql
update public.profiles set approved = true, is_admin = true, terms_version = '2026-10-20'
 where email = 'deine@adresse.de';
```

### 3. Website hochladen
`config.example.js` nach `config.js` kopieren, `SUPABASE_URL` und `SUPABASE_ANON_KEY` (Project Settings → API) eintragen.
Dann alle Dateien außer dem Ordner `supabase/` auf einen beliebigen statischen Webspace laden (IONOS Webspace, Netlify, Cloudflare Pages). Kein Server nötig.

### 4. Benachrichtigungen (Telegram + E-Mail)
1. **Telegram:** Bei @BotFather einen Bot anlegen → Token notieren. Bot in eure Gruppe einladen, eine Nachricht schreiben, dann `https://api.telegram.org/bot<TOKEN>/getUpdates` öffnen → `chat.id` (negative Zahl) notieren.
2. **Edge Function deployen** (Supabase CLI):
   ```bash
   supabase functions deploy notify --no-verify-jwt
   supabase secrets set WEBHOOK_SECRET=<langes-zufälliges-passwort> \
     TELEGRAM_BOT_TOKEN=<token> TELEGRAM_CHAT_ID=<chat-id> \
     SMTP_HOST=smtp.ionos.de SMTP_PORT=465 SMTP_USER=alerts@freightcon.com SMTP_PASS=<passwort> \
     SMTP_FROM="FREIGHTCON <alerts@freightcon.com>" APP_URL=https://freightcon.com
   ```
3. **Database Webhook:** Database → Webhooks → Create: Tabelle `outbox`, Event `INSERT`, Typ *HTTP Request*, POST an `https://<project-ref>.supabase.co/functions/v1/notify`, Header `x-webhook-secret: <dasselbe Passwort>`.
4. Im internen Bereich → Settings: `staff_emails` (z. B. deine Adresse und die deines Chefs) und `alert_cc` setzen, dann **Send test alert**. Unter „Recent alerts“ siehst du, ob es angekommen ist.

Welche Alerts es gibt: neue Registrierung, neue Quotation-Anfrage (Team + Eingangsbestätigung an den Kunden), Quotation versendet (an Kunde), Quotation angenommen/abgelehnt (Team), Cover Note ausgestellt (Kunde), Konto freigeschaltet (Kunde), Feedback, Löschantrag.

### 5. Vor dem Start unbedingt
- **Raten ersetzen.** Alle Raten in `seed.sql` sind Platzhalter zum Testen. Internal → Rates → eure echten Werte eintragen, dann mit „Test a calculation“ prüfen.
- Länderlisten prüfen: sanktionierte Länder (aktuell RU, BY, IR, KP, SY) und „on request“-Länder an eure Compliance anpassen.
- Settings: `company_legal`, `default_insurer`, `deductible_text`, `quote_subjectivities`, `claims_text`.
- Rechtstexte anwaltlich fertigstellen (insbesondere §34d-Status, Haftung, Impressum).

## So rechnet die Indikation (Stand 2026-10-20e)

Siehe Kopf von `supabase/update_2026-10-20e.sql`: Routen-Grundrate × Warenklassen-Faktor × Deckung × Transportart × Verpackung × Zuschläge, War & Strikes separat, × Interest-Faktor.

## Vorgängerstand 2026-10-20c (Bertling-Schema)

Rate (‰) = Matrix-Rate des Zonenpaars (Abgangszone ↔ Zielzone) aus der Tabelle der Warengruppe
× Deckungsfaktor (ICC A 1,0 / B 0,75 / C 0,5) × Zuschläge (an Deck +50 %, Luft gebraucht/Fahrzeuge +50 % bzw. Charter +25 %)
× 0,4 bei Seller's/Buyer's Interest; War & Strikes: in Seeraten enthalten (0,5 ‰, abwählbar), bei Luft +0,5 ‰; plus Krisenzuschlag je Land.
Mindestprämie je Tabelle (100). Länder ohne Zone (weiß auf der Karte) und *-Länder (lokale Versicherungsregeln) → on request.
Straße/Schiene nutzen die Seetabelle der Warengruppe × land_factor (Annahme, in Factors & limits änderbar).

## Alte Platzhalter-Logik (bis 2026-10-20b, nicht mehr aktiv)

```
Rate = Basisrate (Warengruppe × Transportmittel)
       × höchster Regionsfaktor (Abgangs- oder Bestimmungsland)
       × Deckungsfaktor (ICC A 1,0 / B 0,75 / C 0,55)
     + War-&-Strikes-Rate der riskanteren Region (Straße/Schiene: ein Viertel, nur Streik/Aufruhr)
Prämie = Versicherungssumme (Rechnungswert + 10 %) × Rate − Kundenrabatt, mindestens Mindestprämie
```
Beispiel: Maschinen neu, Hamburg → Shanghai, Container, € 120.000 → VS € 132.000 × (0,12 % × 1,1 + 0,025 %) = 0,157 % → **€ 207,24**.

Automatisch „on request“: Warengruppe immer individuell (z. B. Gefahrgut, Projektladung), keine Basisrate für das Transportmittel, Deckung nicht erlaubt, Land/Region on request (z. B. Ukraine), VS über Auto-Limit, Abfahrt in der Vergangenheit. Sanktioniertes Land → kein Preis, Compliance-Hinweis.

Die Raten liegen nur in der Datenbank; Kunden können sie technisch nicht auslesen. Jede Zahl, die der Kunde sieht, ist exakt die gespeicherte.

## Unterschiede zu EWRICON
Bewusst nicht übernommen, weil für Cargo nicht sinnvoll: Karte, Vessel Tracking, Listed Areas, Transit-Meldungen (Entry/Exit), My Fleet. Neu: Warengruppen- und Länder-Tarifierung, ICC A/B/C, Uplift, Cover Note mit B/L-Nummer, Rechnungs-Upload mit Kunden-Download, Referral-Rabatt als echter Workflow.

## Getestet
- Datenbank: Rechnung, Mindestprämie, Rabatt, Sanktionen, on request, Referenznummern, Rechte (Kunde sieht nur eigene Daten, keine Raten, keine Admin-Funktionen, kann sich nicht selbst zum Admin machen), Wartungsmodus.
- Oberfläche end-to-end im Browser: Registrierung bis Cover Note und Rechnung, Desktop und Handy, hell und dunkel, ohne Konsolenfehler.
- Nicht getestet (braucht eure Zugänge): echter Supabase-Login, Telegram, SMTP.
