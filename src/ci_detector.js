// Identify Jenkins files and recursively follow GitLab CI includes.
import path from "node:path/posix";
import { parse } from "yaml";

// GitLab's !reference tag: keep the node's plain value.
const reference = (tag, collection) => ({ tag, collection, resolve: (node) => node.toJSON() });
const CUSTOM_TAGS = [
  reference("!reference", "seq"),
  reference("!reference", "map"),
  { tag: "!reference", resolve: (value) => value },
];

const normalize = (value) => path.normalize(value.replace(/^\/+/, ""));

const DOC_EXTENSIONS = [".md", ".markdown", ".rst", ".txt", ".adoc", ".html"];

function isJenkins(file) {
  const name = path.basename(file);
  return name === "Jenkinsfile" || (
    name.startsWith("Jenkinsfile.") && !DOC_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))
  );
}

// fnmatch-style single path segment glob.
function segmentRegex(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") source += ".*";
    else if (c === "?") source += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end === -1) source += "\\[";
      else {
        let set = pattern.slice(i + 1, end);
        if (set[0] === "!") set = "^" + set.slice(1);
        source += `[${set.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else source += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "s");
}

// GitLab globs: "**" matches zero or more directories.
export function matches(file, pattern) {
  const parts = file.split("/");
  const patterns = pattern.split("/");
  const regexes = patterns.map((p) => (p === "**" ? null : segmentRegex(p)));
  const memo = new Map();
  const match = (i, j) => {
    const key = i * (patterns.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (j === patterns.length) result = i === parts.length;
    else if (patterns[j] === "**") result = match(i, j + 1) || (i < parts.length && match(i + 1, j));
    else result = i < parts.length && regexes[j].test(parts[i]) && match(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

const hasGlob = (value) => /[*?[]/.test(value);
const isString = (value) => typeof value === "string";
const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Returns [jenkinsPaths, ciPaths, detected, errors].
export async function detectCi(api, project, branch, tree) {
  const projectId = String(project.id);
  const paths = new Set(tree.filter((e) => e.type === "blob" && e.path).map((e) => e.path));
  const jenkins = [...paths].filter(isJenkins).sort();
  const ciFiles = new Set();
  const errors = [];
  const pending = [];
  const visited = new Set();
  let detected = false;

  if (paths.has(".gitlab-ci.yml")) {
    pending.push([projectId, branch, ".gitlab-ci.yml", true, true]);
  }
  const custom = project.ci_config_path;
  if (custom) {
    if (/^https?:\/\//.test(custom)) {
      ciFiles.add(custom);
      errors.push(`Remote custom CI configuration not inspected: ${custom}`);
    } else if (custom.includes("@")) {
      const at = custom.lastIndexOf("@");
      const file = custom.slice(0, at);
      const target = custom.slice(at + 1);
      const colon = target.indexOf(":");
      const source = colon === -1 ? target : target.slice(0, colon);
      const ref = colon === -1 ? "" : target.slice(colon + 1);
      if (!file || !source || (colon !== -1 && !ref)) {
        errors.push(`Invalid custom CI configuration path: ${custom}`);
      } else {
        pending.push([source, ref || null, normalize(file), false, true]);
      }
    } else {
      pending.push([projectId, branch, normalize(custom), true, true]);
    }
  }

  while (pending.length) {
    let [source, ref, file, local, root] = pending.pop();
    const label = local ? file : `${file}@${source}:${ref || "default"}`;
    const key = JSON.stringify([source, ref, file]);
    if (visited.has(key)) continue;
    visited.add(key);
    ciFiles.add(label);
    if (local && !paths.has(file)) {
      errors.push(`CI configuration file not found: ${file}`);
      continue;
    }
    if (local && root) detected = true;
    let document;
    try {
      if (!ref) {
        const details = await api.call("get_project", { project_id: source });
        ref = details.default_branch;
        if (!ref) throw new Error(`No default branch for project ${source}`);
      }
      const content = await api.call("read_file", { project_id: source, path: file, ref });
      if (root) detected = true;
      document = parse(content, { customTags: CUSTOM_TAGS });
    } catch (error) {
      errors.push(`Cannot inspect CI configuration ${label}: ${error.message}`);
      continue;
    }
    if (document === null || document === undefined) continue;
    if (!isMapping(document)) {
      errors.push(`CI configuration is not a mapping: ${label}`);
      continue;
    }
    let includes = document.include ?? [];
    if (!Array.isArray(includes)) includes = [includes];
    for (let include of includes) {
      if (isString(include)) include = { local: include };
      if (!isMapping(include)) {
        errors.push(`Unsupported include in ${label}`);
        continue;
      }
      if ("local" in include) {
        const value = include.local;
        if (!isString(value) || value.includes("$")) {
          errors.push(`Unresolvable local include in ${label}: ${value}`);
          continue;
        }
        const includePath = normalize(value);
        if (hasGlob(includePath)) {
          if (!local) {
            errors.push(`Cannot expand external include pattern in ${label}: ${value}`);
            continue;
          }
          const found = [...paths].filter((p) => matches(p, includePath)).sort();
          if (!found.length) errors.push(`Include pattern has no matches in ${label}: ${value}`);
          for (const p of found) pending.push([source, ref, p, local, false]);
        } else {
          pending.push([source, ref, includePath, local, false]);
        }
      } else if ("project" in include && "file" in include) {
        const external = include.project;
        const externalRef = include.ref;
        const files = Array.isArray(include.file) ? include.file : [include.file];
        if (!isString(external) || (externalRef != null && !isString(externalRef))
            || external.includes("$") || (externalRef && externalRef.includes("$"))) {
          errors.push(`Unresolvable project include in ${label}`);
          continue;
        }
        for (const f of files) {
          if (!isString(f) || f.includes("$") || hasGlob(f)) {
            errors.push(`Unresolvable project include file in ${label}: ${f}`);
          } else {
            pending.push([external, externalRef ?? null, normalize(f), false, false]);
          }
        }
      } else if ("remote" in include || "template" in include) {
        const kind = "remote" in include ? "remote" : "template";
        const value = include[kind];
        if (isString(value)) ciFiles.add(`${kind}:${value}`);
        errors.push(`${kind[0].toUpperCase()}${kind.slice(1)} include not inspected in ${label}: ${value}`);
      } else {
        errors.push(`Unsupported include in ${label}`);
      }
    }
  }
  return [jenkins, [...ciFiles].sort(), detected, errors];
}
