#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "trafilatura==2.2.0",
# ]
# ///

"""Convert one learner-approved source into provenance-bearing Markdown."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from functools import lru_cache
from importlib.metadata import version as package_version
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

import trafilatura


MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
FETCH_TIMEOUT_SECONDS = 20
USER_AGENT = "LEARN-source-converter/1.0"
MEDIA_SUFFIXES = {
    ".aac", ".aiff", ".avi", ".flac", ".m4a", ".m4v", ".mkv", ".mov",
    ".mp3", ".mp4", ".mpeg", ".mpg", ".oga", ".ogg", ".ogv", ".opus",
    ".wav", ".webm", ".wmv",
}
TEXT_SUFFIXES = {".md", ".markdown", ".mdown", ".mkd", ".txt", ".text"}
HTML_SUFFIXES = {".html", ".htm", ".xhtml"}
YOUTUBE_HOSTS = {"youtube.com", "youtu.be", "youtube-nocookie.com"}


class ConversionError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fail(message: str) -> None:
    raise ConversionError(message)


def is_url(value: str) -> bool:
    return urllib.parse.urlsplit(value).scheme.lower() in {"http", "https"}


def normalized_url(value: str) -> str:
    parts = urllib.parse.urlsplit(value)
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
        fail("only absolute HTTP(S) URLs are supported")
    if parts.username is not None or parts.password is not None:
        fail("URLs containing credentials are not accepted")
    try:
        host = parts.hostname.encode("idna").decode("ascii").lower()
        port = parts.port
    except (UnicodeError, ValueError) as exc:
        raise ConversionError(f"invalid URL: {exc}") from exc
    if ":" in host:
        host = f"[{host}]"
    default_port = (parts.scheme.lower() == "http" and port == 80) or (
        parts.scheme.lower() == "https" and port == 443
    )
    netloc = host if port is None or default_port else f"{host}:{port}"
    return urllib.parse.urlunsplit((parts.scheme.lower(), netloc, parts.path or "/", parts.query, ""))


def host_matches(url: str, domains: set[str]) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or "").lower().rstrip(".")
    return any(host == domain or host.endswith(f".{domain}") for domain in domains)


def transcript_required(source: str) -> None:
    fail(
        f"{source} is audio/video, not a transcript. LEARN v1 must not use a title, "
        "description, or media file as source content. Session manager: obtain a real "
        "caption transcript with the available browser tools, save/export it as UTF-8 "
        "text or WebVTT, then convert that file with --transcript-for, "
        "--caption-language, and --caption-type authored|automatic."
    )


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decode_utf8(data: bytes, label: str) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ConversionError(f"{label} is not valid UTF-8: {exc}") from exc


def without_frontmatter(value: str) -> str:
    if not value.startswith("---\n"):
        return value
    end = re.search(r"(?m)^---[ \t]*$", value[4:])
    return value[4 + end.end():] if end else value


def content_signal(value: str) -> int:
    value = without_frontmatter(value)
    value = re.sub(r"(?s)<!--.*?-->", " ", value)
    return sum(character.isalnum() for character in value)


def require_content(value: str | None, label: str, minimum: int = 1) -> str:
    if value is None or content_signal(value) < minimum:
        fail(f"{label} has no reliable main content (empty or metadata-only)")
    if "\x00" in value:
        fail(f"{label} contains binary NUL bytes")
    return value


def run_tool(args: list[str], timeout: int = 300, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    env = os.environ.copy()
    env.update({"LC_ALL": "C", "LANG": "C"})
    try:
        result = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            env=env,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ConversionError(f"required tool is unavailable: {args[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ConversionError(f"tool timed out after {timeout}s: {Path(args[0]).name}") from exc
    if check and result.returncode:
        detail = result.stderr.decode("utf-8", "replace").strip()[-1200:]
        raise ConversionError(f"{Path(args[0]).name} failed ({result.returncode}): {detail or 'no details'}")
    return result


@lru_cache(maxsize=None)
def tool_version(executable: str, flag: str = "--version") -> str:
    result = run_tool([executable, flag], timeout=20, check=False)
    output = (result.stdout + result.stderr).decode("utf-8", "replace").strip()
    first = output.splitlines()[0] if output else "unknown"
    match = re.search(r"\b\d+(?:\.\d+)+(?:[-+._a-zA-Z0-9]*)?", first)
    return match.group(0) if match else first[:120]


def simple_markdown_metadata(value: str) -> dict[str, str]:
    if not value.startswith("---\n"):
        return {}
    metadata: dict[str, str] = {}
    for line in value[4:].splitlines():
        if line.strip() == "---":
            break
        match = re.match(r"^(title|author|date):\s*(.*?)\s*$", line, re.IGNORECASE)
        if not match or not match.group(2):
            continue
        raw = match.group(2)
        try:
            parsed = json.loads(raw) if raw.startswith('"') else raw.strip("'")
        except json.JSONDecodeError:
            parsed = raw
        if isinstance(parsed, (str, int, float)):
            metadata[match.group(1).lower()] = str(parsed)
    return metadata


def archive_metadata(path: Path, suffix: str) -> dict[str, str]:
    try:
        with zipfile.ZipFile(path) as archive:
            if any(item.flag_bits & 1 for item in archive.infolist()):
                fail(f"{suffix[1:].upper()} is encrypted")
            names = set(archive.namelist())
            if suffix == ".docx":
                if "word/document.xml" not in names:
                    fail("DOCX is unreadable or missing word/document.xml")
                if "docProps/core.xml" not in names:
                    return {}
                root = ElementTree.fromstring(archive.read("docProps/core.xml"))
                fields = {
                    "title": "{http://purl.org/dc/elements/1.1/}title",
                    "author": "{http://purl.org/dc/elements/1.1/}creator",
                    "date": "{http://purl.org/dc/terms/}created",
                }
            else:
                if "META-INF/encryption.xml" in names:
                    fail("EPUB contains encrypted resources")
                container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
                rootfile = container.find(".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile")
                if rootfile is None or not rootfile.get("full-path"):
                    fail("EPUB is unreadable or missing its package document")
                package_path = PurePosixPath(rootfile.get("full-path", ""))
                if package_path.is_absolute() or ".." in package_path.parts:
                    fail("EPUB package path is unsafe")
                root = ElementTree.fromstring(archive.read(package_path.as_posix()))
                fields = {
                    "title": "{http://purl.org/dc/elements/1.1/}title",
                    "author": "{http://purl.org/dc/elements/1.1/}creator",
                    "date": "{http://purl.org/dc/elements/1.1/}date",
                }
            result: dict[str, str] = {}
            for key, tag in fields.items():
                values = [" ".join(item.itertext()).strip() for item in root.iter(tag)]
                values = [item for item in values if item]
                if values:
                    result[key] = "; ".join(values)
            return result
    except ConversionError:
        raise
    except (KeyError, OSError, ElementTree.ParseError, zipfile.BadZipFile) as exc:
        raise ConversionError(f"{suffix[1:].upper()} is unreadable: {exc}") from exc


def fetch_html(url: str) -> tuple[bytes, str]:
    requested = normalized_url(url)
    suffix = Path(urllib.parse.urlsplit(requested).path).suffix.lower()
    if suffix in MEDIA_SUFFIXES:
        transcript_required(url)
    request = urllib.request.Request(
        requested,
        headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml", "Accept-Encoding": "identity"},
    )
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            final_url = normalized_url(response.geturl())
            if host_matches(final_url, YOUTUBE_HOSTS):
                transcript_required(url)
            media_type = response.headers.get_content_type().lower()
            if media_type.startswith(("audio/", "video/")):
                transcript_required(url)
            if media_type not in {"text/html", "application/xhtml+xml"}:
                fail(f"URL returned {media_type}, not an HTML article; download supported documents locally")
            length = response.headers.get("Content-Length")
            if length and length.isdigit() and int(length) > MAX_DOWNLOAD_BYTES:
                fail(f"URL exceeds the {MAX_DOWNLOAD_BYTES // (1024 * 1024)} MiB download limit")
            data = response.read(MAX_DOWNLOAD_BYTES + 1)
    except ConversionError:
        raise
    except (TimeoutError, urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        raise ConversionError(f"could not fetch URL: {exc}") from exc
    if len(data) > MAX_DOWNLOAD_BYTES:
        fail(f"URL exceeds the {MAX_DOWNLOAD_BYTES // (1024 * 1024)} MiB download limit")
    if not data:
        fail("URL returned an empty response")
    return data, final_url


def is_media_page(data: bytes) -> bool:
    sample = data[:2_000_000].decode("latin-1", "ignore")
    og_video = re.search(
        r"<meta\b(?=[^>]*(?:property|name)\s*=\s*['\"]og:type['\"])(?=[^>]*content\s*=\s*['\"](?:video|audio)[^'\"]*['\"])[^>]*>",
        sample,
        re.IGNORECASE,
    )
    video_object = re.search(r"['\"]@type['\"]\s*:\s*['\"](?:Video|Audio)Object['\"]", sample, re.IGNORECASE)
    return bool(og_video or video_object)


def convert_html(data: bytes, url: str | None) -> tuple[str, dict[str, str]]:
    if is_media_page(data):
        transcript_required(url or "HTML source")
    try:
        body = trafilatura.extract(
            data,
            url=url,
            output_format="markdown",
            include_comments=False,
            include_links=True,
            include_tables=True,
        )
        document = trafilatura.bare_extraction(
            data,
            url=url,
            with_metadata=True,
            include_comments=False,
            include_links=True,
            include_tables=True,
        )
    except Exception as exc:
        raise ConversionError(f"Trafilatura failed: {exc}") from exc
    body = require_content(body, "HTML article", minimum=40)
    metadata = {}
    if document is not None:
        for key in ("title", "author", "date"):
            value = getattr(document, key, None)
            if value:
                metadata[key] = str(value).strip()
    return body, metadata


def convert_pandoc(path: Path, suffix: str) -> tuple[str, dict[str, str], str]:
    executable = shutil.which("pandoc")
    if not executable:
        fail("Pandoc is required for DOCX/EPUB conversion but is not installed")
    source_format = suffix[1:]
    result = run_tool([executable, str(path), f"--from={source_format}", "--to=gfm", "--wrap=none"])
    body = require_content(decode_utf8(result.stdout, "Pandoc output"), source_format.upper(), minimum=20)
    return body, archive_metadata(path, suffix), tool_version(executable)


def parse_pdf_info(path: Path) -> tuple[dict[str, str], int]:
    executable = shutil.which("pdfinfo")
    if not executable:
        fail("Poppler pdfinfo is required for PDF conversion but is not installed")
    result = run_tool([executable, str(path)], check=False)
    output = (result.stdout + result.stderr).decode("utf-8", "replace")
    if result.returncode:
        fail(f"PDF is encrypted or unreadable: {output.strip()[-1200:] or 'pdfinfo failed'}")
    info = {}
    for line in output.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            info[key.strip()] = value.strip()
    if info.get("Encrypted", "").lower().startswith("yes"):
        fail("PDF is encrypted")
    try:
        pages = int(info["Pages"])
    except (KeyError, ValueError) as exc:
        raise ConversionError("PDF page count is unavailable") from exc
    if pages < 1:
        fail("PDF contains no pages")
    metadata = {
        key: info[source]
        for key, source in (("title", "Title"), ("author", "Author"), ("date", "CreationDate"))
        if info.get(source)
    }
    return metadata, pages


def mark_pdf_pages(pages: list[str]) -> str:
    return "\n\n".join(
        f"<!-- page: {number} -->\n\n{page.rstrip()}".rstrip()
        for number, page in enumerate(pages, 1)
    )


def reliable_pdf_text(pages: list[str]) -> bool:
    signals = [sum(character.isalnum() for character in page) for page in pages]
    signal = sum(signals)
    populated = sum(page_signal >= 20 for page_signal in signals)
    required = max(1, (len(pages) * 4 + 4) // 5)
    return populated >= required and "".join(pages).count("\ufffd") <= max(3, signal // 20)


def page_ranges(numbers: list[int]) -> str:
    ranges: list[str] = []
    for number in numbers:
        if ranges and ranges[-1].split("-")[-1].isdigit() and number == int(ranges[-1].split("-")[-1]) + 1:
            ranges[-1] = f"{ranges[-1].split('-')[0]}-{number}"
        else:
            ranges.append(str(number))
    return ", ".join(ranges)


def convert_docling(path: Path) -> tuple[str, str]:
    executable = shutil.which("docling")
    if not executable:
        fail("Poppler found insufficient text and --docling was requested, but the docling CLI is not installed")
    help_result = run_tool([executable, "--help"], timeout=30, check=False)
    help_text = (help_result.stdout + help_result.stderr).decode("utf-8", "replace")
    command = [executable]
    if re.search(r"(?m)^\s*(?:[|│]\s*)?convert(?:\s|[|│])", help_text):
        command.append("convert")
    with tempfile.TemporaryDirectory(prefix="learn-docling-") as directory:
        destination = Path(directory)
        command.extend([
            "--from", "pdf", "--to", "md", "--output", str(destination),
            "--image-export-mode", "placeholder", str(path),
        ])
        run_tool(command, timeout=1800)
        candidates = sorted(destination.rglob("*.md"))
        exact = [candidate for candidate in candidates if candidate.stem == path.stem]
        if len(exact) == 1:
            candidates = exact
        if len(candidates) != 1:
            fail(f"Docling produced {len(candidates)} Markdown files; expected exactly one")
        body = decode_utf8(candidates[0].read_bytes(), "Docling output")
    return require_content(body, "Docling PDF output", minimum=20), tool_version(executable)


def convert_pdf(path: Path, allow_docling: bool) -> tuple[str, dict[str, str], str, str, list[str]]:
    metadata, page_count = parse_pdf_info(path)
    executable = shutil.which("pdftotext")
    if not executable:
        fail("Poppler pdftotext is required for PDF conversion but is not installed")
    poppler_version = tool_version(executable, "-v")
    result = run_tool([executable, "-layout", "-enc", "UTF-8", str(path), "-"])
    extracted = decode_utf8(result.stdout, "Poppler output").replace("\r\n", "\n").replace("\r", "\n")
    pages = extracted.split("\f")
    while len(pages) > page_count and not pages[-1].strip():
        pages.pop()
    if len(pages) < page_count:
        pages.extend([""] * (page_count - len(pages)))
    if len(pages) != page_count:
        fail(f"Poppler returned {len(pages)} page segments for a {page_count}-page PDF")
    if reliable_pdf_text(pages):
        readable = [sum(character.isalnum() for character in page) >= 20 for page in pages]
        populated = sum(readable)
        notes = [
            "Text layer extracted with layout preservation; HTML comments mark original PDF pages.",
            f"Readable text detected on {populated} of {page_count} pages.",
        ]
        if populated != page_count:
            notes.append(f"Pages with little or no extractable text: {page_ranges([i + 1 for i, ok in enumerate(readable) if not ok])}.")
        return (
            require_content(mark_pdf_pages(pages), "PDF text layer", minimum=20),
            metadata,
            "poppler-pdftotext",
            poppler_version,
            notes,
        )
    if not allow_docling:
        fail("PDF has too little reliable text; retry with --docling only after approving OCR/layout fallback")
    body, version = convert_docling(path)
    return (
        body,
        metadata,
        "docling",
        version,
        ["Poppler text was insufficient; opt-in Docling OCR/layout fallback used. Review OCR before promotion."],
    )


VTT_TIMING = re.compile(
    r"^(?P<start>(?:\d{2,}:)?\d{2}:\d{2}\.\d{3})[ \t]+-->[ \t]+"
    r"(?P<end>(?:\d{2,}:)?\d{2}:\d{2}\.\d{3})(?:[ \t]+.*)?$"
)


def timestamp_seconds(value: str) -> float:
    parts = value.split(":")
    hours, minutes, seconds = (0, int(parts[0]), float(parts[1])) if len(parts) == 2 else (
        int(parts[0]), int(parts[1]), float(parts[2])
    )
    if minutes >= 60 or seconds >= 60:
        fail(f"invalid WebVTT timestamp: {value}")
    return hours * 3600 + minutes * 60 + seconds


def clean_vtt_text(value: str) -> str:
    value = re.sub(
        r"<v(?:\.[^ >]+)*(?:\s+([^>]+))?>",
        lambda match: f"{match.group(1)}: " if match.group(1) else "",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"<[^>]*>", "", value)
    return html.unescape(value).strip()


def convert_vtt(data: bytes) -> tuple[str, dict[str, str]]:
    text = decode_utf8(data, "WebVTT transcript").lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n[ \t]*\n", text.strip())
    if not blocks or not blocks[0].splitlines() or not blocks[0].splitlines()[0].startswith("WEBVTT"):
        fail("transcript is not valid WebVTT (missing WEBVTT header)")
    header: dict[str, str] = {}
    for line in blocks[0].splitlines()[1:]:
        match = re.match(r"(?i)^Language:\s*(\S+)\s*$", line)
        if match:
            header["language"] = match.group(1)
    cues: list[str] = []
    for block in blocks[1:]:
        lines = block.splitlines()
        if not lines or lines[0].lstrip().startswith(("NOTE", "STYLE", "REGION")):
            continue
        timing_index = 0 if VTT_TIMING.match(lines[0]) else 1
        if timing_index >= len(lines) or not (match := VTT_TIMING.match(lines[timing_index])):
            fail("transcript contains a malformed WebVTT cue")
        if timestamp_seconds(match.group("end")) < timestamp_seconds(match.group("start")):
            fail("transcript contains a cue ending before it starts")
        payload = clean_vtt_text("\n".join(lines[timing_index + 1:]))
        if not payload:
            fail("transcript contains an empty WebVTT cue")
        cues.append(f"`[{match.group('start')} --> {match.group('end')}]`\n\n{payload}")
    if not cues:
        fail("transcript contains no caption cues")
    return "# Transcript\n\n" + "\n\n".join(cues), header


def infer_caption_language(path: Path) -> str | None:
    parts = path.name.split(".")
    if len(parts) >= 3 and re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", parts[-2]):
        return parts[-2]
    return None


def media_provenance(source: str) -> dict[str, str]:
    source = source.strip()
    if not source:
        fail("--transcript-for cannot be empty")
    fields = {"media_source": source}
    if not is_url(source):
        fields["canonical_media_id"] = source
        return fields
    canonical = normalized_url(source)
    if not host_matches(canonical, YOUTUBE_HOSTS):
        fields["canonical_media_url"] = canonical
        return fields
    parts = urllib.parse.urlsplit(canonical)
    path_parts = [part for part in parts.path.split("/") if part]
    video_id = path_parts[0] if parts.hostname == "youtu.be" and path_parts else None
    if not video_id and path_parts and path_parts[0] in {"embed", "live", "shorts", "v"} and len(path_parts) > 1:
        video_id = path_parts[1]
    if not video_id:
        video_id = urllib.parse.parse_qs(parts.query).get("v", [None])[0]
    if not video_id or not re.fullmatch(r"[A-Za-z0-9_-]+", video_id):
        fail("--transcript-for YouTube URL does not identify one video")
    fields["canonical_media_id"] = f"youtube:{video_id}"
    fields["canonical_media_url"] = f"https://www.youtube.com/watch?v={video_id}"
    return fields


def frontmatter(fields: dict[str, str], notes: list[str]) -> str:
    lines = ["---"]
    lines.extend(f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in fields.items() if value)
    if notes:
        lines.append("conversion_notes:")
        lines.extend(f"  - {json.dumps(note, ensure_ascii=False)}" for note in notes)
    else:
        lines.append("conversion_notes: []")
    return "\n".join(lines) + "\n---\n\n"


def atomic_write(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def convert(
    source: str,
    output: Path,
    allow_docling: bool,
    language: str | None,
    caption_type: str | None,
    transcript_for: str | None,
    canonical_destination: Path | None,
) -> None:
    retrieved_at: str
    metadata: dict[str, str]
    caption: dict[str, str] = {}
    output = output.expanduser().resolve()
    destination = (canonical_destination or output).expanduser().resolve()
    if is_url(source):
        if host_matches(source, YOUTUBE_HOSTS):
            transcript_required(source)
        if allow_docling or language or caption_type or transcript_for:
            fail("--docling and transcript/caption options apply only to supported local files")
        data, canonical = fetch_html(source)
        retrieved_at = utc_now()
        body, metadata = convert_html(data, canonical)
        source_type, converter, converter_version = "web_article", "trafilatura", package_version("trafilatura")
        canonical_key, digest = "canonical_url", sha256_bytes(data)
        notes = ["Main article content extracted; navigation, footers, and comments omitted."]
    else:
        path = Path(source).expanduser().resolve()
        if not path.is_file():
            fail(f"source is not a readable file: {path}")
        suffix = path.suffix.lower()
        if suffix in MEDIA_SUFFIXES:
            transcript_required(source)
        if allow_docling and suffix != ".pdf":
            fail("--docling is valid only for PDF input")
        is_transcript = suffix == ".vtt" or bool(transcript_for and suffix in TEXT_SUFFIXES)
        if (language or caption_type or transcript_for) and not is_transcript:
            fail("caption options require WebVTT or Markdown/text input marked with --transcript-for")
        if is_transcript and not caption_type:
            fail("transcripts require --caption-type authored|automatic")
        canonical, canonical_key = str(path), "canonical_path"
        retrieved_at, digest = utc_now(), sha256_file(path)
        if suffix in HTML_SUFFIXES:
            data = path.read_bytes()
            body, metadata = convert_html(data, path.as_uri())
            source_type, converter, converter_version = "html_article", "trafilatura", package_version("trafilatura")
            notes = ["Main article content extracted; navigation, footers, and comments omitted."]
        elif suffix in {".docx", ".epub"}:
            body, metadata, converter_version = convert_pandoc(path, suffix)
            source_type, converter = suffix[1:], "pandoc"
            notes = ["Converted to GitHub-Flavored Markdown; embedded binary media were not copied."]
        elif suffix == ".pdf":
            body, metadata, converter, converter_version, notes = convert_pdf(path, allow_docling)
            source_type = "pdf"
        elif suffix == ".vtt":
            body, vtt_header = convert_vtt(path.read_bytes())
            metadata = {}
            source_type, converter, converter_version = "vtt_transcript", "learn-vtt", "1"
            caption_language = language or vtt_header.get("language") or infer_caption_language(path)
            if not caption_language:
                fail("transcripts require --caption-language when WebVTT metadata and filename do not identify it")
            caption = {
                **(media_provenance(transcript_for) if transcript_for else {}),
                "caption_language": caption_language,
                "caption_type": caption_type,
            }
            notes = ["Caption cues retained in timestamp order; WebVTT presentation tags removed."]
        elif suffix in TEXT_SUFFIXES:
            body = decode_utf8(path.read_bytes(), "text source")
            require_content(body, "text source")
            metadata = simple_markdown_metadata(body) if suffix != ".txt" and suffix != ".text" else {}
            markdown = suffix not in {".txt", ".text"}
            source_type = "markdown" if markdown else "text"
            converter, converter_version = "utf-8-preserve", "1"
            notes = ["Original UTF-8 content preserved exactly after this provenance block."]
            if transcript_for:
                caption_language = language or infer_caption_language(path)
                if not caption_language:
                    fail("text transcripts require --caption-language when the filename does not identify it")
                source_type = f"{'markdown' if markdown else 'text'}_transcript"
                caption = {
                    **media_provenance(transcript_for),
                    "caption_language": caption_language,
                    "caption_type": caption_type,
                }
                notes.append("Transcript provenance supplied by the session manager; transcript text was not reconstructed.")
        else:
            fail(f"unsupported source type {suffix or '(no extension)'}; use HTML, DOCX, EPUB, PDF, Markdown, text, or VTT")

    fields = {
        "original_source": source,
        canonical_key: canonical,
        "canonical_markdown_path": str(destination),
        "source_type": source_type,
        **{key: metadata[key] for key in ("title", "author", "date") if metadata.get(key)},
        "retrieved_at": retrieved_at,
        "converted_at": utc_now(),
        "source_sha256": digest,
        "markdown_body_sha256": sha256_bytes(body.encode("utf-8")),
        "converter": converter,
        "converter_version": converter_version,
        **caption,
    }
    notes.append("markdown_body_sha256 covers the UTF-8 Markdown body, excluding provenance frontmatter.")
    atomic_write(output, frontmatter(fields, notes) + body)


def check() -> None:
    pages = mark_pdf_pages(["one", "two"])
    assert "<!-- page: 1 -->\n\none" in pages and "<!-- page: 2 -->\n\ntwo" in pages
    assert reliable_pdf_text(["readable words " * 3] * 3)
    assert not reliable_pdf_text(["readable words " * 3] + [""] * 199)
    assert page_ranges([1, 2, 3, 7, 9, 10]) == "1-3, 7, 9-10"
    transcript, _ = convert_vtt(
        b"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ada>Hello &amp; welcome</v>\n"
    )
    assert "`[00:00:01.000 --> 00:00:02.000]`" in transcript and "Ada: Hello & welcome" in transcript
    original = "---\ntitle: \"Kept\"\n---\n# Body\nline  \n"
    fields = {
        "original_source": "input.md",
        "canonical_path": "/tmp/input.md",
        "canonical_markdown_path": "/tmp/output.md",
        "source_type": "markdown",
        "retrieved_at": "2026-01-01T00:00:00Z",
        "converted_at": "2026-01-01T00:00:00Z",
        "source_sha256": "abc",
        "markdown_body_sha256": sha256_bytes(original.encode("utf-8")),
        "converter": "utf-8-preserve",
        "converter_version": "1",
    }
    rendered = frontmatter(fields, ["note"]) + original
    assert rendered.endswith(original)
    assert list(fields) == [
        "original_source", "canonical_path", "canonical_markdown_path", "source_type", "retrieved_at",
        "converted_at", "source_sha256", "markdown_body_sha256", "converter", "converter_version",
    ]
    assert media_provenance("https://youtu.be/dQw4w9WgXcQ")["canonical_media_id"] == "youtube:dQw4w9WgXcQ"
    with tempfile.TemporaryDirectory(prefix="learn-converter-check-") as directory:
        root = Path(directory)
        vtt_source, vtt_output = root / "captions.en.vtt", root / "captions.md"
        vtt_source.write_bytes(
            b"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA genuine caption\n"
        )
        convert(
            str(vtt_source), vtt_output, False, None, "authored",
            "https://youtu.be/dQw4w9WgXcQ", root / "knowledge-bank.md",
        )
        vtt_result = vtt_output.read_text(encoding="utf-8")
        assert 'canonical_media_id: "youtube:dQw4w9WgXcQ"' in vtt_result
        assert 'caption_language: "en"' in vtt_result and 'caption_type: "authored"' in vtt_result
        source, output = root / "empty.txt", root / "out.md"
        source.write_text("", encoding="utf-8")
        output.write_text("KEEP", encoding="utf-8")
        try:
            convert(str(source), output, False, None, None, None, None)
        except ConversionError:
            pass
        else:
            raise AssertionError("empty input unexpectedly converted")
        assert output.read_text(encoding="utf-8") == "KEEP"
    print("LEARN source converter checks passed")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", help="HTTP(S) article URL or supported local source")
    parser.add_argument("output", nargs="?", type=Path, help="canonical Markdown output path")
    parser.add_argument("--docling", action="store_true", help="allow installed Docling as fallback for a difficult PDF")
    parser.add_argument("--caption-language", metavar="BCP47", help="caption language, e.g. en or en-US")
    parser.add_argument("--caption-type", choices=("authored", "automatic"), help="caption provenance")
    parser.add_argument("--transcript-for", metavar="URL_OR_ID", help="media source represented by a local transcript")
    parser.add_argument(
        "--canonical-destination",
        type=Path,
        metavar="PATH",
        help="final knowledge-bank path when OUTPUT is only a staging path",
    )
    parser.add_argument("--check", action="store_true", help="run the offline self-check")
    args = parser.parse_args(argv)
    if args.check:
        if any((
            args.source, args.output, args.docling, args.caption_language, args.caption_type,
            args.transcript_for, args.canonical_destination,
        )):
            parser.error("--check cannot be combined with conversion arguments")
        check()
        return 0
    if not args.source or not args.output:
        parser.error("SOURCE and OUTPUT are required unless --check is used")
    if args.caption_language and not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", args.caption_language):
        parser.error("--caption-language must be a BCP 47-style tag such as en or en-US")
    try:
        convert(
            args.source,
            args.output,
            args.docling,
            args.caption_language,
            args.caption_type,
            args.transcript_for,
            args.canonical_destination,
        )
    except (ConversionError, OSError) as exc:
        print(f"LEARN converter: {exc}", file=sys.stderr)
        return 1
    print(f"Converted {args.source} -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
