# GitLab CI/CD Discovery MCP Server

A read-only GitLab MCP server built with **FastMCP** and **axios** (stdio transport).

## Setup

Requires Node.js 20+:

```bash
npm install
cp .env.example .env
```

Set `GITLAB_URL` and `GITLAB_TOKEN` (read-only `read_api` token) in `.env`. For a
GitLab instance using a private CA, set `GITLAB_CA_CERT` to the CA certificate (PEM) path.

```bash
npm start
```

Tools: `get_group`, `list_subgroups`, `list_group_projects`, `get_project`,
`list_repository_files`, `read_file`. Each returns JSON `{data, error}`.

## OpenCode

`opencode.json` registers the server; `.opencode/agent/gitlab-analyst.md` defines the
`gitlab-analyst` agent, which analyses CI/CD (GitLab CI, Jenkins) through these tools.
