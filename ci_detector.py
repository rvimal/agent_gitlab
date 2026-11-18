"""Identify Jenkins files and recursively follow GitLab CI includes."""

import fnmatch
from functools import lru_cache
import posixpath

import yaml


class GitLabLoader(yaml.SafeLoader):
    """Safe YAML loader with GitLab's !reference tag."""


def _reference(loader, node):
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node)
    return loader.construct_scalar(node)


GitLabLoader.add_constructor("!reference", _reference)


def _path(value):
    return posixpath.normpath(value.lstrip("/"))


def _jenkins(path):
    name = posixpath.basename(path)
    return name == "Jenkinsfile" or (
        name.startswith("Jenkinsfile.")
        and not name.lower().endswith((".md", ".markdown", ".rst", ".txt", ".adoc", ".html"))
    )


def _matches(path, pattern):
    parts = path.split("/")
    patterns = pattern.split("/")

    @lru_cache(maxsize=None)
    def match(i, j):
        if j == len(patterns):
            return i == len(parts)
        if patterns[j] == "**":
            return match(i, j + 1) or (i < len(parts) and match(i + 1, j))
        return (i < len(parts) and fnmatch.fnmatchcase(parts[i], patterns[j])
                and match(i + 1, j + 1))

    return match(0, 0)


async def detect_ci(api, project, branch, tree):
    """Return Jenkins paths, CI paths, detection flag, and inspection errors."""
    project_id = str(project["id"])
    paths = {e["path"] for e in tree if e.get("type") == "blob" and e.get("path")}
    jenkins = sorted(p for p in paths if _jenkins(p))
    ci_files = set()
    errors = []
    pending = []
    visited = set()
    detected = False

    if ".gitlab-ci.yml" in paths:
        pending.append((project_id, branch, ".gitlab-ci.yml", True, True))
    custom = project.get("ci_config_path")
    if custom:
        if custom.startswith(("http://", "https://")):
            ci_files.add(custom)
            errors.append(f"Remote custom CI configuration not inspected: {custom}")
        elif "@" in custom:
            path, target = custom.rsplit("@", 1)
            source, separator, ref = target.partition(":")
            if not path or not source or (separator and not ref):
                errors.append(f"Invalid custom CI configuration path: {custom}")
            else:
                pending.append((source, ref or None, _path(path), False, True))
        else:
            pending.append((project_id, branch, _path(custom), True, True))

    while pending:
        source, ref, path, local, root = pending.pop()
        label = path if local else f"{path}@{source}:{ref or 'default'}"
        key = (source, ref, path)
        if key in visited:
            continue
        visited.add(key)
        ci_files.add(label)
        if local and path not in paths:
            errors.append(f"CI configuration file not found: {path}")
            continue
        if local and root:
            detected = True
        try:
            if not ref:
                details = await api.call("get_project", project_id=source)
                ref = details.get("default_branch")
                if not ref:
                    raise RuntimeError(f"No default branch for project {source}")
            content = await api.call("read_file", project_id=source, path=path, ref=ref)
            if root:
                detected = True
            document = yaml.load(content, Loader=GitLabLoader)
        except (RuntimeError, yaml.YAMLError) as exc:
            errors.append(f"Cannot inspect CI configuration {label}: {exc}")
            continue
        if document is None:
            continue
        if not isinstance(document, dict):
            errors.append(f"CI configuration is not a mapping: {label}")
            continue
        includes = document.get("include", [])
        if not isinstance(includes, list):
            includes = [includes]
        for include in includes:
            if isinstance(include, str):
                include = {"local": include}
            if not isinstance(include, dict):
                errors.append(f"Unsupported include in {label}")
                continue
            if "local" in include:
                value = include["local"]
                if not isinstance(value, str) or "$" in value:
                    errors.append(f"Unresolvable local include in {label}: {value}")
                    continue
                include_path = _path(value)
                if any(c in include_path for c in "*?["):
                    if not local:
                        errors.append(f"Cannot expand external include pattern in {label}: {value}")
                        continue
                    matches = sorted(p for p in paths if _matches(p, include_path))
                    if not matches:
                        errors.append(f"Include pattern has no matches in {label}: {value}")
                    pending.extend((source, ref, p, local, False) for p in matches)
                else:
                    pending.append((source, ref, include_path, local, False))
            elif "project" in include and "file" in include:
                external = include["project"]
                external_ref = include.get("ref")
                files = include["file"]
                if not isinstance(files, list):
                    files = [files]
                if not isinstance(external, str) or (
                    external_ref is not None and not isinstance(external_ref, str)
                ) or "$" in external or (external_ref and "$" in external_ref):
                    errors.append(f"Unresolvable project include in {label}")
                    continue
                for file in files:
                    if not isinstance(file, str) or "$" in file or any(c in file for c in "*?["):
                        errors.append(f"Unresolvable project include file in {label}: {file}")
                    else:
                        pending.append((external, external_ref, _path(file), False, False))
            elif "remote" in include or "template" in include:
                kind = "remote" if "remote" in include else "template"
                value = include[kind]
                if isinstance(value, str):
                    ci_files.add(f"{kind}:{value}")
                errors.append(f"{kind.capitalize()} include not inspected in {label}: {value}")
            else:
                errors.append(f"Unsupported include in {label}")
    return jenkins, sorted(ci_files), detected, errors
