# Contributing

MoA is currently a private, early-stage macOS project. Coordinate substantial changes with the repository owner before implementation.

## Development setup

Requirements:

- macOS 14 or newer;
- Node.js `^20.19.0` or `>=22.12.0`;
- Xcode Command Line Tools;
- at least two supported agent CLIs for end-to-end workflow testing.

```bash
npm ci
npm run dev
```

## Validation

Before submitting changes:

```bash
npm run build
npm test
./build-macos-app.sh
```

Changes to execution, verification, recovery, persistence, installer behavior, attachments, or process supervision should include targeted regression tests. Preserve local-first storage, read-only planning/exploration, user-owned workspace changes, bounded recovery, and approval gates.

Never commit `.env` files, CLI configuration, chat sessions, temporary files, uploaded documents, saved runs, workspace contents, or generated application bundles.
