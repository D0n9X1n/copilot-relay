#!/usr/bin/env python3
"""Render deterministic GitHub release notes after validating history and assets."""
import argparse
import hashlib
import html
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import unicodedata

SPEC = importlib.util.spec_from_file_location("release_issues", Path(__file__).with_name("release-issues.py"))
issues = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = issues
SPEC.loader.exec_module(issues)

# SemVer identifiers are also safe to include in a filename, URL, and npm command.
NUMERIC = r"(?:0|[1-9][0-9]*)"
PRERELEASE = rf"(?:{NUMERIC}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
TAG = re.compile(rf"v{NUMERIC}\.{NUMERIC}\.{NUMERIC}(?:-{PRERELEASE}(?:\.{PRERELEASE})*)?"
                 r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?")


def markdown_line(value):
    """Untrusted subjects and tag names cannot add HTML, Markdown, or controls."""
    value = "".join(" " if unicodedata.category(character).startswith("C") else character
                    for character in value)
    value = " ".join(value.split())
    return re.sub(r"([\\`*_{}\[\]()#+.!|~-])", r"\\\1", html.escape(value, quote=False))


def render(tag, assetdir="release", *, api=None, cwd=None, environ=None):
    environ = os.environ if environ is None else environ
    cwd = Path.cwd() if cwd is None else Path(cwd)
    issues.require(TAG.fullmatch(tag) is not None, "release tag must be a safe v-prefixed SemVer")
    repo = issues.repository(environ.get("GITHUB_REPOSITORY", "D0n9X1n/copilot-relay"))
    api = api or issues.Api()

    def git(*args, allow_failure=False):
        code, output, _ = issues.capture(["git", *args], min(15, api.remaining()),
                                        api.limits.max_output, cwd)
        issues.require(code == 0 or allow_failure, f"Git release validation failed: {args[0]}")
        return output.strip() if code == 0 else None

    issues.require(git("rev-parse", "--is-shallow-repository") == "false",
                   "release notes require complete history; shallow repositories are not supported")
    # Fully qualify the ref: a similarly named branch is not a release tag.
    head = issues.oid(git("rev-parse", "--verify", "--end-of-options", f"refs/tags/{tag}^{{commit}}"))
    first = environ.get("RELEASE_FIRST") == "1"
    issues.require(not (first and "PREVIOUS_TAG" in environ), "RELEASE_FIRST=1 conflicts with PREVIOUS_TAG")
    previous = environ.get("PREVIOUS_TAG", "")
    if not first and not previous:
        previous = git("describe", "--tags", "--abbrev=0", f"{head}^", allow_failure=True)
        issues.require(previous, "release predecessor lookup failed; fetch complete tags or explicitly "
                       "set RELEASE_FIRST=1 for the first release")
    base = issues.oid(git("rev-parse", "--verify", "--end-of-options", f"{previous}^{{commit}}")) if previous else ""

    package = json.loads(git("show", f"{head}:package.json"))
    issues.require(isinstance(package, dict) and package.get("name") == "copilot-relay",
                   "tagged package name must be copilot-relay")
    version = tag[1:]
    issues.require(package.get("version") == version, "release tag does not match tagged package.json version")
    assets = cwd / assetdir
    tarball_name = f"copilot-relay-{version}.tgz"
    expected = {tarball_name, "SHA256SUMS"}
    issues.require(assets.is_dir(), f"release asset directory is missing: {assets}")
    issues.require({entry.name for entry in assets.iterdir()} == expected,
                   "release assets must contain exactly the expected npm tarball and SHA256SUMS")
    tarball, sums = assets / tarball_name, assets / "SHA256SUMS"
    issues.require(all(path.is_file() and not path.is_symlink() for path in (tarball, sums)),
                   "release assets must be regular files, not symlinks")
    # One bounded, exact checksum entry; never accept traversal, duplicate entries,
    # another package, or unverified extra files in the publication directory.
    with sums.open("rb") as stream:
        checksum = stream.read(4097)
    issues.require(len(checksum) <= 4096, "SHA256SUMS exceeds the expected single checksum line")
    digest = hashlib.sha256()
    with tarball.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    issues.require(checksum == f"{digest.hexdigest()}  {tarball_name}\n".encode("utf-8"),
                   "SHA-256 checksum mismatch or invalid SHA256SUMS entry")

    # The unchanged collector validates ancestry and all closure provenance. Keep
    # its merge-aware selection separate from the human-readable nonmerge log.
    resolved = issues.collect(repo, head, base, api=api, cwd=cwd)
    log = git("log", "--no-merges", "--no-color", "--format=%s%x00%h", f"{base}..{head}" if base else head)
    changes = []
    for entry in log.split("\n") if log else []:
        subject, short_sha = entry.rsplit("\x00", 1)
        issues.require(re.fullmatch(r"[0-9a-f]{4,40}", short_sha), "invalid Git log commit identifier")
        changes.append(f"- {markdown_line(subject)} ({short_sha})")
    download = f"https://github.com/{repo}/releases/download/{tag}"
    previous_label = previous if TAG.fullmatch(previous) else markdown_line(previous)
    heading = f"## Changes since {previous_label}" if previous else "## Changes"
    return (
        f"# copilot-relay {tag}\n\n"
        "## Downloads\n\n"
        f"- Install from npm: `npm install copilot-relay@{version}`.\n"
        f"- npm tarball: [`{tarball_name}`]({download}/{tarball_name}).\n"
        f"- Integrity metadata: [`SHA256SUMS`]({download}/SHA256SUMS).\n\n"
        f"{resolved}\n"
        f"{heading}\n\n" + ("\n".join(changes) or "No non-merge commits in this release range.") + "\n\n"
        "## Verification\n\n"
        "- Release workflow gate on Ubuntu: `npm run typecheck`, `npm run test:unit`, "
        "`npm run test:integration` (mocked upstream), and `npm run build`.\n"
        "- Separate pull-request CI runs on Linux, macOS, and Windows.\n"
        "- Release notes validate the tag against its committed package version and verify "
        "the npm tarball against its SHA-256 checksum in `SHA256SUMS`.\n"
    )


def main(argv=None, *, api=None, cwd=None, environ=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", help="existing release tag, e.g. v0.3.9")
    parser.add_argument("assetdir", nargs="?", default="release", help="directory containing the npm tarball and SHA256SUMS")
    args = parser.parse_args(argv)
    try:
        notes = render(args.tag, args.assetdir, api=api, cwd=cwd, environ=environ)
    except (issues.Failure, OSError, KeyError, TypeError, ValueError, TimeoutError, RecursionError) as error:
        print(f"release notes failed: {error}", file=sys.stderr)
        return 1
    print(notes, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
