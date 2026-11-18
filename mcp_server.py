"""Expose read-only GitLab operations as FastMCP tools over stdio."""

import logging
import os

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

from gitlab_client import GitLabClient, GitLabError

load_dotenv()
logging.basicConfig(level=logging.INFO)
mcp = FastMCP("GitLab CI/CD Discovery")


def _call(method, *args):
    try:
        client = GitLabClient(os.getenv("GITLAB_URL"), os.getenv("GITLAB_TOKEN"))
        try:
            return {"data": getattr(client, method)(*args), "error": None}
        finally:
            client.session.close()
    except (GitLabError, ValueError) as exc:
        logging.warning("GitLab tool %s failed: %s", method, exc)
        return {"data": None, "error": str(exc)}


@mcp.tool()
def get_group(group_id: str) -> dict:
    """Fetch group details."""
    return _call("get_group", group_id)


@mcp.tool()
def list_subgroups(group_id: str) -> dict:
    """List immediate subgroups."""
    return _call("list_subgroups", group_id)


@mcp.tool()
def list_group_projects(group_id: str) -> dict:
    """List projects owned by a group, excluding shared projects."""
    return _call("list_group_projects", group_id)


@mcp.tool()
def get_project(project_id: str) -> dict:
    """Fetch project details."""
    return _call("get_project", project_id)


@mcp.tool()
def list_repository_files(project_id: str, ref: str) -> dict:
    """List the repository tree recursively at a ref."""
    return _call("list_repository_files", project_id, ref)


@mcp.tool()
def read_file(project_id: str, path: str, ref: str) -> dict:
    """Read a repository file at a ref."""
    return _call("read_file", project_id, path, ref)


if __name__ == "__main__":
    mcp.run(transport="stdio")
