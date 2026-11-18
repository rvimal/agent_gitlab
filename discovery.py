"""Discover groups and inspect projects, retaining failures in the report."""

import logging
from collections import Counter, deque

from ci_detector import detect_ci

LOG = logging.getLogger(__name__)


async def discover(api, group_ids):
    queue = deque(str(group_id) for group_id in group_ids)
    visited = set()
    project_ids = set()
    rows = []
    group_errors = []
    successful_groups = 0
    while queue:
        group_id = queue.popleft()
        if group_id in visited:
            continue
        visited.add(group_id)
        try:
            group = await api.call("get_group", group_id=group_id)
        except RuntimeError as exc:
            group_errors.append({"group_id": group_id, "operation": "get_group", "error": str(exc)})
            LOG.warning("Group %s: %s", group_id, exc)
            continue
        successful_groups += 1
        canonical_id = str(group["id"])
        visited.add(canonical_id)
        try:
            subgroups = await api.call("list_subgroups", group_id=canonical_id)
            queue.extend(str(subgroup["id"]) for subgroup in subgroups)
        except RuntimeError as exc:
            group_errors.append({"group_id": canonical_id, "operation": "list_subgroups", "error": str(exc)})
            LOG.warning("Group %s subgroups: %s", canonical_id, exc)
        try:
            projects = await api.call("list_group_projects", group_id=canonical_id)
        except RuntimeError as exc:
            group_errors.append({"group_id": canonical_id, "operation": "list_group_projects", "error": str(exc)})
            LOG.warning("Group %s projects: %s", canonical_id, exc)
            continue
        for project in projects:
            project_id = str(project["id"])
            if project_id in project_ids:
                continue
            project_ids.add(project_id)
            rows.append(await inspect_project(api, group, project))

    classifications = Counter(row["Classification"] for row in rows)
    statuses = Counter(row["Scan Status"] for row in rows)
    stats = {
        "groups_attempted": len(visited),
        "groups_discovered": successful_groups,
        "group_errors": len(group_errors),
        "projects_discovered": len(rows),
        "classifications": {name: classifications[name] for name in ("JENKINS", "GITLAB_CI", "BOTH", "UNKNOWN")},
        "scan_statuses": {name: statuses[name] for name in ("SUCCESS", "PARTIAL", "FAILED")},
    }
    return {"statistics": stats, "group_errors": group_errors, "projects": rows}


async def inspect_project(api, group, summary):
    row = {
        "Group ID": group["id"], "Group Name": group.get("full_path") or group.get("name", ""),
        "Project ID": summary["id"], "Project Name": summary.get("name", ""),
        "Project URL": summary.get("web_url", ""), "Default Branch": "",
        "Jenkins Detected": False, "GitLab CI Detected": False,
        "Classification": "UNKNOWN", "Jenkins Files": [], "GitLab CI Files": [],
        "Scan Status": "FAILED", "Error Message": "",
    }
    try:
        project = await api.call("get_project", project_id=str(summary["id"]))
        row["Project Name"] = project.get("name", row["Project Name"])
        row["Project URL"] = project.get("web_url", row["Project URL"])
        branch = project.get("default_branch")
        if not branch:
            raise RuntimeError("No default branch; repository may be empty or inaccessible")
        row["Default Branch"] = branch
        tree = await api.call("list_repository_files", project_id=str(summary["id"]), ref=branch)
        jenkins, ci_files, ci_detected, errors = await detect_ci(api, project, branch, tree)
        row["Jenkins Files"] = jenkins
        row["GitLab CI Files"] = ci_files
        row["Jenkins Detected"] = bool(jenkins)
        row["GitLab CI Detected"] = ci_detected
        row["Classification"] = (
            "BOTH" if jenkins and ci_detected else
            "JENKINS" if jenkins else "GITLAB_CI" if ci_detected else "UNKNOWN"
        )
        row["Scan Status"] = "PARTIAL" if errors else "SUCCESS"
        row["Error Message"] = "; ".join(errors)
    except RuntimeError as exc:
        row["Error Message"] = str(exc)
        LOG.warning("Project %s: %s", summary["id"], exc)
    return row
