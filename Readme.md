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
node index.mjs <feed> <count>
```

* `<feed>` kann eine RSS-URL sein oder die Nummer eines bereits gespeicherten Eintrags aus `feeds.json`.
* `<count>` gibt an, wie viele der neuesten Episoden verarbeitet werden sollen (Standard: 1).

### Interaktiver Modus

Ohne Parameter startet das Skript interaktiv. Es zeigt alle in `feeds.json` hinterlegten Feeds an und fragt nach der gewünschten Quelle sowie der Anzahl der Episoden.

### Ablage der Ergebnisse

Alle erzeugten Dateien landen unter `podcasts/<Podcastname>/`. Für jeden Feed wird also ein eigener Ordner mit dem Titel des Podcasts angelegt. Der Name wird komplett in Kleinbuchstaben umgewandelt, Sonderzeichen werden durch Unterstriche ersetzt und nach 32 Zeichen abgeschnitten. Innerhalb dieses Feed-Ordners legt das Skript für jede Episode einen Unterordner an. Dessen Name beginnt mit der vierstelligen Episodennummer (mit führenden Nullen) und enthält anschließend den bereinigten Episodentitel. Auch hier gilt eine maximale Länge von 32 Zeichen. Alle erzeugten Dateien verwenden denselben Präfix, sodass Audiodatei, Transkript und Zusammenfassung eindeutig einer Episode zugeordnet sind. Zusätzlich wird eine `metadata.json` mit sämtlichen Feed-Daten der Episode gespeichert.

`feeds.json` wird im Projektordner gespeichert und speichert alle jemals eingegebenen Feed-URLs samt Titel. Beim nächsten Start können vorhandene Feeds einfach über ihre Nummer ausgewählt werden.

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

