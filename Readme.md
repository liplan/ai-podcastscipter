# Testskript für automatische Transkription

Ich habe einen kleinen Test mit OpenAI Whisper durchgeführt, um die automatische Transkription und Sprechererkennung zu evaluieren. Die Transkription funktioniert, und auch die Sprecherzuordnung liefert eine brauchbare Grundlage.

Kleinere Fehler, wie etwa die fälschliche Zuordnung von Namen (z. B. wird vereinzelt „Kevin“ erkannt statt Gavin), sind noch vorhanden – lassen sich aber voraussichtlich durch Feinjustierung der Modelle beheben.

Die Methode eignet sich perspektivisch auch zur automatisierten Verarbeitung ganzer Podcast-Serien im Batch-Verfahren


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

Alle erzeugten Dateien landen unter `podcasts/<Podcastname>/`. Dort legt das Skript für jede Episode einen Unterordner mit dem Transkript, einer Zusammenfassung sowie der heruntergeladenen Audiodatei an.

`feeds.json` wird im Projektordner gespeichert und speichert alle jemals eingegebenen Feed-URLs samt Titel. Beim nächsten Start können vorhandene Feeds einfach über ihre Nummer ausgewählt werden.

