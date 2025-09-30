export function assignSpeakersWithoutDiarization(srtJson, knownNames = []) {
  const entries = Array.isArray(srtJson) ? srtJson : [];
  const speakerEntries = new Map();
  if (entries.length === 0) {
    return speakerEntries;
  }

  const normalizedNames = Array.isArray(knownNames)
    ? knownNames.map((name, index) => ({
        id: index + 1,
        search: String(name || '').toLowerCase().trim(),
      })).filter(item => item.search.length > 0)
    : [];

  const normalizeText = (text) => String(text || '').toLowerCase();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const textLower = normalizeText(entry.text);
    let bestMatch = null;

    for (const item of normalizedNames) {
      const idx = textLower.indexOf(item.search);
      if (idx !== -1) {
        if (!bestMatch || idx < bestMatch.index || (idx === bestMatch.index && item.id < bestMatch.item.id)) {
          bestMatch = { item, index: idx };
        }
      }
    }

    if (bestMatch) {
      entry.speakerId = bestMatch.item.id;
    }
  }

  let lastSpeakerId = null;
  for (const entry of entries) {
    if (entry.speakerId) {
      lastSpeakerId = entry.speakerId;
    } else if (lastSpeakerId !== null) {
      entry.speakerId = lastSpeakerId;
    }
  }

  const firstAssignedIndex = entries.findIndex((entry) => entry.speakerId);
  if (firstAssignedIndex > 0) {
    const firstId = entries[firstAssignedIndex].speakerId;
    for (let i = 0; i < firstAssignedIndex; i++) {
      if (!entries[i].speakerId) {
        entries[i].speakerId = firstId;
      }
    }
  }

  const unresolved = entries.some((entry) => !entry.speakerId);
  if (unresolved) {
    const rotationIds = normalizedNames.length
      ? normalizedNames.map((item) => item.id)
      : [1, 2];

    let pointer = 0;
    for (const entry of entries) {
      if (!entry.speakerId) {
        const id = rotationIds[pointer % rotationIds.length];
        entry.speakerId = id;
        pointer++;
      }
    }
  }

  for (const entry of entries) {
    const id = entry.speakerId || 1;
    const list = speakerEntries.get(id) || [];
    list.push(entry);
    speakerEntries.set(id, list);
  }

  return speakerEntries;
}
