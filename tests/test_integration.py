import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, unquote, urlsplit

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[1]


class GitLabHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.headers.get("PRIVATE-TOKEN") != "fixture-token":
            self.send_response(401)
            self.end_headers()
            return
        url = urlsplit(self.path)
        path = unquote(url.path)
        page = parse_qs(url.query).get("page", ["1"])[0]
        data = {
            "/api/v4/groups/1": {"id": 1, "name": "root"},
            "/api/v4/groups/2": {"id": 2, "name": "child"},
            "/api/v4/groups/1/subgroups": [{"id": 2}],
            "/api/v4/groups/2/subgroups": [],
            "/api/v4/groups/2/projects": [],
            "/api/v4/projects/10": {"id": 10, "name": "app", "default_branch": "main"},
            "/api/v4/projects/11": {"id": 11, "name": "empty", "default_branch": None},
            "/api/v4/projects/10/repository/tree": [
                {"type": "blob", "path": ".gitlab-ci.yml"},
                {"type": "blob", "path": ".jenkins/Jenkinsfile"},
            ],
        }
        next_page = ""
        if path == "/api/v4/groups/1/projects":
            data[path] = [{"id": 10, "name": "app"}] if page == "1" else [{"id": 11, "name": "empty"}]
            next_page = "2" if page == "1" else ""
        if path == "/api/v4/projects/10/repository/files/.gitlab-ci.yml/raw":
            body = b"job:\n  script: echo ok\n"
            content_type = "text/plain"
        elif path in data:
            body = json.dumps(data[path]).encode()
            content_type = "application/json"
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Next-Page", next_page)
        self.end_headers()
        self.wfile.write(body)


class EndToEndTests(unittest.TestCase):
    def test_cli_mcp_and_reports(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), GitLabHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                env = {**os.environ, "GITLAB_URL": f"http://127.0.0.1:{server.server_port}",
                       "GITLAB_TOKEN": "fixture-token"}
                process = subprocess.run(
                    [sys.executable, str(ROOT / "main.py"), "--group-ids", "1", "2"],
                    cwd=directory, env=env, capture_output=True, text=True, timeout=30,
                )
                self.assertEqual(process.returncode, 1, process.stderr)
                report = json.loads((Path(directory) / "results.json").read_text())
                self.assertEqual(report["statistics"]["groups_discovered"], 2)
                self.assertEqual(report["statistics"]["projects_discovered"], 2)
                self.assertEqual(report["projects"][0]["Classification"], "BOTH")
                self.assertEqual(report["projects"][0]["Scan Status"], "SUCCESS")
                self.assertEqual(report["projects"][1]["Scan Status"], "FAILED")
                workbook = load_workbook(Path(directory) / "results.xlsx", data_only=True)
                self.assertEqual(workbook.sheetnames, ["Projects", "Statistics", "Group Errors"])
                self.assertEqual(workbook["Projects"]["I2"].value, "BOTH")
                workbook.close()
                env["GITLAB_TOKEN"] = "invalid-token"
                process = subprocess.run(
                    [sys.executable, str(ROOT / "main.py"), "--group-ids", "1"],
                    cwd=directory, env=env, capture_output=True, text=True, timeout=30,
                )
                self.assertEqual(process.returncode, 1, process.stderr)
                failed_report = json.loads((Path(directory) / "results.json").read_text())
                self.assertIn("Authentication failed", failed_report["group_errors"][0]["error"])
                self.assertNotIn("invalid-token", json.dumps(failed_report))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
