// Read-only GitLab REST API access.
import { readFileSync } from "node:fs";
import https from "node:https";
import axios from "axios";

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
  constructor(url, token, { timeout = 30000, retries = 3, backoff = 1000, caCertPath } = {}) {
    if (!url || !token) throw new Error("GITLAB_URL and GITLAB_TOKEN are required");
    this.token = token;
    this.retries = retries;
    this.backoff = backoff;
    const certPath = caCertPath ?? process.env.GITLAB_CA_CERT;
    this.http = axios.create({
      baseURL: `${url.replace(/\/+$/, "")}/api/v4`,
      headers: { "PRIVATE-TOKEN": token },
      timeout,
      validateStatus: () => true,
      httpsAgent: certPath ? new https.Agent({ ca: readFileSync(certPath) }) : undefined,
    });
  }

  async #request(path, params, responseType) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.http.get(path.replace(/^\//, ""), { params, responseType });
      } catch (error) {
        if (attempt < this.retries) {
          await sleep(this.backoff * 2 ** attempt);
          continue;
        }
        throw new GitLabError(`Network error requesting ${path}: ${error.code ?? error.name}`);
      }
      if (RETRY_STATUSES.has(response.status) && attempt < this.retries) {
        const retryAfter = Number(response.headers["retry-after"]);
        await sleep(retryAfter > 0 ? retryAfter * 1000 : this.backoff * 2 ** attempt);
        continue;
      }
      return response;
    }
  }

  async _get(path, params, raw = false) {
    const response = await this.#request(path, params, raw ? "text" : "json");
    if (response.status < 200 || response.status >= 300) {
      const reason = REASONS[response.status] ?? "GitLab API request failed";
      throw new GitLabError(`${reason} (HTTP ${response.status}) for ${path}`);
    }
    if (!raw && (response.data === "" || typeof response.data === "string")) {
      throw new GitLabError(`Invalid JSON response for ${path}`);
    }
    return [response.data, response.headers];
  }

  async _pages(path, params) {
    let page = 1;
    const result = [];
    for (;;) {
      const [data, headers] = await this._get(path, { ...params, per_page: 100, page });
      if (!Array.isArray(data)) throw new GitLabError(`Unexpected paginated response for ${path}`);
      result.push(...data);
      // Some GitLab installations omit pagination headers for large result sets.
      if (!("x-next-page" in headers)) {
        if (data.length < 100) return result;
        page += 1;
        continue;
      }
      const next = headers["x-next-page"] ?? "";
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
