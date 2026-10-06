# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- Added read-only `list_projects` and `list_tags` tools so clients can resolve names to IDs.
- Added a `tagId` filter to `search_tasks`.
- Added a read-only `get_task` tool that returns one task with its notes and, optionally, its subtasks.
- Task summaries now include `tagIds`, `deadlineDay`, and `deadlineWithTime`.

### Fixed

- `ensure_github_issue_task` no longer inherits the project, tag, or Today due date of the view open
  in the app; new issue tasks go to the given project or the Inbox.
- `ensure_github_issue_task` rejects a `projectId` that does not exist or is archived with
  `PROJECT_NOT_FOUND` instead of creating a task that shows in no project list.
- The default title of new issue tasks is now `GitHub issue 123 — owner/repo`; the old
  `GitHub #123 — owner/repo` made Super Productivity 19.0.x ask to create a tag named `123`.
- Custom titles containing short syntax are rejected instead of being parsed by Super Productivity.
  Set `SP_LITERAL_TITLES=true` on builds that store titles literally.

## [0.1.5] - 2026-08-03

### Fixed

- Corrected `check_connection` so a healthy Super Productivity 18.16.0 API is reported as
  configured even when no optional API token is present.
- Added an explicit `tokenConfigured` field to distinguish optional authentication from API
  readiness.

## [0.1.4] - 2026-08-03

### Changed

- Removed private, context-specific references from the public onboarding documentation.
- Reworded Codex Desktop instructions so they stand alone for every reader.

## [0.1.3] - 2026-08-03

### Changed

- Split Desktop onboarding into the ChatGPT Desktop graphical path and the Codex Desktop
  `config.toml` path.
- Made the CLI procedure a separate, exact case with the prerequisite, registration command,
  verification commands, and `codex`-missing fallback.
- Documented that the **MCP servers** menu may not exist in some Codex Desktop settings panels.

## [0.1.2] - 2026-08-03

### Changed

- Split Codex onboarding into explicit Desktop application and CLI procedures.
- Documented the Desktop settings path and shared `config.toml` fallback without requiring the
  `codex` command.
- Added troubleshooting for `zsh: command not found: codex` and corrected the Codex example env
  configuration.

## [0.1.1] - 2026-08-03

### Changed

- Added a first-run onboarding path for the Super Productivity desktop API.
- Documented the supported desktop-version requirement and the missing-setting update path.
- Added local liveness verification, client restart guidance, token safety reminders, and
  troubleshooting for the most common connection errors.
- Updated the npm installation and release documentation now that the public package is available.
- Matched the released Super Productivity 18.16.0 behavior: no token is required, while optional
  Bearer-token support remains available for future authenticated builds.

## [0.1.0] - 2026-08-03

### Added

- STDIO MCP server for Super Productivity's official local REST API.
- Connection health checks, task search, Today listing, task planning, timer control, completion,
  and current-task lookup.
- Explicit GitHub issue association with URL and `owner/repo#number` parsing.
- Marker-based idempotency and ambiguity errors to avoid silent duplicate selection.
- Strict Zod input/output validation, bounded requests, timeouts, loopback URL enforcement, and
  stderr-only redacted logs.
- Unit tests and mocked MCP/REST integration tests.
- Adoption documentation for ChatGPT Desktop and Codex.
- MIT license, contribution/security guidance, issue templates, CI, and tag-driven npm/GitHub
  releases.
