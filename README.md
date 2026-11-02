![Kherep: Maestro Agent Orchestration; Claude, Codex & More; Rules, Hooks & Skills; MCP Integration; Model & Tool Routing; Local Inference; Central Brain knowledge base in Confluence; ...](assets/branding/kherep-banner.png)

# Kherep

Kherep coordinates coding agents, tools and shared knowledge across Claude Code and Codex. You direct the work; a Maestro plans the task, assigns bounded work and checks the result against code, tests and the requested outcome.

Use Kherep to give your agents consistent working rules, reusable skills and a shared approach to choosing models and tools. Runtime adapters keep Claude and Codex configuration separate while applying the same orchestration principles.

[![Kherep - Your runtimes, Your rules (video)](https://img.youtube.com/vi/w9pLDRU_ulo/maxresdefault.jpg)](https://youtu.be/w9pLDRU_ulo)

*Watch the overview: [Kherep - Your runtimes, Your rules](https://youtu.be/w9pLDRU_ulo)*

## Contents

- [Key capabilities](#key-capabilities)
- [Architecture](#architecture)
- [Supported integrations](#supported-integrations)
- [Installation](#installation)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Documentation](#documentation)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Contributing](#contributing)
- [Roadmap](#roadmap)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Key capabilities

- **Maestro agent orchestration:** plan work, delegate focused tasks and verify the combined result.
- **Claude Code and Codex adapters:** shared rules with installation and hooks for each runtime.
- **Rules, hooks and skills:** reusable workflows for implementation, review, debugging and delivery.
- **Model and tool routing:** choose available capabilities through operator-configured policies. Codex roles name model families, not versions: installation resolves them against the available models into native agent files and one dispatch snapshot, which a reinstall keeps until `--refresh-models`; see [Codex integration](docs/CODEX.md#install). An exact predecessor can receive the [routing-only update](docs/CODEX.md#routing-only-update) with a dedicated backup and rollback.
- **MCP integration:** connect explicitly configured services through transport and authentication adapters.
- **Local inference:** use configured local processing routes, including a separate path for private inputs.
- **Central Brain:** a shared knowledge base in a dedicated Confluence space. With a configured space and brokers, durable findings from completed turns become pages: the Claude observation agent files them itself, and the pinned Codex Luna observation agent extracts and publishes through a narrow local service-account adapter. The Codex Maestro independently checks its receipt and target pages. A finding about repository code counts as `confirmed` only when it names each repository as `<name>@<full commit sha>` measured on a clean tree; otherwise it is filed as `assumed`.
- **Brain drainage:** operator-invoked knowledge-space hygiene review through the read-only service-account scanner, with explicit-authority repairs and reviewed-version protection, and an operator-requested confirm path that measures `evidence-assumed` pages against their primary source before proposing a new evidence label. See [broker workflow](modules/atl-jira-brokers/README.md#brain-drainage).
- **Turn-completion observations:** after a substantial Claude turn a Stop hook has the Maestro dispatch `claude-obs`, and Codex can dispatch one bounded `codex-obs` pass; see [Codex integration](docs/CODEX.md#turn-completion-observations).
- **Control Plane:** enrolled nodes connect to a Cloudflare Worker to exchange session messages and start tasks on each other. On a host with a managed service, sessions use one stable command, `node "<config directory>/bin/kherep-node.mjs"`, which follows the active service pin. The details are in [Control Plane](modules/control-plane/README.md), including prerequisites, task controls and platform limits:
  - **Delivery:** a running Claude Code session receives accepted messages after its next successful tool call, and its Stop confirms delivery.
  - **Waking idle sessions:** an idle Claude Code listener may wake an eligible owner. When SessionStart supplies no `permission_mode`, arming also needs the full session id or current unique name in `wake.sessions`, a known safe mode and a successful launch check.
  - **Codex owners:** authorized Codex original owners receive compact hints in the running turn. Two opt-ins exist, both off by default: `wake.nativeQueue` adds a bounded native Queue pointer for exact-addressed messages, and `wake.codexFork` (darwin only) lets an ephemeral fork of an idle Codex chat relay one bounded, labelled proxy answer while the owner stays idle. The Control Plane keeps peer content until complete original-owner intake and an explicit processing ACK. Hint admission costs no autonomous turn; native attempts use the existing turn budget and durable duplicate protection.
  - **Confirmed stop:** `task stop` and `msg stop` end a background task the node started and confirm it, for Codex and, on macOS and Linux, for Claude Code. Windows refuses the Claude Code stop.
  - **Doctor:** `kherep-node doctor` fails when any check fails. Its `wakeReadiness` check reports policy eligibility, restart authorization, remembered permission and listener evidence separately and derives no ready verdict.
  - Installation, native activation and each host's actual processing need separate verification.

Backends and integrations are configured separately. Installing an adapter does not provision a model, MCP service or Confluence space.

## Architecture

Kherep is installed from a source checkout into the configuration homes of the agent runtimes on a host. The installer places rules, hooks, skills, agents and routing, binds the Git `commit-msg`, `post-checkout` and `pre-push` hooks and keeps backups. Optional integrations are reached only through configured adapters.

```mermaid
flowchart LR
  operator([Operator])

  subgraph host["Host: Windows or macOS"]
    direction TB
    bootstrap["Installer and drift check<br/>bootstrap/"]
    codexModels["Codex role-family TOML<br/>visible model/list metadata"]
    subgraph runtimes["Agent runtimes"]
      claude["Claude Code<br/>rules, hooks, skills, agents"]
      codex["Codex<br/>adapter projection"]
    end
    githook["Git hooks<br/>commit-msg, post-checkout, pre-push"]
    brokers["Atlassian brokers"]
    runner["Local inference runner"]
    bridge["MCP auth bridge"]
    nodeDaemon["Control Plane node daemon"]
    liveness["Session metadata<br/>shared generation, UNKNOWN native adapters"]
    daemonService["Per-user daemon service<br/>verified source pin and rollback"]
    queueRetire["Native Queue reconciliation"]
  end

  confluence[("Confluence space<br/>Central Brain")]
  model["Local model server"]
  mcp["Configured MCP services"]
  worker["Control Plane Worker<br/>Cloudflare"]
  peers["Other enrolled nodes"]

  operator --> runtimes
  bootstrap -->|installs| runtimes
  codexModels -->|first install or explicit refresh| bootstrap
  bootstrap -->|explicit workspace: two context hooks| codex
  bootstrap -->|one resolved model snapshot| codex
  bootstrap -->|binds| githook
  runtimes --> brokers --> confluence
  codex -->|validated native main-turn IDs, pinned Luna, read-only filesystem| observationAdapter["Narrow observation MCP adapter"]
  observationAdapter -->|authority, journal, readback| brokers
  runtimes --> runner --> model
  runtimes --> bridge --> mcp
  nodeDaemon -->|five-minute coalesced pass| liveness
  liveness -->|truthful listing and deny-only admission| nodeDaemon
  nodeDaemon <--> worker <--> peers
  daemonService -->|starts and upgrades| nodeDaemon
  nodeDaemon -.->|delivers peer messages| runtimes
  nodeDaemon -.->|Codex CP admission and original-owner intake| codex
  codex -.->|Processing ACK, then exact Queue reconciliation| queueRetire
  queueRetire -.->|Exact owned Queue list/delete/readback| codex
```

| Component | Directory | Responsibility |
| --- | --- | --- |
| Claude adapter | `claude/` | Rules, hooks, skills, agents, commands and routing for Claude Code |
| Hook runtime | `claude/kherep/hook-runtime/` | Starts the Claude hooks under `hooks/`, serializes integrity repairs against them and denies a `PreToolUse` call whose dispatcher is missing, empty or broken |
| Codex adapter | `codex/` | Projection of the shared rules, skills and agents into Codex; see [adapter architecture](codex/ARCHITECTURE.md) |
| Bootstrap | `bootstrap/` | Host profiles, managed installation, backups, drift checks and the commit policy |
| Atlassian brokers | `modules/atl-jira-brokers/` | Jira and Confluence operations under a service account, including the Central Brain space |
| Teamwork Graph | `modules/twg/` | Bounded, read-only Teamwork Graph lookups |
| Local inference | `modules/local-inference/` | Runner for a configured local model server, reached locally or over SSH |
| MCP auth bridge | `modules/mcp-auth-bridge/` | Authenticated transport wrappers for configured MCP servers |
| Control Plane | `modules/control-plane/` | Cloudflare Worker, node daemon and shared protocol for enrollment, session messaging and tasks |
| Daemon service | `modules/control-plane/node/service-*.mts` | Per-user LaunchAgent or supervised Scheduled Task, immutable source activation, measured upgrade and rollback |

macOS adoption uses the configured on-disk plist and verifies observable loaded
job identity. It retains configured bytes rather than a complete launchd memory
cache; see the [service adoption contract](docs/INSTALLATION.md).

### Central Brain

[![Relief: scribes of Claude Code and Codex bring findings to one archive; a scale weighs the evidence, the broker seals each scroll, private matters stay in a locked shrine.](assets/illustrations/kherep-brain-relief.svg)](https://raw.githubusercontent.com/cfaysal/kherep/main/assets/illustrations/kherep-brain.svg)

Sessions are asked to search the space before answering, and a substantial turn that shows neither research nor a stated reason to skip it is sent back once. The matching pages come back with their evidence status. After a substantial turn, the observation agent files what the turn established through the broker. See the [detailed diagram](https://raw.githubusercontent.com/cfaysal/kherep/main/assets/illustrations/kherep-brain.svg). Clients that read the space directly, including through the Atlassian MCP server, follow [Reading the Central Brain](docs/CENTRAL-BRAIN-READING.md).

### Control Plane

[![Relief: two temples on opposite banks exchange sealed scrolls by boat through a central obelisk, where waiting messages are kept in jars.](assets/illustrations/kherep-control-plane-relief.svg)](https://raw.githubusercontent.com/cfaysal/kherep/main/assets/illustrations/kherep-control-plane.svg)

Phase 1 session liveness uses metadata and local lifecycle tombstones, with UNKNOWN
native adapters. UNKNOWN identities remain addressable without granting native
MCP registration or claim permission. This does not establish native acceptance or wire the later
24-hour admission deadline; native turn start can follow timely admission after
expiry. See the [liveness contract](modules/control-plane/ARCHITECTURE.md#session-liveness-metadata-phase-1-706).

Sessions on different nodes exchange messages through one Cloudflare Worker, and a session can ask another node to start a new intercom session. A peer message informs; it never approves. See the [detailed diagram](https://raw.githubusercontent.com/cfaysal/kherep/main/assets/illustrations/kherep-control-plane.svg).

## Supported integrations

Each integration is optional unless a component's guide says otherwise, and each needs your own account, service or backend.

| Integration | Used for | Guide |
| --- | --- | --- |
| Claude Code | Runtime adapter with rules, hooks, skills, agents and routing | [Installation](docs/INSTALLATION.md) |
| Codex | Runtime adapter with rules, skills, agents, hooks and MCP projection | [Codex integration](docs/CODEX.md) |
| Confluence | Central Brain knowledge space, written through service-account brokers | [Atlassian brokers](modules/atl-jira-brokers/README.md) |
| Jira | Optional service-account helpers | [Atlassian brokers](modules/atl-jira-brokers/README.md) |
| Atlassian MCP server | Optional v2 remote server, reached as each runtime's own service account; destructive operations need the operator | [Atlassian MCP server](docs/INSTALLATION.md#atlassian-mcp-server) |
| Atlassian Teamwork Graph | Read-only lookups | [Teamwork Graph](modules/twg/README.md) |
| MCP servers | Transport and authentication adapters for servers you configure | [Codex adapter architecture](codex/ARCHITECTURE.md#mcp-projection) |
| Local model server | Local inference, including the private-input route | [Installation](docs/INSTALLATION.md#5-configure-integrations) |
| Cloudflare Workers and Access | Control Plane Worker and its Access-protected operator API | [Control Plane](modules/control-plane/README.md#setup) |

## Installation

Use Node.js 24 (at least 22.18 on the 22 line, or 23.6), npm and Git. The Claude installer also needs Bash; on Windows use Git Bash.

```sh
git clone https://github.com/cfaysal/kherep.git
cd kherep
npm ci
```

Follow the [installation guide](docs/INSTALLATION.md) to select your workspace, review an isolated installation and set up the required runtime. The guide's isolated preview writes into a new candidate directory and leaves your live configuration unchanged; inspect it before installing for real. For Codex, follow [Codex integration](docs/CODEX.md). For the Central Brain space and the brokers that write to it, see [Atlassian brokers](modules/atl-jira-brokers/README.md).

Runtime adapters target Windows and macOS. See each component's documentation for its requirements.

After installation, confirm the result in the runtime itself as described in [Verify the installed runtime](docs/INSTALLATION.md#verify-the-installed-runtime). `bootstrap/drift-check.sh` compares the managed source with the installed files and exits non-zero on drift.

An enrolled Control Plane node can run its daemon as a per-user login service on macOS or Windows, installed from a clean committed checkout with `kherep-node service install --workspace <absolute workspace> --source <absolute checkout>`. Later, `service upgrade` and `service rollback` change the active source pin. These commands also write the stable command `node "<config directory>/bin/kherep-node.mjs"`, and both installers render it into the always-loaded agent instructions. See [Upgrades and rollback](docs/INSTALLATION.md#upgrades-and-rollback), [Intercom command](docs/INSTALLATION.md#intercom-command) and [Control Plane: Node](modules/control-plane/README.md#node).

## Configuration

Kherep is configured through environment variables at installation time and operator files outside the checkout. Connection profiles ship unconfigured. The settings, their defaults and the model and work-item policies are listed in [Configure integrations](docs/INSTALLATION.md#5-configure-integrations) and [Model and work-item policy](docs/INSTALLATION.md#model-and-work-item-policy).

Keep personal configuration and credentials outside the checkout.

## Security model

- **Credentials stay outside the checkout.** Integration configuration lives under an operator-chosen root, and Jira and Confluence writes go through brokers that act as a service account.
- **The Git `commit-msg` hook is the enforcement boundary for every runtime.** It applies the host's commit policy, including optional work-item keys, and allows co-author trailers and AI attribution. The Claude `commit-guard` hook gives earlier feedback; it does not replace the Git hook. In this repository, the `commit-policy` CI check runs the same hook over every commit of a pull request.
- **Claude guards check tool calls before they run.** They keep private paths and local-inference artifacts out of agents, workflows, web and MCP tools; block shell commands whose output is likely to print secrets; block production deploys and Forge installs, force pushes and destructive Kubernetes and Helm commands unless the user approved the command; block Playwright navigation to `file://` URLs; ask the operator before an Atlassian MCP `executeDestructive` call; keep the main checkout of a managed repository on its default branch, so feature work happens in a worktree; and enforce the model policy for agent dispatch, including that a build worker's brief names the revision it works on and the decisions already made. They run through a dispatcher that denies the tool call when a guard cannot run, because it is missing, empty, broken, failing or timed out, and the reason names the file. A guard notice without a decision passes through unchanged. Every managed hook under `hooks/` starts through the hook runtime entry, which denies a `PreToolUse` call whose dispatcher is missing, empty or broken; the entry itself cannot be checked, and the [upgrade notes](docs/INSTALLATION.md#upgrades-and-rollback) list this and the other limits. The Control Plane delivery, wake and attribution hooks run from the checkout. In Codex every guard of a tool-call group, the optional messaging intent hook included, runs through the hook adapter or the shell dispatcher, which also deny the tool call when a guard cannot run or runs past its budget; the two dispatcher files cannot check themselves, so each checks the other. After an upgrade that changes a hook definition, Codex skips it until it is trusted in `/hooks`, and the installer says so. The Git `post-checkout` hook warns when a main checkout leaves its default branch anyway. A delegated Claude worker's denied calls are journalled per worker and read by the Maestro with `hooks/denied-calls.mts render <agent_id>`, which prints `none` only on positive evidence ([limits](docs/INSTALLATION.md#upgrades-and-rollback)). Every wired hook, with its event and kind, is listed in the [hook reference](docs/HOOKS.md).
- **Pushes and pull requests are attributed locally.** The Git `pre-push` hook and a `PostToolUse` hook for `gh pr create` record which session pushed which ref or opened which PR in a host-local log, mode `0600` and trimmed after 90 days. The log holds ids, refs, SHAs and PR numbers, never commit subjects, PR text or tokens, and never leaves the host. Its session ids are what the runtime reported, so they attribute work; they do not authenticate it.
- **Hook integrity is checked at session start and re-checked on guarded tool calls.** Wired hook files that are missing, empty or unloadable are detected and repaired from the versioned source. Repairs are serialized against every hook the hook runtime starts and recorded before they are written, so no admitted hook loads a half-written file. A fully proven check writes a heartbeat; the next guarded tool call re-checks when the heartbeat is older than 30 minutes or a guard could not run. A stale heartbeat is reported, never blocks, and the current call keeps its verdict. Codex does the same through its hook adapter and its shell dispatcher; it has no hook runtime, so its integrity hook serializes its own repairs with a lock, and a parallel Codex call can still load a file while it is being repaired. Its heartbeat also records the two dispatcher files as the bytes it checked, and a dispatcher that changed since then is re-checked by the other one's next call.
- **Installation is reviewable and reversible.** An isolated preview, managed backups and a drift check precede and follow changes to a live configuration.
- **The Control Plane authenticates nodes and operators separately.** Nodes hold Ed25519 keys and connect with a signed challenge; the operator API requires a verified Cloudflare Access token; peer messages reach a session only as framed content that is not a user instruction. See the [Control Plane security model](modules/control-plane/README.md#security-model).

To report a vulnerability, follow the [security policy](.github/SECURITY.md).

## Documentation

| Guide | Purpose |
| --- | --- |
| [Installation](docs/INSTALLATION.md) | Claude setup, isolated preview, upgrades and rollback |
| [Hook reference](docs/HOOKS.md) | Every wired Claude, Codex, Git and Control Plane hook, its event and what it does |
| [Codex integration](docs/CODEX.md) | Codex installer options and runtime verification |
| [Codex adapter architecture](codex/ARCHITECTURE.md) | Memory backends, research enforcement, hook integrity and MCP projection in Codex |
| [Codex hook starts](docs/CODEX-HOOK-RUNS.md) | Reproducible comparison of Codex hook starts with the shell dispatcher |
| [Atlassian brokers](modules/atl-jira-brokers/README.md) | Jira and Confluence service-account operations, including the Central Brain space |
| [Reading the Central Brain](docs/CENTRAL-BRAIN-READING.md) | How any client, through a broker or the Atlassian MCP server, reads evidence status, absence, truncation and page versions faithfully |
| [Control Plane](modules/control-plane/README.md) | Cloudflare Worker and node daemon for node enrollment, liveness, session messaging and task sessions |
| [Teamwork Graph](modules/twg/README.md) | Runtime contract and installation of the Teamwork Graph integration |
| [Public release review](docs/PUBLIC-RELEASE.md) | Review steps before pushing and before tagging a release |
| [Changelog](CHANGELOG.md) | Notable changes per release |
| [Security policy](.github/SECURITY.md) | Private vulnerability reporting |
| [Contributing](CONTRIBUTING.md) | Source setup and test commands |
| [Agent instructions](AGENTS.md) | Reading order and repository working rules |

## Repository layout

| Directory | Contents |
| --- | --- |
| `claude/` | Claude rules, hooks, skills, agents and routing |
| `codex/` | Codex adapters, plugin projection, installers and parity checks |
| `bootstrap/` | Host profiles, managed installation, backups and drift checks |
| `modules/local-inference/` | Local processing runner and configuration |
| `modules/mcp-auth-bridge/` | Authenticated MCP transport adapters |
| `modules/atl-jira-brokers/` | Operator-configured Jira and Confluence service-account operations |
| `modules/twg/` | Bounded Teamwork Graph reads |
| `modules/control-plane/` | Control Plane Worker, node daemon and their shared protocol |
| `lib/` | Shared helpers for `KHEREP_*` environment lookup and Windows workspace paths |
| `docs/` | Installation, Codex and release guides, and design plans |
| `assets/` | Branding banner and illustrations |
| `.github/` | CI workflows, issue and pull request templates, security policy |

## Development

Kherep's TypeScript runs directly on Node.js through type stripping; `tsc` is the type check only.

```sh
npm ci
npm run typecheck
npm run test:bootstrap
```

[CONTRIBUTING.md](CONTRIBUTING.md) lists the checks for each component. CI runs the suites on Linux, macOS and Windows for every pull request.

## Contributing

Track changes in [GitHub Issues](https://github.com/cfaysal/kherep/issues). Changes reach `main` only through a pull request, merged by rebase. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and conventions.

## Roadmap

Planned and in-progress work is tracked as [open issues](https://github.com/cfaysal/kherep/issues). Released changes and the `[Unreleased]` section are in the [changelog](CHANGELOG.md).

## Acknowledgements

Kherep's approach to session memory and observations was inspired by [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman. Kherep contains no code from claude-mem.

## License

Kherep is licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE). Bundled and adapted third-party material keeps its own license, listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Claude, Claude Code, Codex, Atlassian, Jira, Confluence and other product names are trademarks of their respective owners; Kherep is an independent project and is not affiliated with or endorsed by Anthropic, OpenAI or Atlassian.
