// Rekordbox XML Location helpers. Paths in the XML are URL-encoded over
// an already HTML-entity-escaped string, so decoding has to unwind both.

const ENTITY_MAP = {
  amp: '&',
  apos: "'",
  quot: '"',
  lt: '<',
  gt: '>',
  nbsp: ' ',
};

export function decodeHtmlEntities(s) {
  if (!s) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = ENTITY_MAP[entity.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

const LOC_PREFIX = 'file://localhost';

export function locToPath(loc) {
  if (!loc) return null;
  const raw = loc.startsWith(LOC_PREFIX) ? loc.slice(LOC_PREFIX.length) : loc;
  return decodeHtmlEntities(decodeURIComponent(raw));
}

export function pathToLocation(p) {
  return LOC_PREFIX + encodeURI(p);
}
