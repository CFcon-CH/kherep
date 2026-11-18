// Issue #965: the content verbs on answers that leave something out or differ from what was asked -
// numeric ids, empty bodies, relative next links, guarded readbacks - with an injected session.
import assert from "node:assert/strict";
import test from "node:test";

import type { ConfluenceSession, RequestSpec } from "./confluence-contract.mts";
import { findSpace, getPage, listLabels, purgePage, updatePage } from "./confluence-content.mts";

// Answers the canned bodies in order and records every request.
function recorder(bodies: unknown[]) {
  const specs: RequestSpec[] = [];
  const session: ConfluenceSession = {
    async request(spec) {
      specs.push(spec);
      return { status: 200, json: bodies[specs.length - 1] ?? null };
    },
  };
  return { session, specs };
}

const CURRENT = { id: "5001", title: "Page", status: "current", spaceId: "9001", version: { number: 3 } };

test("a numeric id is read as text and an empty answer as an empty page", async () => {
  const numeric = await getPage(recorder([{ ...CURRENT, id: 5001 }]).session, "5001");
  assert.equal(numeric.id, "5001");
  const empty = await getPage(recorder([null]).session, "5001");
  assert.deepEqual(empty, { id: "", title: "", status: "", version: 0, authorId: "", spaceId: "", link: "" });
});

test("findSpace refuses a malformed key before any request and adopts nothing from an empty answer", async () => {
  const unused = recorder([]);
  await assert.rejects(() => findSpace(unused.session, "not a key"), /--space must be a Confluence space key\./);
  assert.equal(unused.specs.length, 0);
  assert.equal(await findSpace(recorder([null]).session, "KB"), null);
});

test("listLabels follows a relative next link under /wiki and stops when a page adds nothing", async () => {
  const { session, specs } = recorder([
    { results: [{ name: "a" }], _links: { next: "/api/v2/pages/5001/labels?cursor=c1" } },
    { results: [{ name: "b" }, { name: "" }], _links: { next: "/wiki/api/v2/pages/5001/labels?cursor=c2" } },
    { results: [{ name: "b" }], _links: { next: "/wiki/api/v2/pages/5001/labels?cursor=c3" } },
  ]);
  assert.deepEqual(await listLabels(session, "5001"), ["a", "b"]);
  assert.deepEqual(specs.map((spec) => spec.path), [
    "/wiki/api/v2/pages/5001/labels?limit=250",
    "/wiki/api/v2/pages/5001/labels?cursor=c1",
    "/wiki/api/v2/pages/5001/labels?cursor=c2",
  ]);
});

test("a guarded update refuses the wiki representation before any request", async () => {
  const unused = recorder([]);
  await assert.rejects(() => updatePage(unused.session, { id: "5001", representation: "wiki", value: "x", expectedVersion: 3 }),
    /Guarded updates require storage or adf for exact readback\./);
  assert.equal(unused.specs.length, 0);
});

test("an update sends the given title and parent, and the requested id when the read carried none", async () => {
  const { session, specs } = recorder([{ ...CURRENT, id: undefined }, { ...CURRENT, version: { number: 4 } }]);
  await updatePage(session, { id: " 5001 ", representation: "storage", value: "<p>x</p>", title: " New ", parentId: "77" });
  const put = specs[1];
  assert.equal(put.path, "/wiki/api/v2/pages/5001");
  const sent = put.body as { title?: string; parentId?: string };
  assert.deepEqual([sent.title, sent.parentId], ["New", "77"]);
});

test("a guarded update with a parent refuses a readback that shows another parent", async () => {
  const value = "<p>x</p>";
  const readback = { ...CURRENT, title: "New", version: { number: 4 }, parentId: "88", body: { storage: { value } } };
  const { session } = recorder([CURRENT, { ...CURRENT, version: { number: 4 } }, readback]);
  await assert.rejects(() => updatePage(session, { id: "5001", representation: "storage", value, title: "New", parentId: "77", expectedVersion: 3 }),
    /target readback differs from the reviewed page\. Result UNVERIFIED\./);
});

test("purge names a readable page without status as of unknown status and does not delete it", async () => {
  const { session, specs } = recorder([{}]);
  await assert.rejects(() => purgePage(session, "5001"), /Page 5001 is "of unknown status", not "trashed"\./);
  assert.equal(specs.some((spec) => spec.method === "DELETE"), false);
});
