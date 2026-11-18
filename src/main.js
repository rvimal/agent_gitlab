#!/usr/bin/env node
// Run discovery through the GitLab MCP server.
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import dotenv from "dotenv";
import { discover } from "./discovery.js";
import { writeReports } from "./report_generator.js";

const USAGE = "Usage: main.js (--group-ids ID [ID ...] | --groups-file JSON)";

class MCPGitLab {
  constructor(client) {
    this.client = client;
  }

  async call(tool, args) {
    const result = await this.client.callTool({ name: tool, arguments: args });
    if (result.isError) throw new Error(`MCP tool ${tool} failed`);
    let payload = result.structuredContent;
    if (!payload && result.content?.length === 1 && result.content[0].type === "text") {
      try {
        payload = JSON.parse(result.content[0].text);
      } catch {
        throw new Error(`Invalid JSON from MCP tool ${tool}`);
      }
    }
    if (!payload || typeof payload !== "object" || !("error" in payload) || !("data" in payload)) {
      throw new Error(`Invalid response from MCP tool ${tool}`);
    }
    if (payload.error) throw new Error(String(payload.error));
    return payload.data;
  }
}

async function run(groupIds) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./mcp_server.js", import.meta.url))],
    env: { ...process.env },
    stderr: "inherit",
  });
  const client = new Client({ name: "gitlab-discovery", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await discover(new MCPGitLab(client), groupIds);
  } finally {
    await client.close();
  }
}

const isId = (item) => (typeof item === "number" && Number.isInteger(item)) || (typeof item === "string" && /^\d+$/.test(item));

export async function loadGroupIds(file) {
  let data = JSON.parse(await readFile(file, "utf-8"));
  if (data && !Array.isArray(data) && typeof data === "object") data = data.group_ids ?? data.groups;
  if (!Array.isArray(data) || !data.length) throw new Error("expected a non-empty 'group_ids' list");
  return data.map((item) => {
    if (item && typeof item === "object") item = item.group_id ?? item.id;
    if (!isId(item)) throw new Error(`invalid group ID: ${JSON.stringify(item)}`);
    return Number(item);
  });
}

function fail(message) {
  console.error(`${USAGE}\nerror: ${message}`);
  return 2;
}

async function parseArgs(argv) {
  const [flag, ...values] = argv;
  if (flag === "--group-ids") {
    if (!values.length || !values.every((v) => /^-?\d+$/.test(v))) throw new Error("--group-ids requires integer IDs");
    return values.map(Number);
  }
  if (flag === "--groups-file" && values.length === 1) {
    try {
      return await loadGroupIds(values[0]);
    } catch (error) {
      throw new Error(`invalid groups file: ${error.message}`);
    }
  }
  throw new Error("exactly one of --group-ids or --groups-file is required");
}

export async function main(argv) {
  let groupIds;
  try {
    groupIds = await parseArgs(argv);
    if (groupIds.some((id) => id <= 0)) throw new Error("group IDs must be positive integers");
  } catch (error) {
    return fail(error.message);
  }
  dotenv.config({ quiet: true });
  if (!process.env.GITLAB_URL || !process.env.GITLAB_TOKEN) {
    console.error("ERROR: Set GITLAB_URL and GITLAB_TOKEN in .env or the environment");
    return 2;
  }
  let report;
  try {
    report = await run(groupIds);
    await writeReports(report);
  } catch (error) {
    console.error(`ERROR: Discovery could not complete: ${error.message}`);
    return 2;
  }
  const stats = report.statistics;
  console.error(`INFO: Discovered ${stats.projects_discovered} projects in ${stats.groups_discovered} groups; wrote results.json and results.xlsx`);
  const incomplete = stats.group_errors || stats.scan_statuses.FAILED || stats.scan_statuses.PARTIAL;
  return incomplete ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
