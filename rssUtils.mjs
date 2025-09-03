export function extractSpeakers(item = {}) {
  const fields = [
    item.itunes?.author,
    item['itunes:author'],
    item.author,
    item['dc:creator']
  ].filter(Boolean);
  if (item.content) {
    const match = item.content.match(/(?:mit|with)\s+([^<\n]+)/i);
    if (match) fields.push(match[1]);
  }
  return [...new Set(fields.flatMap(f => f.split(/,| und | & | and /).map(s => s.trim())))].filter(Boolean);
}

export function createProfiles(names = []) {
  return names.map(name => ({ name, trained: false }));
}
