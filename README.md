# GitLab CI/CD Discovery Agent

Discover projects in GitLab groups and classify their repository CI/CD configuration.
The CLI communicates over stdio with a read-only GitLab MCP server implemented with
the **Python MCP SDK's FastMCP**. The npm SDK is for JavaScript, so it is not required
by this Python application. No AI service or orchestration framework is used.

## Setup

Requires Python 3.11 or newer and network access to GitLab:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Set `GITLAB_URL` (the GitLab instance URL, optionally including its relative URL
prefix) and `GITLAB_TOKEN` in `.env`, or export them as environment variables.
Use a token with read-only `read_api` access and membership sufficient to view
the groups, projects and repositories. Existing environment variables take
precedence over `.env`. Never commit the token.

```bash
python main.py --group-ids 123 456 789
```

The command writes `results.json` and `results.xlsx` in the current directory,
overwriting existing files. JSON contains `statistics`, `group_errors`, and
`projects`. Excel contains Projects, Statistics, and Group Errors sheets.
Exit status is 0 for a complete scan, 1 for an incomplete scan, and 2 for
configuration or startup/reporting errors. Logging goes to stderr.

## Detection and limitations

Groups and owned projects are discovered recursively, with duplicate IDs skipped;
shared projects are excluded. Results are limited to what the token can see.
Group listing errors are reported separately because inaccessible projects cannot
be enumerated. The project rows contain the immediate owning group, project
details, file paths, classification, scan status and errors. Jenkins detection
looks for files named `Jenkinsfile` or `Jenkinsfile.*` anywhere in the repository,
excluding common documentation extensions and not mentions in documentation.

GitLab CI detection checks `.gitlab-ci.yml` and the project's configured CI path.
It follows local and accessible project includes recursively, including local
wildcards; included paths in another project are shown as `path@project:ref`.
Remote URLs and GitLab templates are recorded but not fetched. Dynamic includes,
external wildcard includes, inaccessible files, invalid YAML and missing files
are reported as partial scans. Include conditions are not evaluated, so all
statically declared includes are followed. A remote custom configuration
cannot be confirmed and does not by itself count as detected.

`SUCCESS` means the accessible tree and supported includes were inspected;
`PARTIAL` means some referenced configuration could not be inspected; `FAILED`
means the project or tree could not be inspected. Classifications reflect
confirmed files only, so `UNKNOWN` on an incomplete scan is not proof of no CI.
GitLab hides resources from unauthorized users, which cannot be detected by the
agent. API requests use timeouts and retry transient errors and rate limits.

The MCP server can also be started independently with `python mcp_server.py` and
exposes `get_group`, `list_subgroups`, `list_group_projects`, `get_project`,
`list_repository_files`, and `read_file`. It uses stdio transport and reads the
same environment variables.

## Tests

```bash
python -m unittest discover -s tests -v
```
