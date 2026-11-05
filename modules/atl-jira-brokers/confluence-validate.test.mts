import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli as claude, type Injected } from "./atl-confluence-ccoder.mts";
import { runCli as codex } from "./atl-confluence.mts";

const labels = "type-observation,evidence-assumed,status-author-model";
const body = '<p>Finding: It\'s "short", ‘quoted’ and “exact”.</p>\n<p>Origin: synthetic turn.</p>\n<p>Source: fixture.</p>\n<p>Timestamp: now.</p>';
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const argv = (extra: string[] = []) => ["validate", "--format", "storage", "--body-file", "C:/assigned/body 'quoted'.xml", "--labels", labels, ...extra];

for (const [name, run] of [["Claude", claude], ["Codex", codex]] as const) {
  function local(bytes: Uint8Array) {
    let reads = 0, forbidden = 0;
    const out: string[] = [], errors: string[] = [];
    const injected: Injected = {
      env: new Proxy({}, { get() { forbidden++; throw Error("forbidden account access"); } }),
      async readFile() { forbidden++; throw Error("forbidden account read"); },
      async fetch() { forbidden++; throw Error("forbidden fetch"); },
      async readBodyBytes(file) { assert.equal(file, "C:/assigned/body 'quoted'.xml"); reads++; return bytes; },
      log: line => { out.push(line); }, logError: line => { errors.push(line); },
    };
    return { injected, out, errors, counts: () => ({ reads, forbidden }) };
  }
  test(`${name} validate reads bytes once, reports digest and makes zero account/network calls`, async () => {
    const bytes = Buffer.from(body), h = local(bytes);
    assert.equal(await run(argv(), h.injected), 0, h.errors.join("\n"));
    assert.deepEqual(h.counts(), { reads: 1, forbidden: 0 });
    assert.deepEqual(h.out, ["valid: true", `bytes: ${bytes.length}`, `sha256: ${hash(bytes)}`, "target/authentication: not validated"]);
  });
  test(`${name} validate reads an actual quoted UTF-8 file without authentication`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-760-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "body 'quoted'.xml"); fs.writeFileSync(file, body);
    const h = local(Buffer.from(body)); delete h.injected.readBodyBytes;
    const args = argv(); args[args.indexOf("--body-file") + 1] = file;
    assert.equal(await run(args, h.injected), 0, h.errors.join("\n"));
    assert.equal(h.counts().forbidden, 0);
    assert.ok(h.out.includes(`sha256: ${hash(fs.readFileSync(file))}`));
  });
  test(`${name} validate rejects missing, empty, duplicate and inert metadata without account I/O`, async () => {
    const invalid = ["<p>stub</p>", "<p>Finding: x</p>", "<!--" + body + "-->", "<pre>" + body + "</pre>",
      ...["Finding", "Origin", "Source", "Timestamp"].flatMap(field => [
        body.replace(new RegExp(`<p>${field}:[^]*?</p>`), ""), body + `<p>${field}: duplicate</p>`,
        body.replace(new RegExp(`<p>${field}:[^]*?</p>`), `<p>${field}: &nbsp; </p>`),
      ]), body.replace("</p>", "</div>"), body.replace("<p>Finding:", "<p><p>Finding:") + "</p>",
      body.replace("<p>Source: fixture.</p>", "<p>Source:<p>fixture.</p></p>"), body.replace("fixture.", "&#160;"), body + "<p>Revision: repo@short</p>"];
    for (const value of invalid) {
      const h = local(Buffer.from(value));
      assert.equal(await run(argv(), h.injected), 1, value);
      assert.deepEqual(h.counts(), { reads: 1, forbidden: 0 });
      assert.ok(h.out.includes("valid: false"));
      assert.ok(!h.errors.join("").includes(value), "content must not be echoed");
    }
  });
  test(`${name} validate enforces consistent evidence and existing revision grammar`, async () => {
    const revision = "repo@" + "a".repeat(40);
    const cases: [string, string, number][] = [
      ["<p>Finding:a</p><p>Origin:b</p><p>Source:c</p><p>Timestamp:d</p>", labels, 0],
      [body, labels.replace("assumed", "confirmed"), 0],
      [body.replace("fixture.", "&amp;"), labels, 0],
      [body.replace("fixture.", "&lt;"), labels, 0],
      [body.replace("fixture.", "&quot;"), labels, 0],
      [body, labels.replace("type-observation,", ""), 1], [body, labels.replace(",status-author-model", ""), 1],
      [body, labels + ",evidence-confirmed", 1], [body, labels + ",type-observation", 1],
      [body + `<p>Revision: ${revision} -- src/a.mts src/b.mts</p>`, labels.replace("assumed", "confirmed"), 0],
      [body + `<p>Revision: ${revision}</p><p>Revision: other@${"b".repeat(40)}</p>`, labels.replace("assumed", "confirmed"), 0],
      [body + `<p>Revision: ${revision} -- ../bad</p>`, labels, 1],
      [body + `<p>Revision: ${revision} (no exact binding: dirty tree)</p>`, labels, 0],
      [body + `<p>Revision: ${revision} (no exact binding: dirty tree)</p>`, labels.replace("assumed", "confirmed"), 1],
      [body + "<p>Revision: none (no exact binding: no repository)</p>", labels, 0],
      [body + "<p>Revision: none (no exact binding: no repository)</p>", labels.replace("assumed", "confirmed"), 1],
    ];
    for (const [value, csv, expected] of cases) {
      const h = local(Buffer.from(value)), args = argv(); args[args.indexOf("--labels") + 1] = csv;
      assert.equal(await run(args, h.injected), expected, csv + " / " + value);
      assert.equal(h.counts().forbidden, 0);
    }
  });
  test(`${name} validate checks decoded visible Revision markers without decoding CDATA literals`, async () => {
    const revision = "repo@" + "a".repeat(40), unbound = "none (no exact binding: dirty tree)";
    const confirmed = labels.replace("assumed", "confirmed");
    const cases: [string, string, number][] = [
      [`<p>&#82;evision: ${unbound}</p>`, confirmed, 1],
      ["<p>&#x52;evision: repo@short</p>", labels, 1],
      [`<p>&#82;evision: ${revision}</p>`, confirmed, 0],
      [`<p>&#82;evision: ${unbound}</p>`, labels, 0],
      [`<p><![CDATA[&#82;evision: ${unbound}]]></p>`, confirmed, 0],
      [`<p><![CDATA[Revision: ${unbound}]]></p>`, confirmed, 1],
      [`<p><![CDATA[Revision: ${revision}]]></p>`, confirmed, 0],
      [`<!-- <p>Revision: ${unbound}</p> -->`, confirmed, 0],
      [`<?note <p>Revision: ${unbound}</p>?>`, confirmed, 0],
    ];
    for (const [paragraph, csv, expected] of cases) {
      const h = local(Buffer.from(body + paragraph)), args = argv(); args[args.indexOf("--labels") + 1] = csv;
      assert.equal(await run(args, h.injected), expected, paragraph);
      assert.deepEqual(h.counts(), { reads: 1, forbidden: 0 });
    }
  });
  test(`${name} validate rejects XML-illegal literal characters and numeric references`, async () => {
    const illegal = [0, 1, 8, 11, 12, 14, 31, 0xd800, 0xdfff, 0xfffe, 0xffff, 0x110000];
    const values = illegal.flatMap(n => [`A &#${n};`, `A &#x${n.toString(16)};`]);
    values.push(...["A &#-1;", "A &#xZZ;", "A &#;", "A &#x;", "A &#12bad;", "A &#0", "A &#X0;"]);
    values.push(...illegal.filter(n => n < 0xd800 || (n > 0xdfff && n <= 0x10ffff)).map(n => `A ${String.fromCodePoint(n)}`));
    for (const value of values) {
      const h = local(Buffer.from(body.replace("fixture.", value)));
      assert.equal(await run(argv(), h.injected), 1, `illegal XML metadata: ${JSON.stringify(value)}`);
      assert.deepEqual(h.counts(), { reads: 1, forbidden: 0 });
    }
    for (const value of [body.replace("fixture.", "&#38;"), body.replace("fixture.", "&#x1f600;"),
      body + "<!-- &#0; --><pre><![CDATA[&#0;]]></pre>"]) {
      const h = local(Buffer.from(value));
      assert.equal(await run(argv(), h.injected), 0, h.errors.join("\n"));
      assert.equal(h.counts().forbidden, 0);
    }
  });
  test(`${name} required paragraphs preserve literal CDATA and ignore comments, PIs and fake markup`, async () => {
    for (const field of ["Finding", "Origin", "Source", "Timestamp"]) {
      for (const content of ["<![CDATA[short]]>", "<![CDATA[&#0;]]>", "<![CDATA[&amp;]]>", "<![CDATA[&#160;]]>", "<![CDATA[&nbsp;]]>",
        "<![CDATA[<p>Origin: fake</p>]]>", "<![CDATA[A]]><![CDATA[B]]>", "&amp;#0;"]) {
        const value = body.replace(new RegExp(`<p>${field}:[^]*?</p>`), `<p>${field}: ${content}</p>`);
        const h = local(Buffer.from(value));
        assert.equal(await run(argv(), h.injected), 0, `${field}: ${content} / ${h.errors.join("\n")}`);
        assert.deepEqual(h.counts(), { reads: 1, forbidden: 0 });
      }
      for (const content of ["<!-- short -->", "<?note short?>", "<![CDATA[  ]]>"]) {
        const value = body.replace(new RegExp(`<p>${field}:[^]*?</p>`), `<p>${field}: ${content}</p>`);
        const h = local(Buffer.from(value));
        assert.equal(await run(argv(), h.injected), 1, `${field}: ${content}`);
        assert.equal(h.counts().forbidden, 0);
      }
      const literalHeader = body.replace(new RegExp(`<p>${field}:[^]*?</p>`), `<p><![CDATA[${field}: short]]></p>`);
      const h = local(Buffer.from(literalHeader));
      assert.equal(await run(argv(), h.injected), 0, h.errors.join("\n"));
    }
    for (const fake of ["<![CDATA[<p>Origin: fake</p>]]>", "<!-- <p>Origin: fake</p> -->", "<?note <p>Origin: fake</p>?>",
      "&lt;p&gt;Origin: fake&lt;/p&gt;"]) {
      const value = body.replace(/<p>Origin:[^]*?<\/p>/, "").replace("fixture.", fake);
      const h = local(Buffer.from(value));
      assert.equal(await run(argv(), h.injected), 1, fake);
      assert.equal(h.counts().forbidden, 0);
    }
  });
  test(`${name} validate rejects malformed UTF-8 and unsupported invocation without account I/O`, async () => {
    const h = local(Buffer.from([0xc3, 0x28]));
    assert.equal(await run(argv(), h.injected), 1);
    assert.deepEqual(h.counts(), { reads: 1, forbidden: 0 });
    for (const args of [["validate", "--format", "wiki", "--body-file", "x", "--labels", labels],
      ["validate", "--format", "storage", "--body", body, "--labels", labels], ["validate"]]) {
      const bad = local(Buffer.from(body));
      assert.equal(await run(args, bad.injected), 1);
      assert.deepEqual(bad.counts(), { reads: 0, forbidden: 0 });
    }
  });
}
