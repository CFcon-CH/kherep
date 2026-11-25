# Third-party notices

This file is the complete inventory of third-party material in this
distribution. Kherep's own code is licensed under Apache-2.0; see
[LICENSE](LICENSE) and [NOTICE](NOTICE). That licence does not replace or
satisfy a third-party component's own notice obligations.

## Bundled plugin sources

Kherep bundles the components listed below under `codex/parity/plugin-sources/`,
pinned by the content hash in `codex/parity/plugin-sources/manifest.json`. Each is a
selection of the upstream files: the Markdown files directly in `agents/`, the
Markdown and TOML files directly in `commands/`, every direct subdirectory of
`skills/` that holds a `SKILL.md`, copied whole, and the licence and notice files.
Every other upstream file is left out. Each bundled file equals the upstream file at
the stated revision, with the exceptions listed under "Changes to bundled files".
The snapshot stores line endings as LF as the repository's `.gitattributes`
requires, and adds one marker file, `.canonical-source`, to each component
directory. Where a bundled copy differs from a newer upstream release, the
difference is an upstream change made after the snapshot was taken.

Each component retains its own `LICENSE` file, and its `NOTICE` and `LICENSE-MIT`
file where upstream ships one, in its directory. Those files, not
this summary, are the governing terms. Where a license text declares no copyright
holder, the holder below is the author declared by the upstream plugin metadata.
The upstream revision is a commit or tag at which every bundled file of the
component equals the upstream file, apart from those listed changes.

| Component | Version | Upstream source | Upstream revision | License | Copyright |
|---|---|---|---|---|---|
| `andrej-karpathy-skills@karpathy-skills` | `1.0.0` | [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) | `64723a49ea61` | MIT (declared; text reproduced below) | forrestchang |
| `atlassian@claude-plugins-official` | `b74220d41142` | [atlassian/atlassian-mcp-server](https://github.com/atlassian/atlassian-mcp-server) | `b74220d41142` | Apache-2.0 | Copyright (c) 2026 Atlassian US, Inc. |
| `caveman@caveman` | `4.2.0` | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | `47c61be2d10a` | Apache-2.0; parts contributed before 3.0.0 MIT | Copyright 2026 Julius Brussee |
| `claude-code-setup@claude-plugins-official` | `1.0.0` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/claude-code-setup` | `6985b2d88dc0` | Apache-2.0 | Anthropic |
| `claude-md-management@claude-plugins-official` | `1.0.0` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/claude-md-management` | `6985b2d88dc0` | Apache-2.0 | Anthropic |
| `cloudflare@claude-plugins-official` | `1.0.4` | [cloudflare/skills](https://github.com/cloudflare/skills) | `cbf893b95422` | Apache-2.0 | Cloudflare |
| `code-simplifier@claude-plugins-official` | `1.0.0` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/code-simplifier` | `6985b2d88dc0` | Apache-2.0 | Anthropic |
| `feature-dev@claude-plugins-official` | `1.0.1` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/feature-dev` | `6985b2d88dc0` | Apache-2.0 | Anthropic |
| `frontend-design@claude-plugins-official` | `1.1.1` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/frontend-design` | `6985b2d88dc0` | Apache-2.0 | Anthropic |
| `mcp-server-dev@claude-plugins-official` | `6985b2d88dc0` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/mcp-server-dev` | `6985b2d88dc0` | Apache-2.0 | Anthropic |
| `ralph-loop@claude-plugins-official` | `1.0.1` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/ralph-loop` | `6985b2d88dc0` | Apache-2.0 | Anthropic |
| `security-guidance@claude-plugins-official` | `2.0.21` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/security-guidance` | `6985b2d88dc0` | Apache-2.0 | David Dworken |
| `superpowers@claude-plugins-official` | `7.0.2` | [obra/superpowers](https://github.com/obra/superpowers) | `22f0b463e7a5` | MIT | Copyright (c) 2025 Jesse Vincent |

`security-guidance` contributes only its licence file; its content pin is the
hash of empty input.

## Content pins

| Component | Path | contentSha256 |
|---|---|---|
| `andrej-karpathy-skills@karpathy-skills` | `andrej-karpathy-skills_karpathy-skills` | `5b6e6d12a1e5ebdb81eca27f0ccd611adb5a9c6fe0c785989979a0a4971ac19a` |
| `atlassian@claude-plugins-official` | `atlassian_claude-plugins-official` | `00bd17bb1bc0582647baf3817ad55a70edb4579d841f0773d61d55adfc5878d6` |
| `caveman@caveman` | `caveman_caveman` | `09cb92467b9b6db5f90523df512239b8d8aa297abbba0168386cdfc72e27f45b` |
| `claude-code-setup@claude-plugins-official` | `claude-code-setup_claude-plugins-official` | `543e69942cbf5a3fa56ac77c6614a36376e1270527f52c37bbebd1c2b15c37fa` |
| `claude-md-management@claude-plugins-official` | `claude-md-management_claude-plugins-official` | `41f528491dc39dc009b8845e92cd199278a29d207da39d2c89d0edde3428ca1d` |
| `cloudflare@claude-plugins-official` | `cloudflare_claude-plugins-official` | `035ee0bd052a5e1a6730e0d78fc2008bd5fcbbf99dfee964a570711318fbab8b` |
| `code-simplifier@claude-plugins-official` | `code-simplifier_claude-plugins-official` | `1fbf7b5671857d5cd16abe65b39c3b5708d9d19a399291b1aee84a82ef4dc3e9` |
| `feature-dev@claude-plugins-official` | `feature-dev_claude-plugins-official` | `2896c9c51020b01098ac01704c48e1b1c305e9ee3bca7df78bc735d9e4615ae7` |
| `frontend-design@claude-plugins-official` | `frontend-design_claude-plugins-official` | `21e8293ae118ced9063efcd9a051a3d8771d0ca1c324f42b23872b4f213ca33e` |
| `mcp-server-dev@claude-plugins-official` | `mcp-server-dev_claude-plugins-official` | `00a6801676ce3f058347042d69da8ba3778ea797b8690b6dfb109fc438465e66` |
| `ralph-loop@claude-plugins-official` | `ralph-loop_claude-plugins-official` | `96d255809d8bb7a99f4feb1b7f9889a1ed0120687186ffaf1a9242deff1585ab` |
| `security-guidance@claude-plugins-official` | `security-guidance_claude-plugins-official` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `superpowers@claude-plugins-official` | `superpowers_claude-plugins-official` | `8724bbcbfb6e04740c01d637a93954727e05c7b9a7f2e6e6541c5dd480d98caa` |

## Changes to bundled files

The changes are declared in `codex/parity/plugin-source-overlay.json` and applied
when the snapshot is taken. No other bundled file is changed or left out beyond the
selection rule above.

`superpowers@claude-plugins-official`: upstream ships
`skills/writing-skills/references/anthropic-best-practices.md`, a copy of Anthropic's
[Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
documentation. Kherep does not redistribute that copy, because the superpowers
MIT licence cannot grant rights to Anthropic's text. The one line in
`skills/writing-skills/SKILL.md` that referred to the file now links to the
documentation page instead.

`caveman@caveman`: `skills/caveman-commit/SKILL.md` lacks the line that keeps AI
attribution out of commit messages, and `skills/caveman-commit/README.md` lacks the
same statement, because Kherep allows AI attribution and co-author trailers in every
repository. Both files carry a comment saying that Kherep modified them. The skills
`skills/caveman-discover`, `skills/caveman-evidence-review`,
`skills/caveman-manage`, `skills/caveman-optimize` and `skills/caveman-setup`
are left out; they work with a hosted Caveman service that Kherep does not set up.

## andrej-karpathy-skills licence text

`andrej-karpathy-skills@karpathy-skills` declares MIT in its upstream plugin
manifest (`.claude-plugin/plugin.json`, author `forrestchang`), in the skill's
front matter (`license: MIT`) and in the License section of its README. The
upstream project ships no licence file and states no copyright line. The text
below is the standard MIT licence reproduced from that upstream declaration,
naming the author as the upstream names it; it was not copied from an upstream
file. The bundled skill is identical to the upstream source.

```
MIT License

Copyright (c) forrestchang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Adapted and copied material outside the plugin sources

| Material | Kherep paths | Upstream source | Upstream revision | License | Copyright |
|---|---|---|---|---|---|
| Engineering skills | `claude/skills/domain-modeling`, `claude/skills/codebase-design`, `claude/skills/improve-codebase-architecture` | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/engineering/*` | `84fdeffd12f2` | MIT | Copyright (c) 2026 Matt Pocock |
| Code-discovery hooks and skill | `claude/hooks/cbm-session-reminder`, `claude/hooks/cbm-subagent-reminder`, `claude/hooks/cbm-code-discovery-gate`, `claude/skills/codebase-memory/SKILL.md` | [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | unknown | MIT | Copyright (c) 2025 DeusData |

The Matt Pocock skills are adapted; their attribution and full MIT notice are in
[claude/skills/THIRD-PARTY.md](claude/skills/THIRD-PARTY.md).

The code-discovery hooks reproduce text that codebase-memory-mcp generates for
Claude Code, and the `codebase-memory` skill adapts parts of its guidance. The
exact upstream revision they were taken from is not recorded. The upstream MIT
licence follows.

```
MIT License

Copyright (c) 2025 DeusData

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
