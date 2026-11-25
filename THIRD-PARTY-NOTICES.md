# Third-party notices

This file is the complete inventory of third-party material in this
distribution. Kherep's own code is licensed under Apache-2.0; see
[LICENSE](LICENSE) and [NOTICE](NOTICE). That licence does not replace or
satisfy a third-party component's own notice obligations.

## Bundled plugin sources

Kherep bundles the components listed below under `codex/parity/plugin-sources/`.
Each is a verbatim snapshot of its upstream source, pinned by the content hash in
`codex/parity/plugin-sources/manifest.json`. Kherep does not modify bundled files,
with the single exception listed under "Changes to bundled files". The snapshot copies
the upstream `agents/`, `commands/` and `skills/` directories
and the licence file, stores line endings as LF as the repository's
`.gitattributes` requires, and adds one marker file, `.canonical-source`, to each
component directory. Where a bundled copy differs from a newer upstream release,
the difference is an upstream change made after the snapshot was taken.

Each component retains its own `LICENSE` file in its directory. Those files, not
this summary, are the governing terms. Where a license text declares no copyright
holder, the holder below is the author declared by the upstream plugin metadata.
The upstream revision is a commit or tag at which every bundled file of the
component equals the upstream file.

| Component | Version | Upstream source | Upstream revision | License | Copyright |
|---|---|---|---|---|---|
| `andrej-karpathy-skills@karpathy-skills` | `1.0.0` | [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) | `64723a49ea61` | MIT (declared; text reproduced below) | forrestchang |
| `atlassian@claude-plugins-official` | `9b52fb18e184` | [atlassian/atlassian-mcp-server](https://github.com/atlassian/atlassian-mcp-server) | `9b52fb18e184` | Apache-2.0 | Copyright (c) [2025] Atlassian US., Inc. |
| `caveman@caveman` | `ef6050c5e184` | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | `ef6050c5e184` | MIT | Copyright (c) 2026 Julius Brussee |
| `claude-code-setup@claude-plugins-official` | `1.0.0` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/claude-code-setup` | `aecd4c852f10` | Apache-2.0 | Anthropic |
| `claude-md-management@claude-plugins-official` | `1.0.0` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/claude-md-management` | `aecd4c852f10` | Apache-2.0 | Anthropic |
| `cloudflare@claude-plugins-official` | `1.0.0` | [cloudflare/skills](https://github.com/cloudflare/skills) | `e638d8c1be5f` | Apache-2.0 | Cloudflare |
| `code-simplifier@claude-plugins-official` | `1.0.0` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/code-simplifier` | `aecd4c852f10` | Apache-2.0 | Anthropic |
| `feature-dev@claude-plugins-official` | `unknown` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/feature-dev` | `aecd4c852f10` | Apache-2.0 | Anthropic |
| `frontend-design@claude-plugins-official` | `unknown` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/frontend-design` | `aecd4c852f10` | Apache-2.0 | Anthropic |
| `mcp-server-dev@claude-plugins-official` | `unknown` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/mcp-server-dev` | `f4b5494fb459` | Apache-2.0 | Anthropic |
| `ralph-loop@claude-plugins-official` | `1.0.0` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/ralph-loop` | `986deab6a165` | Apache-2.0 | Anthropic |
| `security-guidance@claude-plugins-official` | `2.0.3` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `plugins/security-guidance` | `70c28b9c2f9e` | Apache-2.0 | David Dworken |
| `superpowers@claude-plugins-official` | `5.1.0` | [obra/superpowers](https://github.com/obra/superpowers) | `v5.1.0` | MIT | Copyright (c) 2025 Jesse Vincent |

`security-guidance` contributes only its licence file; its content pin is the
hash of empty input.

## Content pins

| Component | Path | contentSha256 |
|---|---|---|
| `andrej-karpathy-skills@karpathy-skills` | `andrej-karpathy-skills_karpathy-skills` | `5b6e6d12a1e5ebdb81eca27f0ccd611adb5a9c6fe0c785989979a0a4971ac19a` |
| `atlassian@claude-plugins-official` | `atlassian_claude-plugins-official` | `2c1376c30debba77d85275e6d2a34dedb9f54f53bb973d2f132c572d030cc060` |
| `caveman@caveman` | `caveman_caveman` | `0d00692c9f4029dd8ed8fcc6663acdd92e61a51d9803177d08d1e9cdaef01e2a` |
| `claude-code-setup@claude-plugins-official` | `claude-code-setup_claude-plugins-official` | `1bd586722215a729b502a5142a798320cad7f9419f3cf57cb014f5df64bee9ea` |
| `claude-md-management@claude-plugins-official` | `claude-md-management_claude-plugins-official` | `41f528491dc39dc009b8845e92cd199278a29d207da39d2c89d0edde3428ca1d` |
| `cloudflare@claude-plugins-official` | `cloudflare_claude-plugins-official` | `41ede193fbe29835bba0b7c285e32e665e537aa7093dcdffe711ae0a68b93e49` |
| `code-simplifier@claude-plugins-official` | `code-simplifier_claude-plugins-official` | `1fbf7b5671857d5cd16abe65b39c3b5708d9d19a399291b1aee84a82ef4dc3e9` |
| `feature-dev@claude-plugins-official` | `feature-dev_claude-plugins-official` | `2896c9c51020b01098ac01704c48e1b1c305e9ee3bca7df78bc735d9e4615ae7` |
| `frontend-design@claude-plugins-official` | `frontend-design_claude-plugins-official` | `70b2784b5b90db1b4de88786968dcd529d7879ea78df5c63fa657daa42eda1c9` |
| `mcp-server-dev@claude-plugins-official` | `mcp-server-dev_claude-plugins-official` | `00a6801676ce3f058347042d69da8ba3778ea797b8690b6dfb109fc438465e66` |
| `ralph-loop@claude-plugins-official` | `ralph-loop_claude-plugins-official` | `96d255809d8bb7a99f4feb1b7f9889a1ed0120687186ffaf1a9242deff1585ab` |
| `security-guidance@claude-plugins-official` | `security-guidance_claude-plugins-official` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `superpowers@claude-plugins-official` | `superpowers_claude-plugins-official` | `10b8df0514865cec0e40c5beb95a702a88da1b871fe9dcc58f58567ebff7575a` |

## Changes to bundled files

`superpowers@claude-plugins-official`: the upstream snapshot contains
`skills/writing-skills/anthropic-best-practices.md`, a copy of Anthropic's
[Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
documentation. Kherep does not redistribute that copy, because the superpowers
MIT licence cannot grant rights to Anthropic's text. The one line in
`skills/writing-skills/SKILL.md` that referred to the file now links to the
documentation page instead. No other bundled file is changed.

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
