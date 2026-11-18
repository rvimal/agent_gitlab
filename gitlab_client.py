"""Read-only GitLab REST API access."""

import logging
from urllib.parse import quote

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

LOG = logging.getLogger(__name__)


class GitLabError(Exception):
    """An API error safe to include in a report."""


class GitLabClient:
    def __init__(self, url, token, timeout=30):
        if not url or not token:
            raise ValueError("GITLAB_URL and GITLAB_TOKEN are required")
        self.base_url = f"{url.rstrip('/')}/api/v4"
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"PRIVATE-TOKEN": token})
        retry = Retry(
            total=3, connect=3, read=3, status=3, backoff_factor=1,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset({"GET"}), respect_retry_after_header=True,
            raise_on_status=False,
        )
        self.session.mount("https://", HTTPAdapter(max_retries=retry))
        self.session.mount("http://", HTTPAdapter(max_retries=retry))

    def _get(self, path, params=None, raw=False):
        try:
            response = self.session.get(
                self.base_url + path, params=params, timeout=self.timeout
            )
        except requests.RequestException as exc:
            raise GitLabError(
                f"Network error requesting {path}: {type(exc).__name__}"
            ) from exc
        if not response.ok:
            reason = {
                401: "Authentication failed",
                403: "Permission denied",
                404: "Resource not found or inaccessible",
                429: "Rate limit exceeded after retries",
            }.get(response.status_code, "GitLab API request failed")
            raise GitLabError(f"{reason} (HTTP {response.status_code}) for {path}")
        if raw:
            return response.text, response.headers
        try:
            return response.json(), response.headers
        except ValueError as exc:
            raise GitLabError(f"Invalid JSON response for {path}") from exc

    def _pages(self, path, params=None):
        page = 1
        result = []
        while True:
            data, headers = self._get(
                path, {**(params or {}), "per_page": 100, "page": page}
            )
            if not isinstance(data, list):
                raise GitLabError(f"Unexpected paginated response for {path}")
            result.extend(data)
            # Some GitLab installations omit pagination headers for large result sets.
            if "X-Next-Page" not in headers:
                if len(data) < 100:
                    return result
                page += 1
                continue
            next_page = headers.get("X-Next-Page", "")
            if not next_page:
                return result
            if not next_page.isdigit() or int(next_page) <= page:
                raise GitLabError(f"Invalid next page for {path}")
            page = int(next_page)

    @staticmethod
    def _encode(value):
        return quote(str(value), safe="")

    def get_group(self, group_id):
        return self._get(f"/groups/{self._encode(group_id)}")[0]

    def list_subgroups(self, group_id):
        return self._pages(f"/groups/{self._encode(group_id)}/subgroups")

    def list_group_projects(self, group_id):
        return self._pages(
            f"/groups/{self._encode(group_id)}/projects",
            {"include_subgroups": "false", "with_shared": "false"},
        )

    def get_project(self, project_id):
        return self._get(f"/projects/{self._encode(project_id)}")[0]

    def list_repository_files(self, project_id, ref):
        return self._pages(
            f"/projects/{self._encode(project_id)}/repository/tree",
            {"recursive": "true", "ref": ref},
        )

    def read_file(self, project_id, path, ref):
        return self._get(
            f"/projects/{self._encode(project_id)}/repository/files/{self._encode(path)}/raw",
            {"ref": ref}, raw=True,
        )[0]
