---
title: Research GitHub with an MCP Server
description: Connect GitHub's read-only MCP server and use it to investigate a repository task
guideLevel: advanced
order: 7
---

# Research GitHub with an MCP Server

This guide connects Agav to GitHub's official MCP server, then uses its read-only tools to investigate an issue before changing local code. It is a practical companion to [Model Context Protocol](/features/mcp), which explains Agav's MCP support without repeating this setup.

## Agav commands used in this guide

| Command | Intent |
| --- | --- |
| `/debug` | Confirm that Agav started the GitHub server and discovered its MCP capabilities. |

## 1. Prepare a read-only GitHub connection

GitHub's local MCP server runs in Docker. Install and start Docker, then create a GitHub personal access token with only the repository access needed for the repositories you will inspect. Keep the token out of project configuration and version control.

In the terminal that will start Agav, export the token and restrict the server to repository and issue tools:

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN="your-token"
export GITHUB_TOOLSETS="repos,issues"
```

The read-only switch prevents the GitHub MCP server from exposing write tools, even when its enabled toolsets include them. See GitHub's [local server prerequisites and token guidance](https://github.com/github/github-mcp-server#local-github-mcp-server) before choosing token permissions.

Add the following server definition to `./.agav/config.json`. This file is project-specific; use `~/.agav/config.json` instead when you want the connection available in every project.

```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "-e",
        "GITHUB_TOOLSETS",
        "-e",
        "GITHUB_READ_ONLY=1",
        "ghcr.io/github/github-mcp-server"
      ]
    }
  }
}
```

The `-e` entries pass the exported values into Docker; they do not put the token in the configuration file. Agav merges the global configuration first and then the project configuration, so a project server with the same name overrides its global definition. Restart Agav after changing MCP configuration.

## 2. Verify the server

Run `/debug`. Under **MCP servers**, confirm that `github` is listed. If it is not, first run the Docker command from the configuration directly in your terminal to check that Docker is running and that the exported token is available. MCP startup failures do not prevent Agav from starting, so `/debug` is the quickest way to distinguish an unavailable server from a normal Agav session.

## 3. Use GitHub tools for a repository task

Ask Agav to use the GitHub tools explicitly and to keep all GitHub activity read-only. For example, before fixing a local scraper failure:

```text
Use the GitHub MCP tools to inspect open issues in quora/model-deprecation-tracker
about provider coverage or scraper failures. Read the most relevant issue and
its linked pull requests, then summarize the expected behavior, affected files,
and any implementation constraints. Do not modify GitHub or local files yet.
```

Agav can use the discovered issue and repository tools to gather the upstream context, then return a local implementation plan. Follow up with a scoped request such as:

```text
Using that issue summary, inspect this checkout and propose the smallest local
change. Show the files you would edit and wait for approval before editing.
```

This separates external research from local changes: GitHub remains read-only, while Agav's normal permission mode still controls edits and shell commands in the checkout.

## Troubleshooting and scope

| Symptom | What to check |
| --- | --- |
| `github` is absent from `/debug` | Docker is running, the image can be pulled, and `GITHUB_PERSONAL_ACCESS_TOKEN` is exported in the same terminal session that starts Agav. |
| GitHub requests are unauthorized | Recreate or adjust the token with the minimum access required for the target repository, then restart Agav. |
| Too many unrelated tools appear | Keep `GITHUB_TOOLSETS` limited to the task, such as `repos,issues`; GitHub documents the available toolsets and individual-tool options. |
| You need to create or update GitHub content | Remove read-only mode only after reviewing the required token permissions and the task's intended write scope. |

Agav currently accepts stdio subprocess MCP configuration. GitHub also offers other transports, but those do not use Agav's `mcpServers` configuration shape. For server options such as toolsets and read-only mode, see the [GitHub MCP server documentation](https://github.com/github/github-mcp-server#read-only-mode).
