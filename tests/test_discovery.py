import unittest

from ci_detector import _matches, detect_ci
from discovery import discover, inspect_project
from gitlab_client import GitLabClient, GitLabError
from unittest.mock import patch


class FakeAPI:
    def __init__(self, data):
        self.data = data
        self.calls = []

    async def call(self, tool, **kwargs):
        self.calls.append((tool, kwargs))
        key = (tool, *kwargs.values())
        value = self.data[key]
        if isinstance(value, Exception):
            raise value
        return value


class DiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_recursive_deduplication_and_failures(self):
        api = FakeAPI({
            ("get_group", "1"): {"id": 1, "name": "root"},
            ("get_group", "2"): {"id": 2, "name": "child"},
            ("get_group", "3"): RuntimeError("permission denied"),
            ("list_subgroups", "1"): [{"id": 2}, {"id": 3}],
            ("list_subgroups", "2"): [{"id": 1}],
            ("list_group_projects", "1"): [{"id": 10, "name": "broken"}],
            ("list_group_projects", "2"): [{"id": 10}, {"id": 11, "name": "good"}],
            ("get_project", "10"): RuntimeError("inaccessible"),
            ("get_project", "11"): {"id": 11, "default_branch": "main"},
            ("list_repository_files", "11", "main"): [{"type": "blob", "path": "README.md"}],
        })
        report = await discover(api, [1, 2, 1])
        self.assertEqual(report["statistics"]["groups_discovered"], 2)
        self.assertEqual(report["statistics"]["projects_discovered"], 2)
        self.assertEqual(report["statistics"]["group_errors"], 1)
        self.assertEqual([r["Scan Status"] for r in report["projects"]], ["FAILED", "SUCCESS"])
        self.assertEqual(report["projects"][1]["Classification"], "UNKNOWN")
        self.assertEqual(sum(call[0] == "get_project" and call[1]["project_id"] == "10"
                             for call in api.calls), 1)

    async def test_detects_nested_includes_and_ignores_docs(self):
        api = FakeAPI({
            ("read_file", "1", ".gitlab-ci.yml", "main"):
                "include:\n  - local: /ci/*.yml\n  - project: team/shared\n    file: /base.yml\n",
            ("read_file", "1", "ci/build.yml", "main"): "include: /ci/extra.yml\n",
            ("read_file", "1", "ci/extra.yml", "main"): "job:\n  script: echo ok\n",
            ("get_project", "team/shared"): {"default_branch": "stable"},
            ("read_file", "team/shared", "base.yml", "stable"): "job: !reference [.base, script]\n",
        })
        tree = [{"type": "blob", "path": p} for p in
                [".gitlab-ci.yml", "ci/build.yml", "ci/extra.yml", "jenkins/Jenkinsfile", "README.md"]]
        jenkins, files, detected, errors = await detect_ci(
            api, {"id": 1}, "main", tree
        )
        self.assertEqual(jenkins, ["jenkins/Jenkinsfile"])
        self.assertTrue(detected)
        self.assertEqual(set(files), {".gitlab-ci.yml", "ci/build.yml", "ci/extra.yml",
                                      "base.yml@team/shared:default"})
        self.assertEqual(errors, [])

    async def test_missing_custom_and_remote_include_are_partial(self):
        api = FakeAPI({("read_file", "1", ".gitlab-ci.yml", "main"):
                       "include:\n  - remote: https://example.com/ci.yml\n"})
        _, files, detected, errors = await detect_ci(
            api, {"id": 1, "ci_config_path": "missing.yml"}, "main",
            [{"type": "blob", "path": ".gitlab-ci.yml"}],
        )
        self.assertTrue(detected)
        self.assertIn("missing.yml", files)
        self.assertEqual(len(errors), 2)

    async def test_missing_custom_is_not_confirmation(self):
        _, _, detected, errors = await detect_ci(
            FakeAPI({}), {"id": 1, "ci_config_path": "missing.yml"}, "main", []
        )
        self.assertFalse(detected)
        self.assertTrue(errors)

    async def test_project_classifications_and_documentation(self):
        for paths, expected in [
            (["Jenkinsfile"], "JENKINS"),
            ([".gitlab-ci.yml"], "GITLAB_CI"),
            ([".jenkins/Jenkinsfile", ".gitlab-ci.yml"], "BOTH"),
            (["README.md", "Jenkinsfile.md"], "UNKNOWN"),
        ]:
            with self.subTest(expected=expected):
                data = {
                    ("get_project", "1"): {"id": 1, "default_branch": "main"},
                    ("list_repository_files", "1", "main"):
                        [{"type": "blob", "path": p} for p in paths],
                }
                if ".gitlab-ci.yml" in paths:
                    data[("read_file", "1", ".gitlab-ci.yml", "main")] = "job: {script: echo ok}"
                row = await inspect_project(FakeAPI(data), {"id": 2}, {"id": 1})
                self.assertEqual(row["Classification"], expected)
                self.assertEqual(row["Scan Status"], "SUCCESS")

    def test_gitlab_globs_match_zero_or_more_directories(self):
        self.assertTrue(_matches("ci/build.yml", "ci/**/*.yml"))
        self.assertTrue(_matches("ci/deep/build.yml", "ci/**/*.yml"))
        self.assertFalse(_matches("ci/deep/build.yml", "ci/*.yml"))


class PaginationTests(unittest.TestCase):
    def test_missing_pagination_header_and_invalid_next_page(self):
        client = GitLabClient("https://gitlab.example", "token")
        try:
            with patch.object(client, "_get", side_effect=[
                (list(range(100)), {}), ([100], {}),
            ]) as get:
                self.assertEqual(len(client._pages("/test")), 101)
                self.assertEqual(get.call_count, 2)
            with patch.object(client, "_get", return_value=([], {"X-Next-Page": "1"})):
                with self.assertRaises(GitLabError):
                    client._pages("/test")
        finally:
            client.session.close()


if __name__ == "__main__":
    unittest.main()
