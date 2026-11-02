// What a neighbour search asks for, and what it shows back (issue #736).
//
// A page title is the weakest topic signal a page has: on the measured case the
// title query ranked two unrelated pages 4 and 6, while one sentence of topic
// put the four on-topic pages at ranks 1-4. So the query is the title plus the
// finding sentence, and a snippet is kept so whoever judges a candidate can
// read what the page says instead of guessing from a shared word.
//
// Everything here is pure text work: no request, no process.

export const QUERY_MAX = 500;
export const SNIPPET_MAX = 240;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Storage XHTML or search text to one line of plain words. Tags go first, so an
// entity decoded to "<" can never be read as a tag. An entity this table does
// not know becomes a space rather than leaking "&hellip;" into a query.
export function plainText(value: string): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (_match, name: string) => {
      const lower = name.toLowerCase();
      if (lower.startsWith("#")) {
        const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
        const printable = code > 31 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
        return printable ? String.fromCodePoint(code) : " ";
      }
      return NAMED[lower] ?? " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

// Cut at a word boundary, never inside a word. A single word longer than the
// cap is the one case that is cut hard: an empty result would be worse.
export function capWords(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return (at > 0 ? cut.slice(0, at) : value.slice(0, max)).trimEnd();
}

// `title + ". " + topic`, whitespace collapsed, at most QUERY_MAX characters.
// Without a topic the query is the title alone; the caller decides whether that
// is allowed (targeted stitch refuses it, because a title-only query is #736).
export function topicQuery(title: string, topic = ""): string {
  const head = plainText(title);
  const tail = plainText(topic);
  return capWords(tail ? `${head}. ${tail}` : head, QUERY_MAX);
}

// One line of page text for a candidate row: no tab, no newline, at most
// SNIPPET_MAX characters. It is page text and stays data for whoever reads it.
export function snippetLine(value: string): string {
  return capWords(plainText(value), SNIPPET_MAX);
}

// The topic of a page that has no finding sentence, such as an orphan in the
// sweep: the opening of its own body, the closest thing it has to one.
export function bodyTopic(storage: string): string {
  return capWords(plainText(storage), QUERY_MAX);
}
