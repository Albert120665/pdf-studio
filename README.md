# PDF Studio – Handy & Tablet

Eigene PDF-App für Android (Samsung) – kostenlos, ohne Abo, ohne Werbung, ohne Konto.
Die PDFs bleiben auf dem Gerät, es wird nichts hochgeladen.

## Einmalig: auf GitHub veröffentlichen (ca. 5 Minuten, am PC)

1. Auf https://github.com anmelden → oben rechts **+** → **New repository**.
   Name: `pdf-studio` · Sichtbarkeit: **Public** (für kostenloses GitHub Pages nötig – öffentlich ist
   nur der App-Code, nie deine PDFs) → **Create repository**.
2. Auf der neuen Seite den Link **„uploading an existing file“** anklicken.
3. Den **Inhalt** des entpackten Ordners `PDF-Studio-Mobil` (also `index.html`, `app.js`, die Ordner
   `vendor` und `icons` usw. – nicht den Ordner selbst) in das Browserfenster ziehen.
   Warten, bis alle Dateien gelistet sind → unten **Commit changes**.
4. Im Repository: **Settings** → links **Pages** → bei *Branch* `main` und `/ (root)` wählen → **Save**.
5. Nach 1–2 Minuten erscheint oben die Adresse, z. B. `https://DEINNAME.github.io/pdf-studio/`.

## Auf Handy und Tablet installieren

1. Die Adresse in **Chrome** öffnen.
2. Menü **⋮** → **Zum Startbildschirm hinzufügen** → **Installieren**.
3. Fertig: PDF Studio erscheint als App-Symbol und funktioniert danach auch **offline**.

PDFs öffnen: in der App über **PDF öffnen**, oder in „Eigene Dateien“, Gmail, WhatsApp usw.
eine PDF **teilen → PDF Studio**.

## Funktionen

| | |
|---|---|
| Ansehen | Wischen, Zwei-Finger-Zoom, Seitenzähler, Suche |
| Ausfüllen | Formularfelder antippen (Text, Kästchen, Optionen, Listen) |
| Papierformulare | **Text**, **Haken** und **Kreuz** frei platzieren |
| Unterschreiben | Mit Finger oder S Pen, bis zu 3 Unterschriften werden gemerkt |
| Kommentieren | Text lange drücken → Markieren / Unterstreichen / Durchstreichen / Kopieren; Stift, Marker, Rechteck, Ellipse, Pfeil, Linie, Bild |
| Abdecken / Schwärzen | Weiß überdecken; Schwärzen entfernt den Inhalt beim Speichern endgültig |
| Seiten | Drehen, löschen, umsortieren, leere Seite, weitere PDF anhängen |
| Bearbeiten | Elemente antippen → verschieben, Größe (blauer Punkt), Farbe, Duplizieren, Kopieren, Löschen; Rückgängig/Wiederholen |
| Speichern | **Speichern** → Ordner „Downloads“ · **Teilen** → Drive, E-Mail, WhatsApp, Drucken |
| Sicherheit | Arbeitsstand wird automatisch gemerkt („Weiterarbeiten“), auch wenn Android die App schließt |

## Ehrliche Grenzen

- **Vorhandenen Text ändern** geht nicht direkt. Ersatz: Stelle mit **Abdecken** weiß überdecken und mit **Text** neu schreiben.
- Kommentare werden beim Speichern **fest in die Seite eingebrannt** – in der gespeicherten Datei sind sie
  danach nicht mehr verschiebbar (während der Arbeit schon).
- Eine geschwärzte Seite wird als Bild gespeichert: Ihr Text ist danach nicht mehr auswählbar oder durchsuchbar.
- Passwortgeschützte PDFs lassen sich öffnen; gespeichert werden sie als Bilder ohne Passwort.
- Neu eingefügter Text kann nur westeuropäische Zeichen (inkl. ÄÖÜß €).
- Chinesische/japanische/koreanische PDFs ohne eingebettete Schriften: Die dafür nötigen Zeichentabellen
  (`vendor/pdfjs/cmaps`, 169 Dateien) sind nicht enthalten, um den Upload einfach zu halten.

## Updates

Neue Dateien einfach erneut hochladen (gleiche Namen überschreiben). Die App lädt das Update beim
nächsten oder übernächsten Start.

Technik: pdf.js (Mozilla, Apache-2.0) · pdf-lib (MIT) · reines HTML/JavaScript.
