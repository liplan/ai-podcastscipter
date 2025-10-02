export function extractSpeakers(item = {}) {
  const directSpeakers = Array.isArray(item.speakers)
    ? item.speakers.map(name => String(name || '').trim()).filter(Boolean)
    : [];

  const profileSpeakers = Array.isArray(item.speakerProfiles)
    ? item.speakerProfiles
        .map(profile => String(profile?.name || '').trim())
        .filter(Boolean)
    : [];

  const textFields = [
    item.itunes?.author,
    item['itunes:author'],
    item.author,
    item['dc:creator']
  ].filter(Boolean);

  if (item.content) {
    const match = item.content.match(/(?:mit|with)\s+([^<\n]+)/i);
    if (match) textFields.push(match[1]);
  }

  const normalized = [
    ...directSpeakers,
    ...profileSpeakers,
    ...textFields.flatMap(f =>
      String(f)
        .split(/,| und | & | and /)
        .map(s => s.trim())
        .filter(Boolean)
    ),
  ];

  return [...new Set(normalized)].filter(Boolean);
}

export function createProfiles(names = [], existingProfiles = []) {
  if (Array.isArray(existingProfiles) && existingProfiles.length) {
    return existingProfiles
      .map(profile => ({
        name: String(profile?.name || '').trim(),
        trained: Boolean(profile?.trained),
      }))
      .filter(profile => profile.name.length > 0);
  }

  return names
    .map(name => String(name || '').trim())
    .filter(Boolean)
    .map(name => ({ name, trained: false }));
}
