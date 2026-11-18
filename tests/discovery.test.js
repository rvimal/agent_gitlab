import assert from "node:assert/strict";
import { test } from "node:test";
import { detectCi, matches } from "../src/ci_detector.js";
import { discover, inspectProject } from "../src/discovery.js";
import { GitLabClient, GitLabError } from "../src/gitlab_client.js";

class FakeAPI {
  constructor(data) {
    this.data = data;
    this.calls = [];
  }

  async call(tool, args) {
    this.calls.push([tool, args]);
    const key = JSON.stringify([tool, ...Object.values(args)]);
    if (!(key in this.data)) throw new Error(`unexpected call ${key}`);
    const value = this.data[key];
    if (value instanceof Error) throw value;
    return value;
  }
}
const k = (...parts) => JSON.stringify(parts);
const blobs = (paths) => paths.map((path) => ({ type: "blob", path }));

test("recursive deduplication and failures", async () => {
  const api = new FakeAPI({
    [k("get_group", "1")]: { id: 1, name: "root" },
    [k("get_group", "2")]: { id: 2, name: "child" },
    [k("get_group", "3")]: new Error("permission denied"),
    [k("list_subgroups", "1")]: [{ id: 2 }, { id: 3 }],
    [k("list_subgroups", "2")]: [{ id: 1 }],
    [k("list_group_projects", "1")]: [{ id: 10, name: "broken" }],
    [k("list_group_projects", "2")]: [{ id: 10 }, { id: 11, name: "good" }],
    [k("get_project", "10")]: new Error("inaccessible"),
    [k("get_project", "11")]: { id: 11, default_branch: "main" },
    [k("list_repository_files", "11", "main")]: blobs(["README.md"]),
  });
  const report = await discover(api, [1, 2, 1]);
  assert.equal(report.statistics.groups_discovered, 2);
  assert.equal(report.statistics.projects_discovered, 2);
  assert.equal(report.statistics.group_errors, 1);
  assert.deepEqual(report.projects.map((r) => r["Scan Status"]), ["FAILED", "SUCCESS"]);
  assert.equal(report.projects[1].Classification, "UNKNOWN");
  assert.equal(api.calls.filter(([t, a]) => t === "get_project" && a.project_id === "10").length, 1);
});

test("detects nested includes and ignores docs", async () => {
  const api = new FakeAPI({
    [k("read_file", "1", ".gitlab-ci.yml", "main")]:
      "include:\n  - local: /ci/*.yml\n  - project: team/shared\n    file: /base.yml\n",
    [k("read_file", "1", "ci/build.yml", "main")]: "include: /ci/extra.yml\n",
    [k("read_file", "1", "ci/extra.yml", "main")]: "job:\n  script: echo ok\n",
    [k("get_project", "team/shared")]: { default_branch: "stable" },
    [k("read_file", "team/shared", "base.yml", "stable")]: "job: !reference [.base, script]\n",
  });
  const tree = blobs([".gitlab-ci.yml", "ci/build.yml", "ci/extra.yml", "jenkins/Jenkinsfile", "README.md"]);
  const [jenkins, files, detected, errors] = await detectCi(api, { id: 1 }, "main", tree);
  assert.deepEqual(jenkins, ["jenkins/Jenkinsfile"]);
  assert.ok(detected);
  assert.deepEqual(files, [".gitlab-ci.yml", "base.yml@team/shared:default", "ci/build.yml", "ci/extra.yml"]);
  assert.deepEqual(errors, []);
});

test("missing custom and remote include are partial", async () => {
  const api = new FakeAPI({
    [k("read_file", "1", ".gitlab-ci.yml", "main")]: "include:\n  - remote: https://example.com/ci.yml\n",
  });
  const [, files, detected, errors] = await detectCi(
    api, { id: 1, ci_config_path: "missing.yml" }, "main", blobs([".gitlab-ci.yml"]));
  assert.ok(detected);
  assert.ok(files.includes("missing.yml"));
  assert.equal(errors.length, 2);
});

test("missing custom is not confirmation", async () => {
  const [, , detected, errors] = await detectCi(
    new FakeAPI({}), { id: 1, ci_config_path: "missing.yml" }, "main", []);
  assert.equal(detected, false);
  assert.ok(errors.length);
});

test("project classifications and documentation", async () => {
  const cases = [
    [["Jenkinsfile"], "JENKINS"],
    [[".gitlab-ci.yml"], "GITLAB_CI"],
    [[".jenkins/Jenkinsfile", ".gitlab-ci.yml"], "BOTH"],
    [["README.md", "Jenkinsfile.md"], "UNKNOWN"],
  ];
  for (const [paths, expected] of cases) {
    const data = {
      [k("get_project", "1")]: { id: 1, default_branch: "main" },
      [k("list_repository_files", "1", "main")]: blobs(paths),
    };
    if (paths.includes(".gitlab-ci.yml")) data[k("read_file", "1", ".gitlab-ci.yml", "main")] = "job: {script: echo ok}";
    const row = await inspectProject(new FakeAPI(data), { id: 2 }, { id: 1 });
    assert.equal(row.Classification, expected);
    assert.equal(row["Scan Status"], "SUCCESS");
  }
});

test("gitlab globs match zero or more directories", () => {
  assert.ok(matches("ci/build.yml", "ci/**/*.yml"));
  assert.ok(matches("ci/deep/build.yml", "ci/**/*.yml"));
  assert.ok(!matches("ci/deep/build.yml", "ci/*.yml"));
});

test("missing pagination header and invalid next page", async () => {
  const client = new GitLabClient("https://gitlab.example", "token");
  const pages = [[Array.from({ length: 100 }, (_, i) => i), new Headers()], [[100], new Headers()]];
  client._get = async () => pages.shift();
  assert.equal((await client._pages("/test")).length, 101);
  client._get = async () => [[], new Headers({ "X-Next-Page": "1" })];
  await assert.rejects(client._pages("/test"), GitLabError);
});
