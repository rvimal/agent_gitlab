import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import ExcelJS from "exceljs";

const exec = promisify(execFile);
const MAIN = fileURLToPath(new URL("../src/main.js", import.meta.url));

const server = createServer((req, res) => {
  if (req.headers["private-token"] !== "fixture-token") {
    res.writeHead(401).end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const page = url.searchParams.get("page") ?? "1";
  const pathname = decodeURIComponent(url.pathname);
  const data = {
    "/api/v4/groups/1": { id: 1, name: "root" },
    "/api/v4/groups/2": { id: 2, name: "child" },
    "/api/v4/groups/1/subgroups": [{ id: 2 }],
    "/api/v4/groups/2/subgroups": [],
    "/api/v4/groups/2/projects": [],
    "/api/v4/projects/10": { id: 10, name: "app", default_branch: "main" },
    "/api/v4/projects/11": { id: 11, name: "empty", default_branch: null },
    "/api/v4/projects/10/repository/tree": [
      { type: "blob", path: ".gitlab-ci.yml" },
      { type: "blob", path: ".jenkins/Jenkinsfile" },
    ],
  };
  let next = "";
  if (pathname === "/api/v4/groups/1/projects") {
    data[pathname] = page === "1" ? [{ id: 10, name: "app" }] : [{ id: 11, name: "empty" }];
    next = page === "1" ? "2" : "";
  }
  let body;
  let type = "application/json";
  if (pathname === "/api/v4/projects/10/repository/files/.gitlab-ci.yml/raw") {
    body = "job:\n  script: echo ok\n";
    type = "text/plain";
  } else if (pathname in data) body = JSON.stringify(data[pathname]);
  else {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": type, "X-Next-Page": next }).end(body);
});

test("cli, mcp and reports end to end", async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(path.join(tmpdir(), "gitlab-"));
  try {
    const env = { ...process.env, GITLAB_URL: `http://127.0.0.1:${server.address().port}`, GITLAB_TOKEN: "fixture-token" };
    const run = (e, ...ids) => exec(process.execPath, [MAIN, "--group-ids", ...ids], { cwd: dir, env: e, timeout: 30000 })
      .then(() => ({ status: 0, stderr: "" }), (error) => ({ status: error.code, stderr: error.stderr }));

    let proc = await run(env, "1", "2");
    assert.equal(proc.status, 1, proc.stderr);
    const report = JSON.parse(await readFile(path.join(dir, "results.json"), "utf-8"));
    assert.equal(report.statistics.groups_discovered, 2);
    assert.equal(report.statistics.projects_discovered, 2);
    assert.equal(report.projects[0].Classification, "BOTH");
    assert.equal(report.projects[0]["Scan Status"], "SUCCESS");
    assert.equal(report.projects[1]["Scan Status"], "FAILED");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(dir, "results.xlsx"));
    assert.deepEqual(workbook.worksheets.map((w) => w.name), ["Projects", "Statistics", "Group Errors"]);
    assert.equal(workbook.getWorksheet("Projects").getCell("I2").value, "BOTH");

    proc = await run({ ...env, GITLAB_TOKEN: "invalid-token" }, "1");
    assert.equal(proc.status, 1, proc.stderr);
    const failed = await readFile(path.join(dir, "results.json"), "utf-8");
    assert.match(JSON.parse(failed).group_errors[0].error, /Authentication failed/);
    assert.ok(!failed.includes("invalid-token"));
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
