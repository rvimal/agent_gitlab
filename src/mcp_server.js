// Expose read-only GitLab operations as MCP tools over stdio using FastMCP.
import dotenv from "dotenv";
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { GitLabClient, GitLabError } from "./gitlab_client.js";

dotenv.config({ quiet: true });

async function call(method, ...args) {
  let result;
  try {
    const client = new GitLabClient(process.env.GITLAB_URL, process.env.GITLAB_TOKEN);
    result = { data: await client[method](...args), error: null };
  } catch (error) {
    if (!(error instanceof GitLabError) && !/required/.test(error.message)) throw error;
    console.error(`GitLab tool ${method} failed: ${error.message}`);
    result = { data: null, error: error.message };
  }
  return JSON.stringify(result);
}

const server = new FastMCP({ name: "GitLab CI/CD Discovery", version: "1.0.0" });
const tools = [
  ["get_group", "Fetch group details.", { group_id: z.string() }, ({ group_id }) => [group_id]],
  ["list_subgroups", "List immediate subgroups.", { group_id: z.string() }, ({ group_id }) => [group_id]],
  ["list_group_projects", "List projects owned by a group, excluding shared projects.",
    { group_id: z.string() }, ({ group_id }) => [group_id]],
  ["get_project", "Fetch project details.", { project_id: z.string() }, ({ project_id }) => [project_id]],
  ["list_repository_files", "List the repository tree recursively at a ref.",
    { project_id: z.string(), ref: z.string() }, ({ project_id, ref }) => [project_id, ref]],
  ["read_file", "Read a repository file at a ref.",
    { project_id: z.string(), path: z.string(), ref: z.string() },
    ({ project_id, path, ref }) => [project_id, path, ref]],
];
for (const [name, description, shape, toArgs] of tools) {
  server.addTool({
    name,
    description,
    parameters: z.object(shape),
    execute: (args) => call(name, ...toArgs(args)),
  });
}

server.start({ transportType: "stdio" });
