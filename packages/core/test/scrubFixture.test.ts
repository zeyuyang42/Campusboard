import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scrubFixture } from "./helpers/scrubFixture";

const dir = path.join(__dirname, "fixtures");
const pages = readdirSync(dir).filter((f) => f.endsWith(".html"));

describe("scrubFixture", () => {
  it("removes supporters, fan comments and the visitor's country", () => {
    const html = [
      '<p>before</p><div class="collected-by tralbum collectors"><div class="writing"><a class="pic" href="https://bandcamp.com/somefan">x</a></div></div><p>after</p>',
      '<div id="collectors-data" data-blob="{&quot;thumbs&quot;:[{&quot;username&quot;:&quot;somefan&quot;}]}"></div>',
      '<script type="application/ld+json">{"name":"A","sponsor":[{"@type":"Person","url":"https://bandcamp.com/somefan","name":"a \\"]\\" b"}],"comment":[{"@type":"Comment","author":{"@type":"Person","url":"https://bandcamp.com/otherfan"}}],"byArtist":{"name":"B"}}</script>',
      "ip_country_code&quot;:&quot;DE&quot;",
    ].join("\n");
    const out = scrubFixture(html);
    expect(out).not.toMatch(/somefan|otherfan|DE&quot;/);
    expect(out).toContain('<p>before</p><div class="collected-by tralbum collectors"></div><p>after</p>');
    expect(out).toContain("ip_country_code&quot;:&quot;XX&quot;");
    const ld = out.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1];
    expect(JSON.parse(ld)).toEqual({ name: "A", byArtist: { name: "B" } });
  });

  it.each(pages)("leaves the committed %s unchanged (already scrubbed)", (name) => {
    const html = readFileSync(path.join(dir, name), "utf8");
    expect(scrubFixture(html) === html).toBe(true);
  });
});
