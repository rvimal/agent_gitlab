// Read-only GitLab REST API access.

export class GitLabError extends Error {
  // An API error safe to include in a report.
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const REASONS = {
  401: "Authentication failed",
  403: "Permission denied",
  404: "Resource not found or inaccessible",
  429: "Rate limit exceeded after retries",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GitLabClient {
  constructor(url, token, { timeout = 30000, retries = 3, backoff = 1000 } = {}) {
    if (!url || !token) throw new Error("GITLAB_URL and GITLAB_TOKEN are required");
    this.baseUrl = `${url.replace(/\/+$/, "")}/api/v4`;
    this.token = token;
    this.timeout = timeout;
    this.retries = retries;
    this.backoff = backoff;
  }

  async #fetch(path, params) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetch(url, {
          headers: { "PRIVATE-TOKEN": this.token },
          signal: AbortSignal.timeout(this.timeout),
        });
      } catch (error) {
        if (attempt < this.retries) {
          await sleep(this.backoff * 2 ** attempt);
          continue;
        }
        throw new GitLabError(`Network error requesting ${path}: ${error.name}`);
      }
      if (RETRY_STATUSES.has(response.status) && attempt < this.retries) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        await response.arrayBuffer().catch(() => {});
        await sleep(retryAfter > 0 ? retryAfter * 1000 : this.backoff * 2 ** attempt);
        continue;
      }
      return response;
    }
  }

  async _get(path, params, raw = false) {
    const response = await this.#fetch(path, params);
    if (!response.ok) {
      const reason = REASONS[response.status] ?? "GitLab API request failed";
      throw new GitLabError(`${reason} (HTTP ${response.status}) for ${path}`);
    }
    if (raw) return [await response.text(), response.headers];
    try {
      return [await response.json(), response.headers];
    } catch {
      throw new GitLabError(`Invalid JSON response for ${path}`);
    }
  }

  async _pages(path, params) {
    let page = 1;
    const result = [];
    for (;;) {
      const [data, headers] = await this._get(path, { ...params, per_page: 100, page });
      if (!Array.isArray(data)) throw new GitLabError(`Unexpected paginated response for ${path}`);
      result.push(...data);
      // Some GitLab installations omit pagination headers for large result sets.
      if (!headers.has("X-Next-Page")) {
        if (data.length < 100) return result;
        page += 1;
        continue;
      }
      const next = headers.get("X-Next-Page") ?? "";
      if (!next) return result;
      if (!/^\d+$/.test(next) || Number(next) <= page) {
        throw new GitLabError(`Invalid next page for ${path}`);
      }
      page = Number(next);
    }
  }

  static #encode = (value) => encodeURIComponent(String(value));

  async get_group(groupId) {
    return (await this._get(`/groups/${GitLabClient.#encode(groupId)}`))[0];
  }

  list_subgroups(groupId) {
    return this._pages(`/groups/${GitLabClient.#encode(groupId)}/subgroups`);
  }

  list_group_projects(groupId) {
    return this._pages(`/groups/${GitLabClient.#encode(groupId)}/projects`, {
      include_subgroups: "false",
      with_shared: "false",
    });
  }

  async get_project(projectId) {
    return (await this._get(`/projects/${GitLabClient.#encode(projectId)}`))[0];
  }

  list_repository_files(projectId, ref) {
    return this._pages(`/projects/${GitLabClient.#encode(projectId)}/repository/tree`, {
      recursive: "true",
      ref,
    });
  }

  async read_file(projectId, path, ref) {
    const encoded = GitLabClient.#encode(path);
    return (await this._get(
      `/projects/${GitLabClient.#encode(projectId)}/repository/files/${encoded}/raw`,
      { ref },
      true,
    ))[0];
  }
}
