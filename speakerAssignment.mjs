const MERGE_GAP_SECONDS = 0.35;

function parseSrtTimestamp(ts) {
  if (!ts) return NaN;
  const [hms, ms] = String(ts).split(',');
  if (!hms) return NaN;
  const [h, m, s] = hms.split(':').map(Number);
  const millis = ms !== undefined ? Number(ms) : 0;
  if ([h, m, s].some(Number.isNaN)) return NaN;
  const base = (h * 3600) + (m * 60) + s;
  return base + (Number.isNaN(millis) ? 0 : millis / 1000);
}

function mergeSegments(segments = []) {
  const merged = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === seg.speaker && seg.start <= last.end + MERGE_GAP_SECONDS) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

function limitSegmentsToExpected(segments = [], expectedSpeakers = 0) {
  const expected = Number.isFinite(expectedSpeakers) ? Math.max(0, Math.floor(expectedSpeakers)) : 0;
  if (expected === 0) return segments.map(seg => ({ ...seg }));

  const durationBySpeaker = new Map();
  for (const seg of segments) {
    const current = durationBySpeaker.get(seg.speaker) || 0;
    durationBySpeaker.set(seg.speaker, current + (seg.end - seg.start));
  }

  if (durationBySpeaker.size <= expected) {
    return segments.map(seg => ({ ...seg }));
  }

  const keepSpeakers = [...durationBySpeaker.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, expected)
    .map(([speaker]) => speaker);

  const keepSet = new Set(keepSpeakers);
  const keepSegments = segments.filter(seg => keepSet.has(seg.speaker));
  if (!keepSegments.length) {
    return segments.map(seg => ({ ...seg }));
  }

  const reassigned = segments.map(seg => {
    if (keepSet.has(seg.speaker)) return { ...seg };

    const mid = (seg.start + seg.end) / 2;
    let bestSpeaker = keepSpeakers[0];
    let bestDistance = Infinity;

    for (const target of keepSegments) {
      const distance = mid < target.start
        ? target.start - mid
        : mid > target.end
          ? mid - target.end
          : 0;

      if (distance < bestDistance - 1e-6 || (Math.abs(distance - bestDistance) <= 1e-6 && target.speaker < bestSpeaker)) {
        bestDistance = distance;
        bestSpeaker = target.speaker;
        if (distance === 0) break;
      }
    }

    return { ...seg, speaker: bestSpeaker };
  });

  reassigned.sort((a, b) => a.start - b.start || a.speaker - b.speaker);
  return mergeSegments(reassigned);
}

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

export function assignSpeakersFromDiarization(srtJson = [], diarSegments = [], expectedSpeakers = 0) {
  const entries = Array.isArray(srtJson) ? srtJson : [];
  const segments = Array.isArray(diarSegments) ? diarSegments : [];

  if (!entries.length || !segments.length) {
    return new Map();
  }

  const normalized = segments
    .map(seg => {
      const start = Number(seg.start);
      const end = Number(seg.end);
      const rawSpeaker = Number(seg.speaker ?? seg.speaker_id ?? seg.speakerId ?? 0);
      const speaker = rawSpeaker > 0 ? rawSpeaker - 1 : 0;
      return { start, end, speaker };
    })
    .filter(seg => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
    .sort((a, b) => a.start - b.start || a.speaker - b.speaker);

  if (!normalized.length) {
    return new Map();
  }

  const merged = mergeSegments(normalized);
  const limited = limitSegmentsToExpected(merged, expectedSpeakers);

  const segmentsForAssignment = mergeSegments(limited);

  let pointer = 0;
  for (const entry of entries) {
    const start = parseSrtTimestamp(entry.startTime);
    const end = parseSrtTimestamp(entry.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue;
    }

    const entryStart = Math.min(start, end);
    const entryEnd = Math.max(start, end);
    const mid = (entryStart + entryEnd) / 2;

    while (pointer < segmentsForAssignment.length - 1 && entryEnd > segmentsForAssignment[pointer].end) {
      pointer++;
    }

    let bestSpeaker = null;
    let bestOverlap = 0;
    const searchStart = Math.max(0, pointer - 1);

    for (let i = searchStart; i < segmentsForAssignment.length; i++) {
      const seg = segmentsForAssignment[i];
      if (seg.start - MERGE_GAP_SECONDS > entryEnd) break;

      const overlap = Math.min(entryEnd, seg.end) - Math.max(entryStart, seg.start);
      if (overlap > 0 && (overlap > bestOverlap || (Math.abs(overlap - bestOverlap) <= 1e-6 && seg.speaker < (bestSpeaker ?? Infinity)))) {
        bestOverlap = overlap;
        bestSpeaker = seg.speaker;
        pointer = i;
      }
    }

    let chosenSpeaker = bestSpeaker;
    if (chosenSpeaker == null) {
      let bestDistance = Infinity;
      let fallback = segmentsForAssignment[0]?.speaker ?? 0;
      for (const seg of segmentsForAssignment) {
        const distance = mid < seg.start
          ? seg.start - mid
          : mid > seg.end
            ? mid - seg.end
            : 0;
        if (distance < bestDistance - 1e-6 || (Math.abs(distance - bestDistance) <= 1e-6 && seg.speaker < fallback)) {
          bestDistance = distance;
          fallback = seg.speaker;
          if (distance === 0) break;
        }
      }
      chosenSpeaker = fallback;
    }

    entry.speakerId = chosenSpeaker + 1;
  }

  const remap = new Map();
  let nextId = 1;
  const finalMap = new Map();

  for (const entry of entries) {
    const id = entry.speakerId || 1;
    if (!remap.has(id)) {
      remap.set(id, nextId++);
    }
    entry.speakerId = remap.get(id);
    const list = finalMap.get(entry.speakerId) || [];
    list.push(entry);
    finalMap.set(entry.speakerId, list);
  }

  return finalMap;
}
