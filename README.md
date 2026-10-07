# Super Productivity MCP

[![CI](https://github.com/Amorem/super-productivity-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Amorem/super-productivity-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![npm version](https://img.shields.io/npm/v/super-productivity-mcp-server?logo=npm)](https://www.npmjs.com/package/super-productivity-mcp-server)

![Super Productivity MCP](assets/logo.svg)

An explicit, local [Model Context Protocol](https://modelcontextprotocol.io/) server for
[Super Productivity](https://super-productivity.com/). It connects ChatGPT Desktop or Codex to
Super Productivity's official local REST API over STDIO.

The core promise is deliberately small:

> Select one task explicitly, put it in Today, start or stop its timer, and complete it.

Nothing is imported or scheduled implicitly. GitHub issue association is opt-in per tool call.

## Quick start

The complete first-run path takes a few minutes:

1. Install the **Super Productivity desktop app 18.x or newer**. The web and mobile apps do not
   expose this local API. If **Enable local REST API** is missing, update the desktop app from the
   [official releases](https://github.com/super-productivity/super-productivity/releases/latest).
2. In Super Productivity, open **Settings → Misc Settings** and enable **Enable local REST API**.
   With the released 18.16.0 desktop app, no token is displayed and no token is required.
3. **Choose exactly one host setup below.** Do not run the CLI command if you use a Desktop
   application.

   **Case A — Desktop application:**

   - **ChatGPT Desktop:** open **Settings → MCP servers → Add server → STDIO**, enter command
     `npx`, and add the two arguments `-y` and `super-productivity-mcp-server`.
   - **Codex Desktop:** it may not show an **MCP servers** menu.
     Open **Settings → Configuration**, choose **Open config.toml**, and paste the configuration
     block in the Codex Desktop section below. No CLI is required.

   **Case B — Codex CLI:** open the CLI section below, verify `codex --version`, and then run the
   exact `codex mcp add` command. If Terminal says `zsh: command not found: codex`, use the Codex
   Desktop `config.toml` path in Case A instead.

   For Super Productivity 18.16.0, leave `SP_API_TOKEN` unset. If a future build displays an Access
   Token, supply it only through the MCP environment; never paste it into a chat or commit it.

4. Restart or reload the MCP host after completing your selected case, then ask it:

   ```text
   Check the connection to Super Productivity with check_connection.
   ```

5. Once the connection succeeds, use `search_tasks` to find one task and pass its returned
   `taskId` explicitly to `plan_task_today`, `start_task`, `stop_timer`, or `complete_task`.

Optional local liveness check (it does not require the token):

```bash
curl --noproxy 127.0.0.1 http://127.0.0.1:3876/health
```

The expected response contains `"server":"up"` and `"rendererReady":true`.

## What it does

| Tool                          | Purpose                                     |         Changes state |
| ----------------------------- | ------------------------------------------- | --------------------: |
| `health` / `check_connection` | Check the local API and renderer            |                    No |
| `search_tasks`                | Find tasks by title, project, or tag        |                    No |
| `get_task`                    | Read one task with notes (and subtasks)     |                    No |
| `list_projects`               | List project IDs and titles                 |                    No |
| `list_tags`                   | List tag IDs and titles                     |                    No |
| `list_today`                  | List tasks already planned for Today        |                    No |
| `plan_task_today`             | Plan exactly one supplied task ID for Today |                   Yes |
| `start_task`                  | Start exactly one supplied task ID          |                   Yes |
| `stop_timer`                  | Stop the current timer                      |                   Yes |
| `complete_task`               | Complete exactly one supplied task ID       |                   Yes |
| `get_current_task`            | Read the currently tracked task             |                    No |
| `create_task`                 | Create one task (Inbox unless told)         |                   Yes |
| `update_task`                 | Change fields of one supplied task ID       |                   Yes |
| `archive_task`                | Archive one task (marks it done)            |                   Yes |
| `restore_task`                | Restore one archived task                   |                   Yes |
| `ensure_github_issue_task`    | Reuse or create one task for a GitHub issue | Yes, only when called |

`create_task` sends the project, tags, and due date explicitly, so a new task never picks up
the project, tag, or Today view that happens to be open in the app. Without a project it goes to the
Inbox. Project and tag names must match exactly (ignoring case); ambiguous names are rejected.
Titles containing short syntax are rejected as described below. `update_task` changes only the
fields it is given; an edited title is stored literally, because it is always sent together with
another field, which Super Productivity 19.0.x does not parse. There is no delete: `archive_task` moves a
top-level task and its subtasks to the archive (Super Productivity marks them done and clears their
due date), and `restore_task` brings them back, not done.

New issue tasks go to the given project or the Inbox, without tags or a due date, whatever view is
open in the app. A given `projectId` must exist and not be archived. Super Productivity 19.0.x and older parse short syntax (`#tag`, `+project`,
`@date`, `!deadline`, `30m`) out of new titles, so a custom `title` containing it is rejected with
`TITLE_HAS_SHORT_SYNTAX`; on builds that store titles literally, set `SP_LITERAL_TITLES=true`.

The server intentionally does not create GitHub issues. Use the GitHub integration or connector for
that, then call `ensure_github_issue_task` only when you explicitly want the issue in Super
Productivity.

## The workflow

```mermaid
flowchart LR
    A["ChatGPT Desktop or Codex"] -->|STDIO MCP| B["Super Productivity MCP"]
    B -->|"Loopback HTTP; no token in 18.16.0"| C["Super Productivity local REST API"]
    C --> D["One selected task"]
    D --> E["Today"]
    E --> F["Timer"]
    F --> G["Done"]
    H["GitHub issue URL or owner/repo#number"] -->|explicit ensure call| B
```

Typical conversation:

```text
Search Super Productivity for "Add the export filter".
Plan task <returned taskId> for Today.
Start task <same taskId>.
Stop the timer.
Complete task <same taskId>.
```

The server instructions tell an MCP client to search first and pass the exact returned `taskId` to
every state-changing operation. There is no bulk-selection fallback.

## Requirements

- Super Productivity desktop 18.x or newer with the local REST API enabled.
- Node.js 20 or newer.

In Super Productivity, enable **Settings → Misc Settings → Enable local REST API**. The official API
listens on `http://127.0.0.1:3876` by default and exposes an unauthenticated `/health` endpoint. The
released 18.16.0 desktop API is also unauthenticated for task endpoints, so no token is needed for
the normal setup. This server sends a Bearer token only when the optional `SP_API_TOKEN` is set, to
remain compatible with future authenticated builds.

Read the [official Super Productivity local REST API documentation](https://github.com/super-productivity/super-productivity/blob/master/docs/wiki/3.01-API.md)
before changing the API URL or exposing a proxy. The upstream API is release-sensitive: this
package's no-token default matches the [18.16.0 desktop release](https://github.com/super-productivity/super-productivity/releases/tag/v18.16.0),
whose [released API handler](https://github.com/super-productivity/super-productivity/blob/v18.16.0/electron/local-rest-api.ts)
does not authenticate task requests.

## Install

From the public npm registry:

```bash
npx -y super-productivity-mcp-server
```

End users do not need an npm account or an npm login to install the public package.

For a local checkout:

```bash
pnpm install
pnpm build
node /absolute/path/to/super-productivity-mcp/dist/index.js
```

### Package and releases

The public package is [`super-productivity-mcp-server`](https://www.npmjs.com/package/super-productivity-mcp-server).
The GitHub release workflow publishes new versions when the repository has an `NPM_TOKEN` Actions
secret. That maintainer-only credential is not needed by people installing or using the server.

The server reads configuration from environment variables:

| Variable                    | Default                 | Notes                                                               |
| --------------------------- | ----------------------- | ------------------------------------------------------------------- |
| `SP_API_TOKEN`              | —                       | Optional Bearer token for an authenticated Super Productivity build |
| `SP_API_URL`                | `http://127.0.0.1:3876` | HTTP(S) URL; loopback is enforced by default                        |
| `SP_API_TIMEOUT_MS`         | `15000`                 | Integer from 1000 to 60000                                          |
| `SP_ALLOW_NON_LOOPBACK_URL` | `false`                 | Use only for a trusted local proxy                                  |
| `SP_LITERAL_TITLES`         | `false`                 | `true` only if the app stores new task titles literally             |
| `SP_LOG_LEVEL`              | `warn`                  | `error`, `warn`, `info`, or `debug`                                 |

See [.env.example](.env.example) for a copyable template.

## Case A — Desktop application

There are two Desktop applications people commonly mean here. They do **not** expose the same
menu:

- **ChatGPT Desktop:** has the graphical **Settings → MCP servers** menu.
- **Codex Desktop:** some builds may not have an MCP menu. Use **Settings → Configuration → Open
  config.toml** instead.

Both variants start the same public npm package. You do not need an npm account or an npm login.

### A1. ChatGPT Desktop — graphical setup

Use this exact procedure in the ChatGPT Desktop application:

1. Open **Settings → MCP servers**.
2. Click **Add server**.
3. Choose **STDIO**.
4. Fill the fields as follows:

   | Field                    | Value                                                              |
   | ------------------------ | ------------------------------------------------------------------ |
   | Name, if requested       | `super_productivity`                                               |
   | Command                  | `npx`                                                              |
   | Arguments                | `-y` and `super-productivity-mcp-server` as two separate arguments |
   | `SP_API_URL`, optional   | `http://127.0.0.1:3876`                                            |
   | `SP_LOG_LEVEL`, optional | `warn`                                                             |
   | `SP_API_TOKEN`           | Leave empty for Super Productivity 18.16.0                         |

5. Save the server and select **Restart** or restart ChatGPT Desktop if requested.
6. In a chat, type `/mcp` to inspect connected servers, then ask:

   ```text
   Check the connection to Super Productivity with check_connection.
   ```

If **MCP servers** or **STDIO** is unavailable in ChatGPT Desktop, update the application or use
the Codex Desktop configuration path below. For a local build, replace the command with `node`
and use the absolute path to `dist/index.js`. See
[examples/chatgpt-desktop.md](examples/chatgpt-desktop.md).

### A2. Codex Desktop — configure `config.toml`, not an MCP menu

If your Codex Desktop build does not show an **MCP servers** menu, do **not** look for it elsewhere
in the settings. Use **Settings → Configuration → Open config.toml** instead:

1. Open **Settings**.
2. Select **Configuration** in the left sidebar.
3. Select **Open config.toml**.
4. Add this block and save the file:

   ```toml
   [mcp_servers.super_productivity]
   command = "npx"
   args = ["-y", "super-productivity-mcp-server"]
   env = { SP_API_URL = "http://127.0.0.1:3876", SP_LOG_LEVEL = "warn" }
   ```

5. Fully quit and reopen Codex Desktop.
6. Ask Codex:

   ```text
   Check the connection to Super Productivity with check_connection.
   ```

The shared file is normally `~/.codex/config.toml`. Codex Desktop, Codex CLI, and the IDE
extension use the same configuration layers. For a local checkout, replace the block with:

```toml
[mcp_servers.super_productivity]
command = "node"
args = ["/absolute/path/to/super-productivity-mcp/dist/index.js"]
```

## Case B — Codex CLI in Terminal

Use this case only if you want to work from the Codex CLI. The Desktop procedure above does not
require the `codex` command.

1. In the same Terminal where you will use Codex, run:

   ```bash
   codex --version
   ```

   If Terminal prints `zsh: command not found: codex`, stop and use [Case A](#case-a--desktop-application).
   If you specifically want the CLI, install it using the
   [official Codex CLI instructions](https://learn.chatgpt.com/docs/codex/cli), open a new
   Terminal, and run `codex --version` again.

2. Once `codex --version` works, copy this complete command:

   ```bash
   codex mcp add super_productivity --env SP_API_URL=http://127.0.0.1:3876 --env SP_LOG_LEVEL=warn -- npx -y super-productivity-mcp-server
   ```

3. Verify the registration and start the CLI:

   ```bash
   codex mcp list
   codex
   ```

4. Inside Codex, type `/mcp` and ask:

   ```text
   Check the connection to Super Productivity with check_connection.
   ```

See [examples/codex-config.toml](examples/codex-config.toml) for the shared configuration format
and the [official OpenAI MCP setup documentation](https://learn.chatgpt.com/docs/extend/mcp) for
the current Codex configuration surfaces.

## Troubleshooting

### I cannot find “Enable local REST API”

Confirm that you are using the **desktop** app, not the web or mobile app, and that its version is
18.x or newer. Quit and update it from the [official Super Productivity releases](https://github.com/super-productivity/super-productivity/releases/latest),
then return to **Settings → Misc Settings**. This setting is not present in older desktop builds.

### I can enable the API, but I do not see a token

That is expected with the released Super Productivity 18.16.0 desktop app. Its local API is bound
to loopback and does not require a token, so leave `SP_API_TOKEN` unset. Do not use an npm or GitHub
token in its place. A future Super Productivity build may expose an Access Token; use it only when
the app itself displays one.

In `check_connection`, `configured: true` means the local API and renderer are ready. The separate
`tokenConfigured: false` field is expected for this no-token setup.

### `ECONNREFUSED 127.0.0.1:3876`

Super Productivity is closed, the local API is disabled, or the renderer has not finished starting.
Keep the desktop app open, enable the API, wait a few seconds, and retry `check_connection`.

### `401 Unauthorized`

This only applies when using a Super Productivity build that requires a Bearer token. Copy the
current Access Token from that app, set it as `SP_API_TOKEN`, and restart the MCP host. Do not use
the npm publication token here.

### The server does not appear in the MCP client

Check that Node.js 20 or newer is installed, that the command is exactly `npx` with arguments
`-y super-productivity-mcp-server`, and restart the MCP host. The server speaks MCP over STDIO, so
normal diagnostics go to stderr rather than appearing as a regular terminal application.

### Terminal says `zsh: command not found: codex`

That message only means the optional Codex CLI is unavailable in that Terminal. If you use the
Codex Desktop application, configure the server from **Settings → Configuration → Open config.toml**;
no `codex` command is needed. If you intended to use the CLI,
follow the [official Codex CLI installation instructions](https://learn.chatgpt.com/docs/codex/cli),
open a new Terminal, and confirm `codex --version` before running `codex mcp add`.

### I cannot find “MCP servers” in Desktop settings

That menu belongs to the **ChatGPT Desktop** MCP flow. The current Codex Desktop settings panel may
not expose it. In Codex Desktop, select **Configuration** in the settings sidebar and then choose
**Open config.toml**. Add the `[mcp_servers.super_productivity]` block from [Case A](#case-a--desktop-application),
restart Codex Desktop, and ask it to call `check_connection`.

### `check_connection` succeeds but no tasks are returned

Use `search_tasks` with a distinctive part of an existing task title. State-changing tools require
the exact `taskId` returned by that search; the server never guesses a task or bulk-imports issues.

## GitHub issue association

Call the tool explicitly with either form:

```text
ensure_github_issue_task({ issue: "Amorem/my-repo#123" })
ensure_github_issue_task({ issue: "https://github.com/Amorem/my-repo/issues/123", planToday: true })
```

The server searches active, archived, and completed local tasks. It reuses a task containing its
stable marker or exact issue URL. If no safe match exists, it creates one task with a marker and
returns its ID. Repeating the same call is idempotent. `planToday` defaults to `false` and must be
set explicitly.

The current Super Productivity local REST API does not expose writable GitHub provider fields in
its task PATCH allowlist. For that reason, tasks created by this server use a private, visible-in-
notes marker; native GitHub-linked tasks are recognized when the local API exposes an unambiguous
GitHub issue number. If two native tasks could match, the server returns an ambiguity error instead
of choosing silently. No GitHub token or GitHub network request is required by this server.

## Security model

- STDIO stdout is reserved for MCP protocol messages; diagnostics go to stderr.
- `SP_API_TOKEN` is optional; when supplied, it is never printed and is redacted in error/log paths.
- The configured API URL must be loopback unless `SP_ALLOW_NON_LOOPBACK_URL=true` is explicitly set.
- Super Productivity 18.16.0's local API has no application-level authentication. Keep the API on
  loopback and remember that local applications running as the same user can read and modify tasks.
- If a future build provides a local API token, protect the environment and configuration that can
  access it.
- The server does not import all GitHub issues, poll GitHub, or perform background actions.
- All task mutations require an exact `taskId`, except the explicit, idempotent GitHub association
  tool which creates at most one marked task.

## Architecture

```mermaid
sequenceDiagram
    participant Host as ChatGPT Desktop / Codex
    participant MCP as super-productivity-mcp-server
    participant SP as Super Productivity

    Host->>MCP: search_tasks({query})
    MCP->>SP: GET /tasks?query=...
    SP-->>MCP: task list with IDs
    MCP-->>Host: IDs and safe summaries
    Host->>MCP: plan_task_today({taskId})
    MCP->>SP: PATCH /tasks/:id {dueDay: today}
    Host->>MCP: start_task({taskId})
    MCP->>SP: POST /tasks/:id/start
    Host->>MCP: stop_timer() / complete_task({taskId})
    MCP->>SP: POST /task-control/stop or PATCH /tasks/:id
```

Implementation boundaries are intentionally narrow:

- `src/sp-client.ts` is the typed, timeout-bound REST client.
- `src/server.ts` contains MCP schemas and explicit tool behavior.
- `src/github.ts` parses and deduplicates issue references without GitHub network access.
- `src/config.ts`, `src/errors.ts`, and `src/logger.ts` enforce safe configuration and diagnostics.

## Development

```bash
pnpm install
pnpm verify
```

`pnpm verify` runs lint, formatting checks, strict TypeScript typechecking, unit/integration tests,
and the production build. The test suite uses mocked REST responses and the official MCP SDK's
in-memory transport; it never contacts Super Productivity or GitHub.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and
[SECURITY.md](SECURITY.md) for vulnerability reports.

## Roadmap

- Add a safe provider-aware lookup when Super Productivity exposes issue-provider configuration via
  the local API.
- Add optional GitHub metadata enrichment behind an explicit, separately configured connector.
- Add a small interactive setup command that validates the local API without storing the token.
- Add compatibility fixtures for each supported Super Productivity API revision.

## License

MIT. See [LICENSE](LICENSE).
