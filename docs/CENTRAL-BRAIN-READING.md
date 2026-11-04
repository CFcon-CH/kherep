# Reading the Central Brain from any client

This guide is for any client that reads the Central Brain: Claude Code, Codex or another MCP-capable client. It covers reading the space faithfully, both through the Atlassian brokers and through the Atlassian MCP v2 server. It adds no new service. The measurements below come from issue [#679](https://github.com/CFcon-CH/kherep/issues/679), taken on one Confluence site in October 2026. Other sites, scopes or vendor releases may behave differently.

## Who does what

| Component | Responsibility |
| --- | --- |
| Confluence space | Persistence: one page per observation, with labels for evidence, author and runtime |
| Atlassian MCP v2 server | Standardized read access for any MCP client the operator has authorized |
| [Atlassian brokers](../modules/atl-jira-brokers/README.md) | Policy-enforced access under a service account: search with evidence labels, guarded writes, computed runtime labels, readback |
| Observation agents (`claude-obs`, Codex candidates through the Maestro) | The only path that files new observations |
| `brain-drainage` and the evidence confirm path | The only lifecycle workflows: they repair pages and confirm or refute them |
| Teamwork Graph and Rovo | Optional semantic candidate search; a hit from them is a locator, not evidence |
| [Control Plane](../modules/control-plane/README.md) | Session messaging; it carries no knowledge |

## Reading rules

1. **Evidence status comes from labels, not from the body or the title.** A page's status is its `evidence-*` label. Who set that status is its `status-author-*` label, a separate dimension. The writing runtime is its `runtime-*` label.
2. **The MCP read payload carries no labels.** In the #679 measurements, `getConfluenceContent` and `searchConfluence` responses contained no label fields, even with `expand=metadata.labels`. You can read labels in two ways:
   - with the broker `labels --id <id>` verb;
   - with a CQL filter per label, for example `id = <id> AND label = "evidence-confirmed"`. Check each status this way; 0 hits for one label does not prove the page carries another.

   A client that reads only the MCP body cannot tell a confirmed page from an assumed one.
3. **Zero search results are not proof of absence.** The two paths behave differently:
   - On the MCP path, a CQL search with a space key that does not resolve returned `totalSize 0` with no error, the same shape as a search with no matches. The test used an unknown key, so the space was missing or not visible; a real space the identity is denied was not tested. Before reporting absence, resolve the space (for example with `getConfluenceSpace`), or use the broker search. For the same unknown key, the broker search exited 2 with `status: unavailable`.
   - A 404 on a single page read does not tell "missing" from "not permitted".
   - In every case the honest result is UNKNOWN until the read path itself is verified.
4. **Check for truncation.** On MCP, `totalSize` greater than `size`, or a `_links.next` cursor, means more results exist. The broker prints `truncated: true`. A truncated result is not the full population; to read further, follow the `next` cursor rather than estimating the remaining pages from `totalSize`.
5. **A raw body hash does not identify a page version.** In #679 the stored representation of one page changed between two reads while its version stayed the same: Confluence added `local-id` attributes and converted plain links to `ac:link` macros. To compare reads across clients or over time, compare:
   - the page version;
   - the page body after a declared text normalization.

   The two paths also return different raw formats for the same version: storage XML from the broker, HTML or markdown from MCP. Equal normalized text shows the visible text agrees; it does not prove equal markup, attributes or link targets, and it does not replace the stricter readback a write requires.
6. **Reading never upgrades evidence.** A page that you read, quote or find agreeing with another page keeps its label. A relayed finding stays relayed. Only the evidence confirm path, which measures against a primary source, may propose a new status.

## Writing

Generic clients read only. New observations and label changes go through the observation agents and the brokers. The brokers compute the runtime label themselves instead of taking it from the caller, and they read back every write.

The Atlassian MCP v2 catalogue does offer generic write operations, including adding labels to content. Whether a client can call them depends on its scopes and the operator's configuration. An MCP client must never set `evidence-*`, `status-author-*` or `runtime-*` labels itself. Doing so would bypass the provenance rules above.
