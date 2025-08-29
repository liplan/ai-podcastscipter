# Testskript für automatische Transkription

Ich habe einen kleinen Test mit OpenAI Whisper durchgeführt, um die automatische Transkription und Sprechererkennung zu evaluieren. Die Transkription funktioniert, und auch die Sprecherzuordnung liefert eine brauchbare Grundlage.

Kleinere Fehler, wie etwa die fälschliche Zuordnung von Namen (z. B. wird vereinzelt „Kevin“ erkannt statt Gavin), sind noch vorhanden – lassen sich aber voraussichtlich durch Feinjustierung der Modelle beheben.

Die Methode eignet sich perspektivisch auch zur automatisierten Verarbeitung ganzer Podcast-Serien im Batch-Verfahren

## Installation

1. [Node.js](https://nodejs.org/) installieren (empfohlen wird Version 18 oder neuer).
2. Repository klonen und Abhängigkeiten einrichten:
   ```bash
   git clone <repo-url>
   cd ai-podcastscipter
   npm install
   ```
3. Eine Datei `.env` im Projektordner anlegen und den OpenAI‑Schlüssel hinterlegen:
   ```
   OPENAI_API_KEY=dein_api_key
   ```
4. Anschließend lässt sich das Skript wie unten beschrieben starten.

## Nutzung

### Aufruf mit Parametern

```bash
node index.mjs <feed> <count> [--resume]
```

* `<feed>` kann eine RSS-URL sein oder die Nummer eines bereits gespeicherten Eintrags aus `feeds.json`.
* `<count>` gibt an, wie viele der neuesten Episoden verarbeitet werden sollen (Standard: 1).
* `--resume` überspringt bereits verarbeitete Episoden gemäß `processed.json`.

### Optionen

Zusätzliche Schalter steuern das Verhalten nach der Transkription:

* `--keep-audio` – behält die heruntergeladene MP3-Datei (kein Löschdialog).
* `--delete-temp` – löscht Zwischenformate wie SRT und JSON nach der Transkription.

Ohne `--keep-audio` fragt das Skript nach erfolgreicher Verarbeitung, ob die Audiodatei entfernt werden soll.

Vor dem Start der Batch-Verarbeitung wird außerdem der geschätzte Speicherbedarf ermittelt. Ist nicht genug Platz verfügbar, weist das Skript darauf hin.

### Interaktiver Modus

Ohne Parameter startet das Skript interaktiv. Es zeigt alle in `feeds.json` hinterlegten Feeds an und fragt nach der gewünschten Quelle. Anschließend werden die letzten bis zu 15 Episoden des gewählten Feeds angezeigt, aus denen einzelne Folgen zur Transkription ausgewählt werden können. Wird keine Episode gewählt, fragt das Skript wie bisher nach der Anzahl der ab heute zu verarbeitenden Folgen.

### Ablage der Ergebnisse

Alle erzeugten Dateien landen unter `podcasts/<Podcastname>/`. Für jeden Feed wird also ein eigener Ordner mit dem Titel des Podcasts angelegt. Der Name wird komplett in Kleinbuchstaben umgewandelt, Sonderzeichen werden durch Unterstriche ersetzt und nach 32 Zeichen abgeschnitten. Innerhalb dieses Feed-Ordners legt das Skript für jede Episode einen Unterordner an. Dessen Name beginnt mit der vierstelligen Episodennummer (mit führenden Nullen) und enthält anschließend den bereinigten Episodentitel. Auch hier gilt eine maximale Länge von 32 Zeichen. Alle erzeugten Dateien verwenden denselben Präfix, sodass Audiodatei, Transkript und Zusammenfassung eindeutig einer Episode zugeordnet sind. Zusätzlich wird eine `metadata.json` mit sämtlichen Feed-Daten der Episode gespeichert.

Nach der Transkription wird die Kurz­zusammenfassung außerdem automatisch als MP3 (`<basename>.summary.mp3`) mit einer Standardstimme erzeugt.

`feeds.json` wird im Projektordner gespeichert und speichert alle jemals eingegebenen Feed-URLs samt Titel. Beim nächsten Start können vorhandene Feeds einfach über ihre Nummer ausgewählt werden.


### Direktes Transkribieren von MP3-Dateien

Das Skript `podcastScripter.mjs` kann auch unabhängig vom Feed-Downloader verwendet werden. Es akzeptiert eine oder mehrere MP3-Dateien als Argumente:

```bash
node podcastScripter.mjs <audio1.mp3> [audio2.mp3 …] [--resume]
```

Vor dem Start wird aus der Gesamtdauer der Dateien eine ungefähre Kostenabschätzung berechnet (Kosten pro Minute lassen sich über die Umgebungsvariable `PRICE_PER_MINUTE` anpassen). Danach beginnt die Transkription automatisch. Mit `--resume` kann ein abgebrochener Batch an derselben Stelle fortgesetzt werden.

Der Fortschritt jeder Transkription wird in `processed.json` gesichert. Mit der Option `--resume` lässt sich eine Sitzung später fortsetzen, ohne bereits verarbeitete Episoden erneut zu bearbeiten.


### Korrektur erkannter Namen (`name-fixes.json`)

Optional kann im Projektverzeichnis eine Datei `name-fixes.json` abgelegt werden.
Sie enthält Zuordnungen von von GPT ausgegebenen Namen zu den korrekten Varianten.
Das erwartete Format ist ein einfaches JSON-Objekt:

```json
{
  "GPTName": "KorrigierterName"
}
```

Beim Ausführen überprüft das Skript, ob diese Datei existiert und ersetzt
gefundene Namen entsprechend. Fehlt die Datei, läuft der Prozess ohne
zusätzliche Korrekturen weiter.

### Netzwerkprobleme

Schlägt das Laden eines RSS-Feeds oder das Herunterladen einer Audiodatei wegen eines Netzwerkfehlers fehl, meldet das Skript nun den exakten Grund (z. B. DNS-Lookup fehlgeschlagen, Verbindung abgelehnt oder Zeitüberschreitung). Falls kein Internetzugang möglich ist, kann als alternative Lösung auch der Pfad zu einer lokal gespeicherten RSS-Datei angegeben werden. Zusätzliche Details zu Verbindungsfehlern werden in der Datei `network-errors.log` im Projektordner protokolliert.

