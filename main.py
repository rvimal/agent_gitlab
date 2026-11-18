"""Run discovery through the GitLab MCP server."""

import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
import sys

from dotenv import load_dotenv
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import TextContent

from discovery import discover
from report_generator import write_reports

LOG = logging.getLogger(__name__)


class MCPGitLab:
    def __init__(self, session):
        self.session = session

    async def call(self, tool, **arguments):
        result = await self.session.call_tool(tool, arguments)
        if result.isError:
            raise RuntimeError(f"MCP tool {tool} failed")
        payload = result.structuredContent
        if payload is None and len(result.content) == 1 and isinstance(result.content[0], TextContent):
            try:
                payload = json.loads(result.content[0].text)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Invalid JSON from MCP tool {tool}") from exc
        if not isinstance(payload, dict) or "error" not in payload or "data" not in payload:
            raise RuntimeError(f"Invalid response from MCP tool {tool}")
        if payload["error"]:
            raise RuntimeError(str(payload["error"]))
        return payload["data"]


async def run(group_ids):
    server = StdioServerParameters(
        command=sys.executable,
        args=[str(Path(__file__).resolve().with_name("mcp_server.py"))],
        env=dict(os.environ),
    )
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await discover(MCPGitLab(session), group_ids)


def main():
    parser = argparse.ArgumentParser(description="Discover GitLab CI/CD configuration")
    parser.add_argument("--group-ids", nargs="+", required=True, type=int, metavar="ID")
    args = parser.parse_args()
    if any(group_id <= 0 for group_id in args.group_ids):
        parser.error("group IDs must be positive integers")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    load_dotenv()
    if not os.getenv("GITLAB_URL") or not os.getenv("GITLAB_TOKEN"):
        LOG.error("Set GITLAB_URL and GITLAB_TOKEN in .env or the environment")
        return 2
    try:
        report = asyncio.run(run(args.group_ids))
        write_reports(report)
    except (OSError, RuntimeError) as exc:
        LOG.error("Discovery could not complete: %s", exc)
        return 2
    stats = report["statistics"]
    LOG.info("Discovered %s projects in %s groups; wrote results.json and results.xlsx",
             stats["projects_discovered"], stats["groups_discovered"])
    incomplete = stats["group_errors"] or stats["scan_statuses"]["FAILED"] or stats["scan_statuses"]["PARTIAL"]
    return 1 if incomplete else 0


if __name__ == "__main__":
    sys.exit(main())
