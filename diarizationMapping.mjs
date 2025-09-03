export function applySpeakerMapping(entries = [], nameMap = new Map(), knownNames = [], allowNames = true) {
  return entries.map(e => {
    const spKey = `Speaker ${e.speakerId}`;
    const name = nameMap.get(spKey) || spKey;
    const speaker = allowNames ? name : spKey;
    const confidence = knownNames.includes(name) ? 0.9 : 0.5;
    return { ...e, speaker, confidence };
  });
}
