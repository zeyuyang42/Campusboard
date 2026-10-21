// Removes what a saved Bandcamp page says about people other than the artist, and where
// it was fetched from, before it becomes a fixture: the "supported by" section, the
// collectors-data blob, the ld+json sponsor and fan comment arrays, and the visitor's
// country. The parser reads none of them. Line endings are left as they came.

/** The end (exclusive) of the bracketed JSON value starting at `open`, skipping strings. */
function jsonEnd(s: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      if (--depth === 0) return i + 1;
    }
  }
  throw new Error("unbalanced JSON in fixture");
}

/** Drops every `"key":[...]` whose text starts with `prefix`, with one neighbouring comma. */
function dropJsonArrays(s: string, prefix: string): string {
  for (let i = s.indexOf(prefix); i >= 0; i = s.indexOf(prefix, i)) {
    let start = i;
    let end = jsonEnd(s, s.indexOf("[", i));
    if (s[end] === ",") end++;
    else if (s[start - 1] === ",") start--;
    s = s.slice(0, start) + s.slice(end);
  }
  return s;
}

/** The end (exclusive) of the <div> element opening at `open`. */
function divEnd(s: string, open: number): number {
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = open;
  let depth = 0;
  for (let m = tag.exec(s); m; m = tag.exec(s)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return tag.lastIndex;
  }
  throw new Error("unbalanced <div> in fixture");
}

const COLLECTORS = '<div class="collected-by tralbum collectors">';

export function scrubFixture(html: string): string {
  let s = html;
  const i = s.indexOf(COLLECTORS);
  if (i >= 0) s = s.slice(0, i) + `${COLLECTORS}</div>` + s.slice(divEnd(s, i));
  s = s.replace(/(<div id="collectors-data" data-blob=")[^"]*"/, (_m, head: string) =>
    `${head}{&quot;thumbs&quot;:[],&quot;reviews&quot;:[],&quot;more_thumbs_available&quot;:false,&quot;more_reviews_available&quot;:false}"`);
  s = dropJsonArrays(s, '"sponsor":[');
  s = dropJsonArrays(s, '"comment":[{"@type":"Comment"');
  return s.replace(/(ip_country_code&quot;:&quot;)[A-Z]{2}(&quot;)/g, "$1XX$2");
}
