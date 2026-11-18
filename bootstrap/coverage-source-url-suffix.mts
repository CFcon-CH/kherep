// Node's type stripping (strip mode) keeps every offset and appends "\n\n//# sourceURL=<url>" to the
// module text, so the top-level range of one source ends at a different offset at every path (#969).
// Without trimming, the merge treats those ranges as different functions and drops hits.
type Range = { startOffset: number; endOffset: number; count: number };
type V8Function = { ranges: Range[] };

/** Length in UTF-16 code units, the unit of V8 offsets and of JavaScript string length. */
export const sourceUrlSuffixLength = (url: string): number => `\n\n//# sourceURL=${url}`.length;

/**
 * Trims ranges that reach into the sourceURL suffix back to the source length. Only an excess that
 * equals the suffix of the script's own URL is trimmed; any other excess returns null so the caller
 * keeps the script untouched and counts it. A range starting inside the suffix is dropped, and a
 * function whose own range starts there is dropped with its blocks.
 */
export function trimSourceUrlSuffix<F extends V8Function>(url: string, functions: F[], sourceLength: number): F[] | null {
  const end = Math.max(...functions.flatMap(fn => fn.ranges.map(range => range.endOffset)));
  if (end <= sourceLength) return functions;
  if (end - sourceLength !== sourceUrlSuffixLength(url)) return null;
  const inSource = (range: Range) => range.startOffset < sourceLength;
  return functions.filter(fn => inSource(fn.ranges[0])).map(fn => ({
    ...fn,
    ranges: fn.ranges.filter(inSource).map(range => (range.endOffset > sourceLength ? { ...range, endOffset: sourceLength } : range)),
  }));
}
