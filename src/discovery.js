// Discover groups and inspect projects, retaining failures in the report.
import { detectCi } from "./ci_detector.js";

const warn = (message) => console.error(`WARNING: ${message}`);

const count = (rows, field, names) =>
  Object.fromEntries(names.map((name) => [name, rows.filter((r) => r[field] === name).length]));

export async function discover(api, groupIds) {
  const queue = groupIds.map(String);
  const visited = new Set();
  const projectIds = new Set();
  const rows = [];
  const groupErrors = [];
  let successfulGroups = 0;
  while (queue.length) {
    const groupId = queue.shift();
    if (visited.has(groupId)) continue;
    visited.add(groupId);
    let group;
    try {
      group = await api.call("get_group", { group_id: groupId });
    } catch (error) {
      groupErrors.push({ group_id: groupId, operation: "get_group", error: error.message });
      warn(`Group ${groupId}: ${error.message}`);
      continue;
    }
    successfulGroups++;
    const canonicalId = String(group.id);
    visited.add(canonicalId);
    try {
      const subgroups = await api.call("list_subgroups", { group_id: canonicalId });
      queue.push(...subgroups.map((s) => String(s.id)));
    } catch (error) {
      groupErrors.push({ group_id: canonicalId, operation: "list_subgroups", error: error.message });
      warn(`Group ${canonicalId} subgroups: ${error.message}`);
    }
    let projects;
    try {
      projects = await api.call("list_group_projects", { group_id: canonicalId });
    } catch (error) {
      groupErrors.push({ group_id: canonicalId, operation: "list_group_projects", error: error.message });
      warn(`Group ${canonicalId} projects: ${error.message}`);
      continue;
    }
    for (const project of projects) {
      const projectId = String(project.id);
      if (projectIds.has(projectId)) continue;
      projectIds.add(projectId);
      rows.push(await inspectProject(api, group, project));
    }
  }

  const statistics = {
    groups_attempted: visited.size,
    groups_discovered: successfulGroups,
    group_errors: groupErrors.length,
    projects_discovered: rows.length,
    classifications: count(rows, "Classification", ["JENKINS", "GITLAB_CI", "BOTH", "UNKNOWN"]),
    scan_statuses: count(rows, "Scan Status", ["SUCCESS", "PARTIAL", "FAILED"]),
  };
  return { statistics, group_errors: groupErrors, projects: rows };
}

export async function inspectProject(api, group, summary) {
  const row = {
    "Group ID": group.id, "Group Name": group.full_path || group.name || "",
    "Project ID": summary.id, "Project Name": summary.name ?? "",
    "Project URL": summary.web_url ?? "", "Default Branch": "",
    "Jenkins Detected": false, "GitLab CI Detected": false,
    Classification: "UNKNOWN", "Jenkins Files": [], "GitLab CI Files": [],
    "Scan Status": "FAILED", "Error Message": "",
  };
  try {
    const project = await api.call("get_project", { project_id: String(summary.id) });
    row["Project Name"] = project.name ?? row["Project Name"];
    row["Project URL"] = project.web_url ?? row["Project URL"];
    const branch = project.default_branch;
    if (!branch) throw new Error("No default branch; repository may be empty or inaccessible");
    row["Default Branch"] = branch;
    const tree = await api.call("list_repository_files", { project_id: String(summary.id), ref: branch });
    const [jenkins, ciFiles, ciDetected, errors] = await detectCi(api, project, branch, tree);
    row["Jenkins Files"] = jenkins;
    row["GitLab CI Files"] = ciFiles;
    row["Jenkins Detected"] = jenkins.length > 0;
    row["GitLab CI Detected"] = ciDetected;
    row.Classification = jenkins.length && ciDetected ? "BOTH"
      : jenkins.length ? "JENKINS" : ciDetected ? "GITLAB_CI" : "UNKNOWN";
    row["Scan Status"] = errors.length ? "PARTIAL" : "SUCCESS";
    row["Error Message"] = errors.join("; ");
  } catch (error) {
    row["Error Message"] = error.message;
    warn(`Project ${summary.id}: ${error.message}`);
  }
  return row;
}
