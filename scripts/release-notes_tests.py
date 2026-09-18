#!/usr/bin/env python3
"""Offline renderer tests: real temporary Git histories and fake gh metadata."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


helpers = load("release_issue_fixtures", ROOT / "release-issues_tests.py")
notes = load("release_notes", ROOT / "release-notes.py")

# Execute the actual CLI main in a fresh interpreter, injecting only the gh
# transport. No shell, real GitHub calls, or production-only test flags.
DRIVER = '''import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("release_notes", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
api = module.issues.Api(command=[sys.executable, sys.argv[2]],
                        limits=module.issues.Limits(retry_delay=0))
sys.exit(module.main(sys.argv[3:], api=api))
'''


class ReleaseNotesTests(unittest.TestCase):
    def setUp(self):
        clean_env = patch.dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        clean_env.start()
        self.addCleanup(clean_env.stop)
        self.history = helpers.ProvenanceTests()
        self.history.setUp()
        self.addCleanup(self.history.doCleanups)
        self.path = self.history.path
        self.git = self.history.git
        self.commit = self.history.commit
        self.association = self.history.association
        self.issue = self.history.issue
        self.pr = self.history.pr
        self.write_package("0.3.8")
        self.base = self.commit("previous release")
        self.git("tag", "v0.3.8")
        self.write_package("0.3.9")
        self.head = self.commit("implement release notes")
        self.git("tag", "v0.3.9")
        self.association(self.head)
        self.assets = self.path / "release"
        self.assets.mkdir()
        self.tarball = self.assets / "copilot-relay-0.3.9.tgz"
        self.tarball.write_bytes(b"offline npm package fixture\n")
        self.sums = self.assets / "SHA256SUMS"
        self.write_sums()
        self.driver = self.path / "run_notes.py"
        self.driver.write_text(DRIVER, encoding="utf-8")

    def write_package(self, version, name="copilot-relay"):
        (self.path / "package.json").write_text(json.dumps({"name": name, "version": version}))
        self.git("add", "package.json")

    def write_sums(self):
        digest = hashlib.sha256(self.tarball.read_bytes()).hexdigest()
        self.sums.write_text(f"{digest}  {self.tarball.name}\n", encoding="utf-8", newline="\n")

    def retag(self):
        self.head = self.git("rev-parse", "HEAD")
        self.git("tag", "-f", "v0.3.9")
        for sha in self.git("rev-list", f"{self.base}..{self.head}").splitlines():
            self.association(sha)

    def cli(self, *args, env=None, cwd=None):
        self.history.fixture_path.write_text(json.dumps(self.history.fixture))
        environment = dict(os.environ, GITHUB_REPOSITORY="owner/repo", PYTHONIOENCODING="utf-8")
        for key in ("PREVIOUS_TAG", "RELEASE_FIRST"):
            environment.pop(key, None)
        environment.update(env or {})
        return subprocess.run([sys.executable, str(self.driver), str(ROOT / "release-notes.py"),
                               str(self.history.fake), *(args or ["v0.3.9", str(self.assets)])],
                              cwd=cwd or self.path, env=environment, capture_output=True,
                              text=True, encoding="utf-8", timeout=30)

    def success(self, **kwargs):
        result = self.cli(**kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return result.stdout

    def failure(self, pattern, **kwargs):
        result = self.cli(**kwargs)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "", "a failure must not emit partial release notes")
        self.assertRegex(result.stderr, pattern)
        return result

    def test_stable_structure_downloads_and_resolved_issues(self):
        self.commit("fix notes\n\nCloses #75")
        self.retag()
        self.issue(75, [helpers.commit_closer(self.head)], title="Deterministic [notes]")
        rendered = self.success()
        headings = [line for line in rendered.splitlines() if line.startswith("#")]
        self.assertEqual(headings, ["# copilot-relay v0.3.9", "## Downloads", "## Resolved issues",
                                    "## Changes since v0.3.8", "## Verification"])
        self.assertIn("npm install copilot-relay@0.3.9", rendered)
        self.assertIn("copilot-relay-0.3.9.tgz", rendered)
        self.assertIn("SHA256SUMS", rendered)
        self.assertIn("https://github.com/owner/repo/releases/download/v0.3.9/", rendered)
        self.assertIn("[#75](https://github.com/owner/repo/issues/75)", rendered)
        self.assertIn(r"Deterministic \[notes\]", rendered)
        self.assertIn("npm run typecheck", rendered)
        self.assertIn("npm run test:unit", rendered)
        self.assertIn("npm run test:integration", rendered)
        self.assertIn("mocked", rendered)
        self.assertIn("npm run build", rendered)
        self.assertIn("SHA-256", rendered)
        self.assertEqual(rendered, self.success())

    def test_exact_tag_commit_package_not_current_checkout(self):
        self.write_package("99.0.0")
        self.commit("later development must not leak")
        rendered = self.success()
        self.assertNotIn("later development", rendered)
        self.assertIn("npm install copilot-relay@0.3.9", rendered)

    def test_predecessor_uses_reachability_not_numeric_sort(self):
        self.git("tag", "-d", "v0.3.8")
        self.git("tag", "v90.0.0", self.history.base)
        self.git("tag", "v0.1.0", self.base)
        rendered = self.success()
        self.assertIn("## Changes since v0.1.0", rendered)
        self.assertNotIn("previous release (", rendered)

    def test_annotated_release_tag_and_newest_first_nonmerge_changes(self):
        self.commit("newest change")
        self.retag()
        self.git("tag", "-d", "v0.3.9")
        self.git("tag", "-a", "v0.3.9", "-m", "Release v0.3.9")
        rendered = self.success()
        self.assertLess(rendered.index("- newest change ("), rendered.index("- implement release notes ("))
        self.assertNotIn("- previous release (", rendered)

    def test_merge_closure_is_selected_but_merge_subject_not_displayed(self):
        branch = self.git("branch", "--show-current")
        self.git("checkout", "-qb", "topic")
        self.commit("feature body")
        self.git("checkout", "-q", branch)
        self.git("merge", "--no-ff", "-qm", "merge-only closure", "topic")
        self.retag()
        self.association(self.head, [76])
        self.pr(76, self.head, [75])
        self.issue(75, [helpers.pr_closer(76, self.head)])
        rendered = self.success()
        self.assertIn("[#75]", rendered)
        self.assertIn("- feature body (", rendered)
        self.assertNotIn("merge-only closure", rendered)

    def test_first_release_requires_explicit_opt_in(self):
        self.git("tag", "-d", "v0.3.8")
        self.failure("predecessor|first release")
        for sha in self.git("rev-list", self.head).splitlines():
            self.association(sha)
        rendered = self.success(env={"RELEASE_FIRST": "1"})
        self.assertIn("## Changes\n", rendered)
        self.assertIn("- initial (", rendered)
        self.assertNotIn("## Changes since", rendered)

    def test_first_release_conflicts_with_even_empty_previous_tag(self):
        for previous in ("", "v0.3.8"):
            with self.subTest(previous=previous):
                self.failure("conflicts", env={"RELEASE_FIRST": "1", "PREVIOUS_TAG": previous})

    def test_explicit_predecessor_and_nonancestor_rejection(self):
        self.assertIn("## Changes since v0.3.8", self.success(env={"PREVIOUS_TAG": "v0.3.8"}))
        self.git("checkout", "--orphan", "unrelated")
        unrelated = self.commit("unrelated release")
        self.git("tag", "v0.2.0", unrelated)
        self.failure("not an ancestor", env={"PREVIOUS_TAG": "v0.2.0"})

    def test_invalid_explicit_predecessor_is_not_silently_guessed(self):
        self.failure("predecessor|provenance|Git", env={"PREVIOUS_TAG": "missing-tag"})

    def test_shallow_history_is_rejected_even_for_first_release(self):
        shallow = self.path / "shallow"
        self.git("clone", "-q", "--depth=1", "--branch=v0.3.9", self.path.as_uri(), str(shallow))
        self.failure("complete history|shallow", cwd=shallow)
        self.failure("complete history|shallow", cwd=shallow, env={"RELEASE_FIRST": "1"})

    def test_safe_semver_and_exact_tag_not_branch(self):
        for tag in ("--help", "v0.3.9\n# injected", "v00.3.9", "v0.3", "v0.3.9;touch-PWNED"):
            with self.subTest(tag=tag):
                result = self.cli("--", tag, str(self.assets))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
        self.git("tag", "-d", "v0.3.9")
        self.git("branch", "v0.3.9", self.head)
        self.failure("tag|Git")

    def test_prerelease_and_build_semver(self):
        tag = "v0.3.9-rc.1+build.7"
        self.write_package(tag[1:])
        head = self.commit("prerelease")
        self.git("tag", tag)
        self.association(head)
        self.tarball = self.tarball.rename(self.assets / f"copilot-relay-{tag[1:]}.tgz")
        self.write_sums()
        result = self.cli(tag, str(self.assets))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"# copilot-relay {tag}", result.stdout)

    def test_version_and_package_name_must_match_tag_commit(self):
        for name, version in (("copilot-relay", "0.3.10"), ("other-package", "0.3.9")):
            with self.subTest(name=name, version=version):
                self.write_package(version, name)
                self.commit("wrong package metadata")
                self.retag()
                self.failure("version|package name")

    def test_missing_tarball_or_checksum_fails_without_output(self):
        for asset in (self.tarball, self.sums):
            with self.subTest(asset=asset.name):
                backup = asset.read_bytes()
                asset.unlink()
                self.failure("asset|SHA256SUMS|tarball")
                asset.write_bytes(backup)

    def test_hash_mismatch_fails_without_output(self):
        self.tarball.write_bytes(b"tampered bytes")
        self.failure("checksum|SHA-256")

    def test_checksum_must_name_exactly_the_expected_tarball(self):
        digest = hashlib.sha256(self.tarball.read_bytes()).hexdigest()
        for content in (f"{digest}  ../{self.tarball.name}\n", f"{digest}  renamed.tgz\n",
                        f"{digest}  {self.tarball.name}\nextra\n", f"{digest} *{self.tarball.name}\n"):
            with self.subTest(content=content):
                self.sums.write_text(content, encoding="utf-8", newline="\n")
                self.failure("checksum|SHA256SUMS")

    def test_extra_assets_are_rejected(self):
        (self.assets / "unexpected.tgz").write_bytes(b"unexpected")
        self.failure("asset")

    def test_metadata_failure_never_emits_partial_notes(self):
        self.commit("Fixes #75")
        self.retag()
        self.history.fixture["issue:owner/repo:75:"] = {"status": 401, "body": {"message": "unauthorized"}}
        self.failure("API failure")

    def test_final_git_log_failure_never_emits_partial_notes(self):
        original = notes.issues.capture

        def fail_log(command, *args, **kwargs):
            if command[:2] == ["git", "log"]:
                return 1, "partial commit subject", "git log failure"
            return original(command, *args, **kwargs)

        self.history.fixture_path.write_text(json.dumps(self.history.fixture))
        api = notes.issues.Api(command=[sys.executable, str(self.history.fake)])
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(notes.issues, "capture", side_effect=fail_log), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = notes.main(["v0.3.9", str(self.assets)], api=api, cwd=self.path,
                                environ={"GITHUB_REPOSITORY": "owner/repo"})
        self.assertNotEqual(status, 0)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("log", stderr.getvalue())

    def test_hostile_subject_is_one_line_escaped_not_executable(self):
        self.commit('[evil](https://bad.invalid) `$(touch PWNED)` <img> *bold* | \x1b[31m‮injected')
        self.retag()
        rendered = self.success()
        self.assertNotIn("[evil](", rendered)
        self.assertNotIn("<img>", rendered)
        self.assertNotIn("\x1b", rendered)
        self.assertNotIn("‮", rendered)
        self.assertIn(r"\[evil\]\(https://bad\.invalid\)", rendered)
        self.assertIn("&lt;img&gt;", rendered)
        self.assertFalse((self.path / "PWNED").exists())

    def test_manual_closures_keep_separate_disclosure(self):
        # Distinct commit dates give the collector an unambiguous manual window.
        with patch.dict(os.environ, GIT_COMMITTER_DATE="2026-09-10T00:00:00Z"):
            self.commit("Fixes #75")
        self.retag()
        self.issue(75, [None])
        item = self.history.fixture["issue:owner/repo:75:"]["body"]["data"]["repository"]["issueOrPullRequest"]
        item.update(state="CLOSED", closedAt="2026-09-05T00:00:00Z")
        item["timelineItems"]["nodes"][0]["createdAt"] = "2026-09-05T00:00:00Z"
        for sha in self.git("rev-list", self.head).splitlines():
            self.association(sha)
        rendered = self.success(env={"RELEASE_FIRST": "1"})
        resolved, manual = rendered.split("## Manually closed issues (unverified release linkage)")
        self.assertNotIn("[#75]", resolved)
        self.assertIn("[#75]", manual)
        self.assertLess(rendered.index("## Manually"), rendered.index("## Changes"))

    def test_default_asset_directory_and_repository(self):
        # Use main's defaults while keeping all external metadata injected.
        self.history.fixture_path.write_text(json.dumps({
            f"repos/D0n9X1n/copilot-relay/commits/{self.head}/pulls?per_page=100&page=1": {"body": []}}))
        api = notes.issues.Api(command=[sys.executable, str(self.history.fake)])
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = notes.main(["v0.3.9"], api=api, cwd=self.path, environ={})
        self.assertEqual(status, 0, stderr.getvalue())
        self.assertIn("https://github.com/D0n9X1n/copilot-relay/releases/download/", stdout.getvalue())

    def test_direct_script_entrypoint_errors_use_stderr_only(self):
        result = subprocess.run([sys.executable, str(ROOT / "release-notes.py"), "v0.3.9", "missing-assets"],
                                cwd=self.path, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("release notes failed", result.stderr)


if __name__ == "__main__":
    unittest.main()
