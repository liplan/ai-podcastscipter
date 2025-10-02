const MERGE_GAP_SECONDS = 0.35;

function parseSpeakerIdentifier(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const text = String(value).trim();
  if (!text) return null;

  const directNumeric = text.match(/^[+-]?\d+$/);
  if (directNumeric) {
    const parsed = Number.parseInt(text, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const labeledMatch = text.match(/speaker[_\s-]*(\d+)/i);
  if (labeledMatch) {
    const parsed = Number.parseInt(labeledMatch[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const alphaMatch = text.match(/^[A-Za-z]+$/);
  if (alphaMatch) {
    let valueAccumulator = 0;
    for (const ch of text.toUpperCase()) {
      const code = ch.charCodeAt(0);
      if (code < 65 || code > 90) {
        return null;
      }
      valueAccumulator = valueAccumulator * 26 + (code - 64);
    }
    return valueAccumulator;
  }

  const fallback = Number(text);
  return Number.isFinite(fallback) ? fallback : null;
}

function toZeroBasedSpeaker(value) {
  if (!Number.isFinite(value)) return 0;
  if (value > 0) {
    return Math.max(0, Math.floor(value - 1));
  }
  return Math.max(0, Math.floor(value));
}

function parseSrtTimestamp(ts) {
  if (ts === null || ts === undefined) return NaN;

  if (typeof ts === 'number') {
    return Number.isFinite(ts) ? ts : NaN;
  }

  if (typeof ts !== 'string') {
    return NaN;
  }

  const trimmed = ts.trim();
  if (!trimmed) return NaN;

  const colonMatch = trimmed.match(/^(-)?(\d{1,2}):(\d{2}):(\d{2})([.,](\d{1,3}))?$/);
  if (colonMatch) {
    const sign = colonMatch[1] === '-' ? -1 : 1;
    const h = Number(colonMatch[2]);
    const m = Number(colonMatch[3]);
    const s = Number(colonMatch[4]);
    if ([h, m, s].some(Number.isNaN)) return NaN;
    const fracRaw = colonMatch[6] || '';
    const millis = fracRaw ? Number((fracRaw + '000').slice(0, 3)) : 0;
    if (Number.isNaN(millis)) return NaN;
    const base = (h * 3600) + (m * 60) + s;
    return sign * (base + millis / 1000);
  }

  const numeric = Number(trimmed.replace(',', '.'));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function pickFirstFinite(values = []) {
  for (const value of values) {
    const parsed = parseSrtTimestamp(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function extractEntryTiming(entry = {}) {
  const start = pickFirstFinite([
    entry.startTime,
    entry.start,
    entry.begin,
    entry.timecodeStart,
  ]);

  let end = pickFirstFinite([
    entry.endTime,
    entry.end,
    entry.finish,
    entry.timecodeEnd,
  ]);

  const duration = parseSrtTimestamp(entry.duration);
  if (!Number.isFinite(end) && Number.isFinite(start) && Number.isFinite(duration)) {
    end = start + duration;
  }
  if (!Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(duration)) {
    const computedStart = end - duration;
    if (Number.isFinite(computedStart)) {
      return {
        start: Math.min(computedStart, end),
        end: Math.max(computedStart, end),
        mid: (computedStart + end) / 2,
      };
    }
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  const entryStart = Math.min(start, end);
  const entryEnd = Math.max(start, end);
  return {
    start: entryStart,
    end: entryEnd,
    mid: (entryStart + entryEnd) / 2,
  };
}

function computeSpeakerScores(timing, segments = [], speakerIds = [], margin = MERGE_GAP_SECONDS) {
  if (!timing || !segments.length || !speakerIds.length) {
    return new Map();
  }

  const scores = new Map();
  for (const speaker of speakerIds) {
    scores.set(speaker, {
      overlap: 0,
      distance: Infinity,
      score: -Infinity,
    });
  }

  const marginClamped = Math.max(0, Number(margin) || 0);

  for (const seg of segments) {
    if (!scores.has(seg.speaker)) continue;
    const data = scores.get(seg.speaker);
    const segStart = Number(seg.start);
    const segEnd = Number(seg.end);
    if (!Number.isFinite(segStart) || !Number.isFinite(segEnd)) continue;

    const start = segStart - marginClamped;
    const end = segEnd + marginClamped;
    const overlap = Math.min(timing.end, end) - Math.max(timing.start, start);
    if (overlap > 0) {
      data.overlap += overlap;
    }

    const distance = timing.mid < start
      ? start - timing.mid
      : timing.mid > end
        ? timing.mid - end
        : 0;

    if (distance < data.distance) {
      data.distance = distance;
    }
  }

  for (const speaker of speakerIds) {
    const data = scores.get(speaker);
    if (!data) continue;
    if (data.overlap > 0) {
      data.score = data.overlap - (data.distance === Infinity ? 0 : data.distance * 0.01);
    } else if (Number.isFinite(data.distance)) {
      data.score = -data.distance;
    }
  }

  return scores;
}

function evaluateEntries(entries = [], entryTimings = [], segments = [], margin = MERGE_GAP_SECONDS) {
  const speakerIds = [...new Set(segments.map(seg => seg.speaker))].sort((a, b) => a - b);
  const scoresByEntry = entries.map(() => null);
  if (!speakerIds.length) {
    return { speakerIds, scoresByEntry };
  }

  for (let i = 0; i < entries.length; i++) {
    const timing = entryTimings[i];
    if (!timing) continue;
    scoresByEntry[i] = computeSpeakerScores(timing, segments, speakerIds, margin);
  }

  return { speakerIds, scoresByEntry };
}

function applyScoresToEntries(entries = [], scoresByEntry = [], speakerIds = []) {
  if (!speakerIds.length) return false;
  let changed = false;

  for (let i = 0; i < entries.length; i++) {
    const scores = scoresByEntry[i];
    if (!scores || !scores.size) continue;
    let bestSpeaker = null;
    let bestScore = -Infinity;

    for (const speaker of speakerIds) {
      const data = scores.get(speaker);
      if (!data) continue;
      const score = Number.isFinite(data.score) ? data.score : -Infinity;
      if (score > bestScore + 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && speaker < (bestSpeaker ?? Infinity))) {
        bestScore = score;
        bestSpeaker = speaker;
      }
    }

    if (bestSpeaker != null && bestScore > -Infinity) {
      const candidate = bestSpeaker + 1;
      if (entries[i].speakerId !== candidate) {
        entries[i].speakerId = candidate;
        changed = true;
      }
    }
  }

  return changed;
}

function ensureSpeakerCoverage(entries = [], entryTimings = [], scoresByEntry = [], speakerIds = [], desiredCount = 1) {
  if (desiredCount <= 1 || !speakerIds.length) {
    return new Set(entries.map(e => e.speakerId)).size;
  }

  let assignedSet = new Set(entries.map(e => e.speakerId));
  if (assignedSet.size >= desiredCount) return assignedSet.size;

  const sortedEntries = entryTimings
    .map((timing, idx) => ({ idx, start: timing?.start, mid: timing?.mid }))
    .filter(item => Number.isFinite(item.start))
    .sort((a, b) => (a.start - b.start) || (a.idx - b.idx));

  const missingSpeakers = speakerIds
    .map(sp => sp + 1)
    .filter(id => !assignedSet.has(id));

  for (const speakerId of missingSpeakers) {
    if (assignedSet.size >= desiredCount) break;
    const speaker = speakerId - 1;
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const { idx } of sortedEntries) {
      const data = scoresByEntry[idx]?.get(speaker);
      if (!data) continue;
      const score = Number.isFinite(data.score) ? data.score : -Infinity;
      if (score > bestScore + 1e-6) {
        bestScore = score;
        bestIdx = idx;
      }
    }

    if (bestIdx !== -1 && bestScore > -Infinity) {
      entries[bestIdx].speakerId = speakerId;
      assignedSet = new Set(entries.map(e => e.speakerId));
    }
  }

  if (assignedSet.size >= desiredCount) return assignedSet.size;

  if (speakerIds.length > 1 && sortedEntries.length) {
    let pointer = 0;
    for (const { idx } of sortedEntries) {
      const speakerId = speakerIds[pointer % speakerIds.length] + 1;
      if (entries[idx].speakerId !== speakerId) {
        entries[idx].speakerId = speakerId;
      }
      assignedSet = new Set(entries.map(e => e.speakerId));
      pointer++;
      if (assignedSet.size >= desiredCount) break;
    }
  }

  return assignedSet.size;
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
  const cloneOriginal = () => segments.map(seg => ({ ...seg }));
  if (expected === 0) return cloneOriginal();

  const durationBySpeaker = new Map();
  let totalDuration = 0;
  for (const seg of segments) {
    const duration = seg.end - seg.start;
    totalDuration += duration;
    const current = durationBySpeaker.get(seg.speaker) || 0;
    durationBySpeaker.set(seg.speaker, current + duration);
  }

  if (durationBySpeaker.size <= expected) {
    return cloneOriginal();
  }

  const keepSpeakers = [...durationBySpeaker.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, expected)
    .map(([speaker]) => speaker);

  const keepSet = new Set(keepSpeakers);
  const keepSegments = segments.filter(seg => keepSet.has(seg.speaker));
  if (!keepSegments.length) {
    return cloneOriginal();
  }

  const hasUncoveredIntervals = segments.some(seg => {
    if (keepSet.has(seg.speaker)) return false;
    const duration = seg.end - seg.start;
    let covered = 0;
    for (const target of keepSegments) {
      const overlap = Math.min(seg.end, target.end) - Math.max(seg.start, target.start);
      if (overlap > 0) {
        covered += overlap;
        if (covered >= duration - 1e-6) {
          return false;
        }
      }
    }
    return covered < duration - 1e-6;
  });

  if (hasUncoveredIntervals) {
    return cloneOriginal();
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

  const reducedCoverageBySpeaker = new Map();
  for (const seg of reassigned) {
    const duration = seg.end - seg.start;
    reducedCoverageBySpeaker.set(seg.speaker, (reducedCoverageBySpeaker.get(seg.speaker) || 0) + duration);
  }

  const significantThreshold = totalDuration * 0.2;
  const lostSignificantSpeaker = significantThreshold > 0 && [...durationBySpeaker.entries()].some(([speaker, originalDuration]) => {
    if (originalDuration < significantThreshold) return false;
    const reducedDuration = reducedCoverageBySpeaker.get(speaker) || 0;
    return reducedDuration <= 1e-6;
  });

  if (lostSignificantSpeaker) {
    return cloneOriginal();
  }

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
      const source = seg.speaker ?? seg.speaker_id ?? seg.speakerId ?? 0;
      const parsed = parseSpeakerIdentifier(source);
      const speaker = toZeroBasedSpeaker(parsed ?? Number(source));
      return { start, end, speaker };
    })
    .filter(seg => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
    .sort((a, b) => a.start - b.start || a.speaker - b.speaker);

  if (!normalized.length) {
    return new Map();
  }

  const entryTimings = entries.map(extractEntryTiming);
  if (!entryTimings.some(Boolean)) {
    return new Map();
  }

  const merged = mergeSegments(normalized);
  const limited = limitSegmentsToExpected(merged, expectedSpeakers);
  const segmentsForAssignment = mergeSegments(limited);
  const assignmentSegments = segmentsForAssignment.length ? segmentsForAssignment : merged;

  if (assignmentSegments.length) {
    const initialEval = evaluateEntries(entries, entryTimings, assignmentSegments, MERGE_GAP_SECONDS);
    applyScoresToEntries(entries, initialEval.scoresByEntry, initialEval.speakerIds);
  }

  const prioritizedEval = evaluateEntries(entries, entryTimings, assignmentSegments, MERGE_GAP_SECONDS);
  const diarSpeakerCount = prioritizedEval.speakerIds.length;

  let desiredSpeakers = diarSpeakerCount;
  if (expectedSpeakers > 0) {
    desiredSpeakers = diarSpeakerCount
      ? Math.min(expectedSpeakers, diarSpeakerCount)
      : expectedSpeakers;
  }
  if (diarSpeakerCount > 1) {
    desiredSpeakers = Math.max(2, desiredSpeakers || 0);
  }
  if (!desiredSpeakers) {
    desiredSpeakers = diarSpeakerCount || 1;
  }

  const durationBySpeaker = new Map();
  for (const seg of assignmentSegments) {
    const span = Number(seg.end) - Number(seg.start);
    if (span > 0 && Number.isFinite(span)) {
      durationBySpeaker.set(seg.speaker, (durationBySpeaker.get(seg.speaker) || 0) + span);
    }
  }

  const durationSortedSpeakers = [...durationBySpeaker.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([speaker]) => speaker);

  let assignedSet = new Set(entries.map(e => e.speakerId).filter(Boolean));

  if (assignedSet.size < desiredSpeakers && prioritizedEval.speakerIds.length) {
    applyScoresToEntries(entries, prioritizedEval.scoresByEntry, prioritizedEval.speakerIds);
    assignedSet = new Set(entries.map(e => e.speakerId).filter(Boolean));
  }

  if (assignedSet.size < desiredSpeakers && prioritizedEval.speakerIds.length) {
    const expandedSegments = assignmentSegments.map(seg => ({
      start: Math.max(0, seg.start - MERGE_GAP_SECONDS),
      end: seg.end + MERGE_GAP_SECONDS,
      speaker: seg.speaker,
    }));

    const expandedEval = evaluateEntries(entries, entryTimings, expandedSegments, MERGE_GAP_SECONDS);
    if (expandedEval.speakerIds.length) {
      applyScoresToEntries(entries, expandedEval.scoresByEntry, expandedEval.speakerIds);
      assignedSet = new Set(entries.map(e => e.speakerId).filter(Boolean));
      if (assignedSet.size < desiredSpeakers) {
        ensureSpeakerCoverage(entries, entryTimings, expandedEval.scoresByEntry, expandedEval.speakerIds, desiredSpeakers);
        assignedSet = new Set(entries.map(e => e.speakerId).filter(Boolean));
      }
    }
  }

  const allowedSpeakers = desiredSpeakers >= diarSpeakerCount
    ? prioritizedEval.speakerIds
    : durationSortedSpeakers.slice(0, desiredSpeakers);

  if (allowedSpeakers.length && assignedSet.size > allowedSpeakers.length) {
    const allowedSet = new Set(allowedSpeakers);
    for (let i = 0; i < entries.length; i++) {
      const current = entries[i].speakerId ? entries[i].speakerId - 1 : null;
      if (current != null && allowedSet.has(current)) continue;

      const scores = prioritizedEval.scoresByEntry[i];
      let bestSpeaker = allowedSpeakers[0];
      let bestScore = -Infinity;
      for (const speaker of allowedSpeakers) {
        const data = scores?.get(speaker);
        const score = data && Number.isFinite(data.score) ? data.score : -Infinity;
        if (score > bestScore + 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && speaker < bestSpeaker)) {
          bestScore = score;
          bestSpeaker = speaker;
        }
      }
      entries[i].speakerId = (bestSpeaker ?? allowedSpeakers[0]) + 1;
    }
    assignedSet = new Set(entries.map(e => e.speakerId).filter(Boolean));
  }

  const remap = new Map();
  let nextId = 1;
  const finalMap = new Map();

  for (const entry of entries) {
    if (!entry.speakerId) {
      entry.speakerId = 1;
    }
    if (!remap.has(entry.speakerId)) {
      remap.set(entry.speakerId, nextId++);
    }
    const remapped = remap.get(entry.speakerId);
    entry.speakerId = remapped;
    const list = finalMap.get(remapped) || [];
    list.push(entry);
    finalMap.set(remapped, list);
  }

  return finalMap;
}
