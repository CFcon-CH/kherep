# Security policy

## Reporting a vulnerability

Report security vulnerabilities privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and select **Report a vulnerability**, or go directly to <https://github.com/CFcon-CH/kherep/security/advisories/new>.

Do not open a public issue, pull request or discussion for a suspected vulnerability.

Include what you can of the following:

- the affected component (for example a hook under `claude/hooks/`, the Codex adapter, a broker in `modules/atl-jira-brokers/` or the Control Plane in `modules/control-plane/`);
- the commit or tag you tested;
- steps to reproduce and the observed result;
- the impact you expect.

Remove credentials, hostnames, private paths and personal data from the report. Use synthetic values and reserved domains such as `example.com`.

## Scope

Kherep installs guards and adapters into a coding-agent runtime and runs a Control Plane between enrolled nodes. Examples of issues in scope:

- a guard that is documented to block an action but can be made to allow it;
- a path by which credentials, private files or local-inference artifacts reach a cloud tool, an agent or the transcript despite the documented privacy boundary;
- an installer or upgrade step that weakens existing configuration, Git hooks or permissions without reporting it;
- authentication, enrollment, replay or authorization flaws in the Control Plane Worker, node daemon or operator API (see the [Control Plane security model](../modules/control-plane/README.md#security-model)).

Vulnerabilities in Claude Code, Codex, Atlassian products, Cloudflare or other third-party software belong with their respective vendors.

## Versions

Kherep is pre-1.0 and versioned `0.y.z` (see [CHANGELOG.md](../CHANGELOG.md)). Report issues against the current `main` branch.
