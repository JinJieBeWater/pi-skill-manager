# pi-skill-manager

`skill_manage` for [Pi](https://pi.dev): create, inspect, patch, update, list, and delete reusable Agent Skills without installing a memory or session-indexing subsystem.

## Origin and attribution

This project is a standalone adaptation of the skill-management subsystem from [Chandra Teja's `pi-hermes-memory`](https://github.com/chandra447/pi-hermes-memory), specifically [`v0.9.7`](https://github.com/chandra447/pi-hermes-memory/tree/v0.9.7) at commit [`671a27f`](https://github.com/chandra447/pi-hermes-memory/commit/671a27f5ed1fef1f4ca09310bd70ee65acdf0695).

The original project designed and implemented the `skill_manage` contract, skill store, structured Markdown rendering, duplicate and similarity checks, content scanner, project identity handling, and result renderer used here. This repository extracts and adapts that work into one extension that does not start the rest of the Hermes memory runtime.

Changes in this adaptation include removing memory, SQLite, session-search, review, correction, consolidation, and flush wiring; making the extension independently installable as a Pi package; using Pi's file-mutation queue; and adding contract-level compatibility tests.

Original work: Copyright (c) 2025 Chandra Teja. Adaptation: Copyright (c) 2026 JinJieBeWater. Both are licensed under MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the upstream notice and full license text.

## Install

Install from GitHub:

```bash
pi install git:github.com/JinJieBeWater/pi-skill-manager@v0.1.1
```

Then start a new Pi session or run `/reload`.

To try it without changing settings:

```bash
pi -e git:github.com/JinJieBeWater/pi-skill-manager@v0.1.1
```

Pi packages execute with full system access. Review the extension before installing it.

## What it provides

The extension registers one agent-callable tool:

```text
skill_manage
├── create
├── view
├── patch
├── update
├── edit
└── delete
```

It retains the `pi-hermes-memory` input fields, storage layout, and CRUD behavior, including structured Markdown rendering, stable skill IDs, duplicate and similarity guards, content safety checks, atomic writes, and project identity across Git worktrees. Tool guidance and incomplete-body diagnostics are maintained independently.

It does not start memory storage, SQLite indexing, session search, background review, correction detection, consolidation, or flush hooks.

### Body inputs

- `create`: provide non-empty `content`, or all three structured fields: `when_to_use`, `procedure_steps`, and `verification_steps`. `pitfalls` is optional.
- `update` / `edit`: changing only `description` needs no body. Replacing the body requires `content` or all three structured fields.
- `patch`: provide the target section's `content` or matching structured field; other body fields are not required.

Required body strings must contain non-whitespace text, and required lists must contain at least one non-blank item. Non-empty `content` takes precedence over structured fields for `create`, `update`, and `edit`.

Incomplete structured bodies return `success: false`, an `error`, and a `missing_fields` list containing every missing required body field. Rejected calls do not write files. Supply all listed fields and retry the same action; the tool does not invent missing content.

## Storage

Existing paths are retained for drop-in compatibility:

```text
global  ~/.pi/agent/pi-hermes-memory/skills/<skill>/SKILL.md
project ~/.pi/agent/projects-memory/<project>/skills/<skill>/SKILL.md
```

The package does not depend on `pi-hermes-memory` at runtime. The directory name only preserves existing data and skill IDs.

## Migrating from a skill-only Hermes adapter

1. Back up `~/.pi/agent/extensions` and both skill roots above.
2. Remove or disable the old adapter so only one extension registers `skill_manage`.
3. Install this package.
4. Run `/reload`.
5. Confirm a fresh Pi process discovers existing global and project skills.

Do not delete `pi-hermes-memory` skill directories during migration.

## Development

Requirements: Bun and Pi 0.84.3 or newer.

```bash
bun install
bun run check
```

Parity tests compare parameter structure, CRUD results, filesystem behavior, and safety checks against `pi-hermes-memory@0.9.7`. Separate regression checks cover incomplete-body diagnostics and repair without partial writes. Tests do not require model-facing guidance to match upstream wording. The upstream dependency lives in an isolated nested test package, so Pi Git installs never install it.

## License

[MIT](LICENSE). This distribution retains the upstream copyright and license notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
