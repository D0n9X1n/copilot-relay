#!/usr/bin/env python3
"""Offline fixtures exercise the same wiki CLI used by the publish workflow."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("publish-wiki.py")


class PublishWikiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="relay-wiki-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        self.destination = self.root / "published"
        self.home = self.root / "home"
        for directory in (self.source, self.destination, self.home):
            directory.mkdir()
        self.environment = dict(os.environ, HOME=str(self.home), USERPROFILE=str(self.home),
                                PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8",
                                PYTHONUTF8="1")

    def write(self, name, body, directory=None):
        (directory or self.source).joinpath(name).write_text(body, encoding="utf-8")

    def cli(self, *arguments):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, arguments)],
                              env=self.environment, capture_output=True, text=True,
                              encoding="utf-8", timeout=15)

    def success(self, *arguments):
        result = self.cli(*arguments)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return result.stdout

    def test_navigation_rewrites_but_code_and_external_links_stay_verbatim(self):
        examples = '''
`[inline](Missing.md)` and `` `[nested](Missing.md)` ``.
`[multiline](Missing.md)
code span`.

```sh
grep -rn "](.*\\.md)" /tmp/relay-wiki || echo "no unstripped .md links"
[code](Missing.md#example)
```

````markdown
```text
[shorter fence is code](Missing.md)
```
````

~~~markdown
[tilde fence](Missing.md)
~~~

[external](https://docs.anthropic.com/en/Guide.md)
[protocol-relative](//example.com/Guide.md)
[section](#local-section)
'''
        self.write("README.md", "[English](EN-Guide.md) · [中文](ZH-Guide.md)\n")
        self.write("EN-Guide.md", "[Home](README.md) [中文 with `code`](ZH-Guide.md)\n" + examples)
        self.write("ZH-Guide.md", "[首页](README.md) [English](EN-Guide.md)\n")

        self.success("build", self.source, self.destination)

        self.assertFalse((self.destination / "README.md").exists())
        self.assertEqual((self.destination / "Home.md").read_text(encoding="utf-8"),
                         "[English](EN-Guide) · [中文](ZH-Guide)\n")
        self.assertEqual((self.destination / "EN-Guide.md").read_text(encoding="utf-8"),
                         "[Home](Home) [中文 with `code`](ZH-Guide)\n" + examples)
        self.assertEqual((self.destination / "ZH-Guide.md").read_text(encoding="utf-8"),
                         "[首页](Home) [English](EN-Guide)\n")
        self.success("verify", self.destination)

    def test_container_fences_preserve_code_and_following_navigation(self):
        containers = (("- ", "  "), ("+ ", "  "), ("* ", "  "),
                      ("1. ", "   "), ("12) ", "    "),
                      ("- - ", "    "), ("> - ", ">   "))
        for opening, continuation in containers:
            for delimiter in ("```", "~~~"):
                with self.subTest(opening=opening, delimiter=delimiter):
                    code = (f"{opening}{delimiter}markdown\n"
                            f"{continuation}[example](Missing.md)\n"
                            f"{continuation}{delimiter}\n")
                    self.write("README.md", code + '[home](README.md)\n')
                    self.success("build", self.source, self.destination)
                    self.assertEqual((self.destination / "Home.md").read_text(encoding="utf-8"),
                                     code + '[home](Home)\n')
                    self.success("verify", self.destination)

    def test_container_fence_ends_when_its_list_item_ends(self):
        self.write("README.md", '- ```markdown\n  [example](Missing.md)\n\n[home](README.md)\n')
        self.success("build", self.source, self.destination)
        self.assertEqual((self.destination / "Home.md").read_text(encoding="utf-8"),
                         '- ```markdown\n  [example](Missing.md)\n\n[home](Home)\n')

    def test_titles_angle_destinations_and_reference_links_keep_their_syntax(self):
        self.write("README.md", '[English](<EN_Guide.v1.md> "guide.md")\n[中文][guide]\n\n'
                   '[guide]: ZH-Guide.md "中文"\n')
        self.write("EN_Guide.v1.md", '[Home](README.md \'home\')\n')
        self.write("ZH-Guide.md", '[home]: <README.md>\n\n[home]\n')
        self.success("build", self.source, self.destination)
        self.assertEqual((self.destination / "Home.md").read_text(encoding="utf-8"),
                         '[English](<EN_Guide.v1> "guide.md")\n[中文][guide]\n\n'
                         '[guide]: ZH-Guide "中文"\n')
        self.assertEqual((self.destination / "EN_Guide.v1.md").read_text(encoding="utf-8"),
                         '[Home](Home \'home\')\n')
        self.assertEqual((self.destination / "ZH-Guide.md").read_text(encoding="utf-8"),
                         '[home]: <Home>\n\n[home]\n')
        self.success("verify", self.destination)

    def test_reference_next_line_and_quoted_destinations_keep_source_offsets(self):
        examples = (
            '[home][r]\n\n[r]:\n  README.md\n',
            '> [home][r]\n>\n> [r]: README.md\n',
            '> [home][r]\n>\n> [r]:\n>   README.md\n',
            '[home][r\\]]\n\n[r\\]]:\n  <README.md> "literal `"\n[home](README.md)\n`code`\n',
            '> [home][r]\n>\n> [r]:\n>   README.md\n>   "literal `"\n> [home](README.md)\n> `code`\n',
        )
        for example in examples:
            with self.subTest(example=example):
                self.write("README.md", example)
                self.success("build", self.source, self.destination)
                self.assertEqual((self.destination / "Home.md").read_bytes(),
                                 example.replace("README.md", "Home").encode("utf-8"))
                self.success("verify", self.destination)

    def test_reference_next_line_and_quote_targets_are_validated_by_both_commands(self):
        definitions = ('[r]:\n  {target}\n', '> [r]: {target}\n',
                       '> [r]:\n>   {target}\n', '[r\\]]:\n  {target}\n')
        for definition in definitions:
            for command, targets in (
                ("build", ("Missing.md", "Missing.md#section", "README.md#section")),
                ("verify", ("Missing", "Missing.md#section", "Home#section", "README.md")),
            ):
                for target in targets:
                    with self.subTest(definition=definition, command=command, target=target):
                        body = definition.format(target=target)
                        if command == "build":
                            self.write("README.md", body)
                            result = self.cli("build", self.source, self.destination)
                        else:
                            self.write("Home.md", body, self.destination)
                            result = self.cli("verify", self.destination)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn(target, result.stderr)
                        self.assertEqual(result.stdout, "")

    def test_indented_code_is_preserved_byte_for_byte(self):
        containers = (("", "    ", ""), ("", "\t", ""),
                      ("- item\n\n", "      ", "  "),
                      ("- item\n\n", "  \t  ", "  "),
                      ("1. item\n\n", "       ", "   "),
                      ("- outer\n  - inner\n\n", "        ", "    "),
                      (">\n", ">     ", "> "))
        for opening, indentation, continuation in containers:
            with self.subTest(indentation=indentation, opening=opening):
                code = (opening + indentation + '[literal](README.md)\n'
                        + indentation + '[missing](Missing.md)\n'
                        + indentation + '[r]: Missing.md#section\n\n')
                self.write("README.md", code + continuation + '[home](README.md)\n')
                self.success("build", self.source, self.destination)
                expected = (code + continuation + '[home](Home)\n').encode("utf-8")
                self.assertEqual((self.destination / "Home.md").read_bytes(), expected)
                self.success("verify", self.destination)
                self.assertEqual((self.destination / "Home.md").read_bytes(), expected)

    def test_list_item_can_start_with_indented_code(self):
        for marker, continuation in (("-", "  "), ("1.", "   ")):
            with self.subTest(marker=marker):
                code = (marker + '     [literal](README.md)\n'
                        + continuation + '    [missing](Missing.md)\n'
                        + continuation + '    [r]: Missing.md#section\n\n')
                self.write("README.md", code + continuation + '[home](README.md)\n')
                self.success("build", self.source, self.destination)
                self.assertEqual((self.destination / "Home.md").read_bytes(),
                                 (code + continuation + '[home](Home)\n').encode("utf-8"))
                self.success("verify", self.destination)

    def test_crlf_indented_examples_are_preserved_byte_for_byte(self):
        code = b'    [literal](README.md)\r\n    [r]: Missing.md#section\r\n\r\n'
        body = code + b'[home][r]\r\n\r\n> [r]:\r\n>   README.md\r\n'
        (self.source / "README.md").write_bytes(body)
        self.success("build", self.source, self.destination)
        expected = code + b'[home][r]\r\n\r\n> [r]:\r\n>   Home\r\n'
        self.assertEqual((self.destination / "Home.md").read_bytes(), expected)
        self.success("verify", self.destination)
        self.assertEqual((self.destination / "Home.md").read_bytes(), expected)

    def test_indentation_continuing_paragraphs_is_not_code(self):
        examples = ('Paragraph\n    [home](README.md)\n',
                    'Paragraph\n\t[home](README.md)\n',
                    '- item\n    [home](README.md)\n',
                    '- item\n      [home](README.md)\n',
                    '- item\n\n    [home](README.md)\n',
                    '- item\n\n  [home](README.md)\n',
                    '- outer\n  - inner\n\n      [home](README.md)\n')
        for example in examples:
            with self.subTest(example=example):
                self.write("README.md", example)
                self.success("build", self.source, self.destination)
                self.assertEqual((self.destination / "Home.md").read_bytes(),
                                 example.replace("README.md", "Home").encode("utf-8"))
                self.success("verify", self.destination)
                self.write("README.md", example.replace("README.md", "Missing.md"))
                result = self.cli("build", self.source, self.destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Missing.md", result.stderr)
                self.write("Home.md", example.replace("README.md", "Missing"), self.destination)
                result = self.cli("verify", self.destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Missing", result.stderr)

    def test_unsupported_reference_blocks_fail_explicitly(self):
        examples = (
            ('- [r]:\n- README.md\n', "reference definition"),
            ('[home][ref label]\n\n[ref\n label]: Missing.md#section\n', "reference label"),
            ('[r]: https://example.com\n  "literal `\n  continued"\n[broken](Missing.md)\n`code`\n',
             "reference title"),
        )
        for body, diagnostic in examples:
            for command in ("build", "verify"):
                with self.subTest(body=body, command=command):
                    if command == "build":
                        self.write("README.md", body)
                        result = self.cli("build", self.source, self.destination)
                    else:
                        self.write("Home.md", body.replace("README.md", "Home"), self.destination)
                        result = self.cli("verify", self.destination)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(diagnostic, result.stderr)

    def test_reference_title_does_not_consume_a_sibling_list_paragraph(self):
        body = ('- [r]: https://example.com\n- "literal `"\n'
                '  [code example](Missing.md)\n  `code`\n\n[home](README.md)\n')
        self.write("README.md", body)
        self.success("build", self.source, self.destination)
        self.assertEqual((self.destination / "Home.md").read_bytes(),
                         body.replace("[home](README.md)", "[home](Home)").encode("utf-8"))
        self.success("verify", self.destination)

    def test_balanced_and_multiline_labels_transform_navigation(self):
        self.write("Guide.md", "# Guide\n")
        for label in ("Guide [details]", "Guide\n details", "Guide [more [details]]"):
            with self.subTest(label=label):
                self.write("README.md", f"[{label}](Guide.md)\n")
                self.success("build", self.source, self.destination)
                self.assertEqual((self.destination / "Home.md").read_text(encoding="utf-8"),
                                 f"[{label}](Guide)\n")
                self.success("verify", self.destination)

    def test_balanced_and_multiline_labels_reject_missing_targets(self):
        for label in ("Guide [details]", "Guide\n details", "Guide [more [details]]"):
            with self.subTest(label=label):
                self.write("README.md", f"[{label}](Missing.md)\n")
                result = self.cli("build", self.source, self.destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Missing.md", result.stderr)
                self.assertEqual(list(self.destination.iterdir()), [])
                self.write("Home.md", f"[{label}](Missing)\n", self.destination)
                result = self.cli("verify", self.destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Missing", result.stderr)
                (self.destination / "Home.md").unlink()

    def test_code_spans_do_not_cross_paragraph_or_fence_boundaries(self):
        body = 'An unmatched ` delimiter.\n\n[guide](EN-Guide.md)\n\n`[example](Missing.md)`\n'
        self.write("README.md", body)
        self.write("EN-Guide.md", "# Guide\n")
        self.success("build", self.source, self.destination)
        self.assertEqual((self.destination / "Home.md").read_text(encoding="utf-8"),
                         body.replace("[guide](EN-Guide.md)", "[guide](EN-Guide)"))

    def test_backticks_in_link_titles_do_not_hide_following_navigation(self):
        self.write("README.md", '[guide](EN-Guide.md "literal `")\n[home](README.md)\n`code`\n')
        self.write("EN-Guide.md", "# Guide\n")
        self.success("build", self.source, self.destination)
        self.assertEqual((self.destination / "Home.md").read_text(encoding="utf-8"),
                         '[guide](EN-Guide "literal `")\n[home](Home)\n`code`\n')

    def test_reference_backticks_do_not_hide_missing_navigation(self):
        definitions = (
            '[ref]: https://example.com "literal `"',
            '[ref]: https://example.com \'literal `\'',
            '[ref]: https://example.com (literal `)',
            '[ref]: https://example.com\n  "literal `"',
            '[ref]: <https://example.com/literal`mark>',
        )
        for definition in definitions:
            with self.subTest(definition=definition):
                self.write("README.md", definition + '\n[broken](Missing.md)\n`code`\n')
                result = self.cli("build", self.source, self.destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Missing.md", result.stderr)
                self.assertEqual(list(self.destination.iterdir()), [])
                self.write("Home.md", definition + '\n[broken](Missing)\n`code`\n', self.destination)
                result = self.cli("verify", self.destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Missing", result.stderr)
                (self.destination / "Home.md").unlink()

    def test_literal_backtick_in_external_destination_does_not_hide_navigation(self):
        body = '[external](https://example.com/literal`mark.md) [home](README.md) `code`\n'
        self.write("README.md", body)
        self.success("build", self.source, self.destination)
        self.assertEqual((self.destination / "Home.md").read_text(encoding="utf-8"),
                         body.replace("[home](README.md)", "[home](Home)"))

    def test_escaped_brackets_are_not_navigation(self):
        examples = r'\[example](Missing.md) [closing\](Missing.md)' + '\n'
        self.write("README.md", examples + '[guide](EN-Guide.md)\n')
        self.write("EN-Guide.md", "# Guide\n")
        self.success("build", self.source, self.destination)
        self.assertEqual((self.destination / "Home.md").read_text(encoding="utf-8"),
                         examples + '[guide](EN-Guide)\n')

    def test_verifier_rejects_real_links_instead_of_grepping_examples(self):
        self.write("Home.md", "[guide](EN-Guide)\n", self.destination)
        self.write("EN-Guide.md", "# Guide\n", self.destination)
        for target in ("Missing", "EN-Guide.md", "README", "EN-Guide#section", "nested/Guide"):
            with self.subTest(target=target):
                self.write("EN-Guide.md", f'[bad][target]\n\n[target]: {target}\n', self.destination)
                result = self.cli("verify", self.destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(target, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_build_removes_stale_pages_but_preserves_git_and_non_page_files(self):
        self.write("README.md", "# Home\n")
        self.write("Old.md", "stale page", self.destination)
        self.write("keep.txt", "not a wiki page", self.destination)
        git = self.destination / ".git"
        git.mkdir()
        (git / "config").write_text("repository metadata", encoding="utf-8")
        self.success("build", self.source, self.destination)
        self.assertFalse((self.destination / "Old.md").exists())
        self.assertEqual((self.destination / "keep.txt").read_text(), "not a wiki page")
        self.assertEqual((git / "config").read_text(), "repository metadata")

    def test_unrelated_destination_is_not_treated_as_disposable(self):
        self.write("README.md", "# Home\n")
        self.write("Personal.md", "unrelated notes", self.destination)
        result = self.cli("build", self.source, self.destination)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("destination", result.stderr)
        self.assertEqual((self.destination / "Personal.md").read_text(), "unrelated notes")
        self.assertFalse((self.destination / "Home.md").exists())

    def test_nested_source_is_rejected_without_changing_destination(self):
        self.write("README.md", "# Home\n")
        nested = self.source / "nested"
        nested.mkdir()
        (nested / "Guide.md").write_text("not flat", encoding="utf-8")
        self.write("Home.md", "keep previous version", self.destination)
        result = self.cli("build", self.source, self.destination)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("flat", result.stderr)
        self.assertEqual((self.destination / "Home.md").read_text(), "keep previous version")
        self.assertEqual((nested / "Guide.md").read_text(), "not flat")

    def test_nested_destination_is_rejected_without_deleting_any_directory(self):
        self.write("README.md", "# Home\n")
        nested = self.destination / "keep"
        nested.mkdir()
        (nested / "Guide.md").write_text("not disposable", encoding="utf-8")
        result = self.cli("build", self.source, self.destination)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("flat", result.stderr)
        self.assertEqual((nested / "Guide.md").read_text(), "not disposable")
        self.assertFalse((self.destination / "Home.md").exists())

    def test_source_and_destination_must_not_overlap(self):
        self.write("README.md", "# Home\n")
        result = self.cli("build", self.source, self.source)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("overlap", result.stderr)
        self.assertEqual((self.source / "README.md").read_text(), "# Home\n")
        self.assertFalse((self.source / "Home.md").exists())

    def test_source_requires_markdown_extensions_and_rejects_home_collision(self):
        self.write("README.md", "[guide](EN-Guide)\n")
        self.write("EN-Guide.md", "# Guide\n")
        result = self.cli("build", self.source, self.destination)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".md", result.stderr)
        self.assertEqual(list(self.destination.iterdir()), [])
        self.write("README.md", "# Home\n")
        self.write("Home.md", "# Colliding page\n")
        result = self.cli("build", self.source, self.destination)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Home.md", result.stderr)
        self.assertEqual(list(self.destination.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
