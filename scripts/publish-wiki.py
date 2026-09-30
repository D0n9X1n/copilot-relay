#!/usr/bin/env python3
"""Build and verify the flat GitHub wiki without rewriting Markdown code examples."""
import argparse
from pathlib import Path
import re
import sys
from typing import NamedTuple

PAGE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*\.md\Z")
EXTERNAL = re.compile(r"(?:[A-Za-z][A-Za-z0-9+.-]*:|//|#)")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
CONTAINER = re.compile(r" {0,3}(?:(?P<quote>>)[ ]?|(?:[-+*]|\d{1,9}[.)])(?: {1,4}(?! )| (?= {4})))")
DESTINATION = r"(?:<(?P<angle>[^<>\s]+)>|(?P<bare>[^\s()<>]+))"
TITLE = r"(?:\"[^\"]*\"|'[^']*'|\([^)]*\))"
INLINE_DESTINATION = re.compile(
    r"\([ \t\n]*" + DESTINATION + r"(?:[ \t\n]+" + TITLE + r")?[ \t\n]*\)"
)
REFERENCE_LABEL = re.compile(r"\[(?:\\.|[^\\\[\]\r\n])+\]:[ \t]*")
REFERENCE_DESTINATION = re.compile(DESTINATION)
REFERENCE_TITLE = re.compile(TITLE)


class ProseLine(NamedTuple):
    start: int
    end: int
    content: str
    scope: tuple
    block_start: bool
    new_container: bool


class Reference(NamedTuple):
    start: int
    end: int
    protected_end: int
    last_line: int


def reference_at(lines, index):
    """Parse one definition with at most one following destination/title line."""
    first = lines[index]
    label = REFERENCE_LABEL.match(first.content)
    if not first.block_start:
        return None
    if not label:
        candidate = first.content
        for following in lines[index + 1:]:
            if following.scope != first.scope or following.new_container or not following.content:
                break
            candidate += "\n" + following.content
            if re.match(r"\[(?:\\.|[^\\\[\]])+\]:", candidate):
                raise ValueError("unsupported multiline reference label; use one line")
            if not re.fullmatch(r"\[(?:\\.|[^\\\[\]])*", candidate):
                break
        return None
    line = first
    position = label.end()
    if position == len(line.content):
        index += 1
        if (index >= len(lines) or lines[index].scope != first.scope
                or lines[index].new_container or not lines[index].content):
            raise ValueError("reference definition needs a destination on this or the next line")
        line = lines[index]
        position = 0
    match = REFERENCE_DESTINATION.match(line.content, position)
    if not match:
        raise ValueError("unsupported reference destination")
    start, end = match.span("angle" if match["angle"] is not None else "bare")
    tail = line.content[match.end():]
    protected_end = line.start + match.end()
    if tail.strip():
        if not tail[0].isspace() or not REFERENCE_TITLE.fullmatch(tail.strip()):
            raise ValueError("unsupported reference title; use one line")
        protected_end = line.start + len(line.content)
    elif index + 1 < len(lines):
        following = lines[index + 1]
        if following.scope == first.scope and not following.new_container:
            title = following.content.strip()
            if title.startswith(('"', "'", "(")) and not REFERENCE_TITLE.fullmatch(title):
                raise ValueError("unsupported reference title; use one line")
            if REFERENCE_TITLE.fullmatch(title):
                index += 1
                protected_end = following.start + len(following.content)
    return Reference(line.start + start, line.start + end, protected_end, index)


def references(lines):
    index = 0
    while index < len(lines):
        reference = reference_at(lines, index)
        if reference:
            yield reference
            index = reference.last_line
        index += 1


def inline_links(markdown):
    """Match destinations after balanced labels, including soft line breaks."""
    labels = []
    position = 0
    while position < len(markdown):
        character = markdown[position]
        if character == "\\":
            position += 2
            continue
        if character == "[":
            labels.append(position)
        elif character == "]" and labels:
            labels.pop()
            match = INLINE_DESTINATION.match(markdown, position + 1)
            if match:
                yield match
                position = match.end()
                continue
        elif character == "\n" and re.match(r"[ \t\r]*\n", markdown[position + 1:]):
            labels.clear()
        position += 1


def blank(text):
    return "".join(character if character in "\r\n" else " " for character in text)


def source_column(line, column):
    """Map a tab-expanded layout column back to an original string offset."""
    expanded = 0
    for index, character in enumerate(line):
        if expanded >= column:
            return index
        expanded += 4 - expanded % 4 if character == "\t" else 1
    return len(line)


def block_lines(markdown):
    """Keep prose offsets while tracking paragraphs, containers and code blocks."""
    visible = []
    lines = []
    containers = []
    fence = None
    paragraph = False
    reference_stage = None
    reference_scope = ()
    offset = 0
    for raw in markdown.splitlines(keepends=True):
        original = raw.rstrip("\r\n")
        content = original.expandtabs(4)
        continued = []
        for quote, width in containers:
            if quote:
                prefix = re.match(r" {0,3}>[ ]?", content)
                if not prefix:
                    break
                content = content[prefix.end():]
            elif content.startswith(" " * width):
                content = content[width:]
            elif content.strip():
                break
            continued.append((quote, width))
        same_container = len(continued) == len(containers)
        containers = continued
        masked = False
        new_container = False
        reference_continuation = False
        if fence and same_container:
            masked = True
            match = FENCE.match(content)
            if match and match[1][0] == fence[0] and len(match[1]) >= len(fence) and not match[2].strip():
                fence = None
        else:
            fence = None
            while prefix := CONTAINER.match(content):
                containers.append((prefix["quote"] is not None, 0 if prefix["quote"] else prefix.end()))
                content = content[prefix.end():]
                paragraph = False
                reference_stage = None
                new_container = True
            scope = tuple(containers)
            indentation = len(content) - len(content.lstrip(" "))
            prose = content.lstrip(" ")
            reference_continuation = reference_scope == scope and (
                reference_stage == "destination" and bool(prose)
                or reference_stage == "title" and bool(REFERENCE_TITLE.fullmatch(prose))
            )
            match = FENCE.match(content)
            if match and (match[1][0] == "~" or "`" not in match[2]):
                fence = match[1]
                masked = True
            elif indentation >= 4 and not paragraph and not reference_continuation:
                masked = True
        scope = tuple(containers)
        if masked or not content.strip():
            visible.append(blank(raw))
            lines.append(ProseLine(offset, offset + len(raw), "", scope, False, new_container))
            paragraph = False
            reference_stage = None
        else:
            column = len(original.expandtabs(4)) - len(content.lstrip(" "))
            start = source_column(original, column)
            prose = original[start:]
            block_start = not paragraph and not reference_continuation
            lines.append(ProseLine(offset + start, offset + len(raw), prose, scope, block_start, new_container))
            visible.append(blank(raw[:start]) + raw[start:])
            label = REFERENCE_LABEL.match(prose) if block_start else None
            if reference_continuation:
                reference_stage = "title" if reference_stage == "destination" else None
                paragraph = False
            elif label:
                reference_stage = "destination" if not prose[label.end():].strip() else "title"
                reference_scope = scope
                paragraph = False
            else:
                reference_stage = None
                # Indented code cannot interrupt an active paragraph. Blank lines,
                # headings, fences and container changes establish block boundaries.
                paragraph = not re.match(r"(?:#{1,6}(?:\s|$)|(?:=+|-+|(?:\*\s*){3,}|(?:_\s*){3,})$)", prose)
        offset += len(raw)
    return "".join(visible), lines


def outside_code(markdown):
    """Mask code, keeping offsets so replacements preserve every other byte."""
    visible, lines = block_lines(markdown)
    definitions = list(references(lines))
    # Destinations and titles do not parse inline markup. Leave their backticks
    # alone rather than letting one consume the next prose code span.
    link_tails = {match.start("angle" if match["angle"] is not None else "bare"): match.end()
                  for match in inline_links(visible)}
    link_tails.update({reference.start: reference.protected_end for reference in definitions})
    result = list(visible)
    position = 0
    while position < len(visible):
        if position in link_tails:
            position = link_tails[position]
            continue
        if visible[position] == "\\":
            position += 2
            continue
        if visible[position] != "`":
            position += 1
            continue
        opening = re.match(r"`+", visible[position:])[0]
        remaining = visible[position + len(opening):]
        end = re.search(r"(?<!`)" + opening + r"(?!`)", remaining)
        # Inline spans cannot consume another paragraph (or a masked code block).
        if end and not re.search(r"\n[ \t\r]*\n", remaining[:end.start()]):
            stop = position + len(opening) + end.end()
            result[position:stop] = blank(visible[position:stop])
            position = stop
        else:
            position += len(opening)
    return "".join(result), definitions


def links(markdown):
    """Find inline and reference destinations outside code, with source offsets."""
    visible, definitions = outside_code(markdown)
    spans = [(reference.start, reference.end) for reference in definitions]
    spans.extend(match.span("angle" if match["angle"] is not None else "bare")
                 for match in inline_links(visible))
    return sorted((start, end, markdown[start:end]) for start, end in set(spans))


def transform(markdown):
    result = markdown
    for start, end, target in reversed(list(links(markdown))):
        if PAGE.fullmatch(target):
            target = "Home" if target == "README.md" else target[:-3]
            result = result[:start] + target + result[end:]
    return result


def page_files(directory):
    if not directory.is_dir():
        raise ValueError(f"wiki directory does not exist: {directory}")
    pages = []
    for entry in sorted(directory.iterdir()):
        if entry.name == ".git":
            continue
        if entry.is_symlink() or entry.is_dir():
            raise ValueError(f"wiki must be flat, without symlinks: {entry}")
        if entry.suffix == ".md":
            if not PAGE.fullmatch(entry.name):
                raise ValueError(f"unsupported wiki page name: {entry.name}")
            pages.append(entry)
    return pages


def read_pages(directory):
    # Decode without universal-newline conversion: code examples are byte-exact.
    return {page.name: page.read_bytes().decode("utf-8") for page in page_files(directory)}


def verify(pages, source=False):
    required = "README.md" if source else "Home.md"
    forbidden = "Home.md" if source else "README.md"
    if required not in pages or forbidden in pages:
        raise ValueError(f"wiki must contain {required} and not {forbidden}")
    for name, body in pages.items():
        for _, _, target in links(body):
            if EXTERNAL.match(target):
                continue
            if source:
                if not PAGE.fullmatch(target) or target not in pages:
                    raise ValueError(f"{name}: source links need an existing flat .md page, without anchors: {target}")
            elif target.endswith(".md") or not PAGE.fullmatch(target + ".md") or target + ".md" not in pages:
                raise ValueError(f"{name}: invalid or missing published page: {target}")


def build(source, destination):
    source, destination = source.resolve(), destination.resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("source and destination must not overlap")
    originals = read_pages(source)
    verify(originals, source=True)
    existing = page_files(destination)
    if any(destination.iterdir()) and not (destination / ".git").exists() and not (destination / "Home.md").is_file():
        raise ValueError("destination must be empty or an existing wiki checkout/build")
    pages = {"Home.md" if name == "README.md" else name: transform(body)
             for name, body in originals.items()}
    verify(pages)
    for name, body in pages.items():
        (destination / name).write_text(body, encoding="utf-8", newline="")
    # Only old, top-level page files are ours to remove. Never remove directories.
    for page in existing:
        if page.name not in pages:
            page.unlink()
    return len(pages)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build", help="transform source into an existing flat wiki folder")
    build_parser.add_argument("source", type=Path)
    build_parser.add_argument("destination", type=Path)
    verify_parser = commands.add_parser("verify", help="check published links outside Markdown code")
    verify_parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "build":
            count = build(args.source, args.destination)
            print(f"Built {count} wiki pages")
        else:
            pages = read_pages(args.directory)
            verify(pages)
            print(f"Verified {len(pages)} wiki pages")
    except (OSError, ValueError) as error:
        print(f"wiki {args.command} failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
