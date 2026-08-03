# Security Policy

MoA is a local-first desktop application that can launch command-line agents with read-only or workspace-scoped write access. Security reports should therefore include enough detail to reproduce the affected trust boundary without including private workspace contents, credentials, agent transcripts, or saved run artifacts.

## Reporting a vulnerability

While the repository is private, report vulnerabilities directly to the repository owner through GitHub rather than opening a broadly visible issue. Include:

- the affected MoA version or commit;
- the macOS and Node.js versions;
- the affected endpoint, workflow stage, installer step, or CLI integration;
- a minimal reproduction using non-sensitive sample data;
- the expected and observed security boundary.

Do not include API keys, authentication tokens, personal files, private prompts, or full logs from real projects.

## Security boundaries

- The HTTP service binds to `127.0.0.1` and is not designed for network exposure.
- State-changing browser requests are limited to accepted local origins.
- Plan, Explore, Judge, and Verify use read-only agent sandboxes.
- Only explicitly approved execution receives workspace-scoped write access.
- Actionable verification corrections require a fresh, decision-ID-bound user approval.
- Attachments are type, count, and size bounded before agents can access them.
- Custom CLI commands accept executable names or paths, not arbitrary shell argument strings.
- Per-user application state is stored beneath `$HOME` with restrictive permissions.

## Supported versions

Security fixes are applied to the current default branch. Until tagged releases are introduced, users should update to the latest commit and rerun `./install.sh`.
