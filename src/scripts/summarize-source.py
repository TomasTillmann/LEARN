#!/usr/bin/env python3
"""Safely stage canonical Markdown using the released Summarize CLI."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlsplit


MIN_SUMMARIZE = (0, 21, 11)
MAX_LOCAL_BYTES = 2 * 1024 * 1024 * 1024
MAX_STDOUT_BYTES = 64 * 1024 * 1024
MAX_STDERR_BYTES = 1024 * 1024
MAX_TIMEOUT_SECONDS = 24 * 60 * 60
VERSION_RE = re.compile(r"(?<!\d)v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?")
LANGUAGE_RE = re.compile(r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$")
TIMEOUT_RE = re.compile(r"^(\d+)(ms|s|m)?$")
ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
SECRET_QUERY_NAMES = {"auth", "authorization", "code", "jwt", "key", "sig"}
SECRET_QUERY_SUFFIXES = (
    "accesskey", "apikey", "credential", "password", "passwd", "secret", "signature", "token"
)


class ConversionError(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def copy_and_hash(source_path: Path, destination: Path) -> str:
    digest = hashlib.sha256()
    copied = 0
    with source_path.open("rb") as source, destination.open("xb") as target:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            copied += len(chunk)
            if copied > MAX_LOCAL_BYTES:
                raise ConversionError("local source exceeds the 2 GiB safety limit")
            digest.update(chunk)
            target.write(chunk)
    return digest.hexdigest()


def is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def sanitize_diagnostic(data: bytes, limit: int = 4000) -> str:
    value = ANSI_RE.sub("", data.decode("utf-8", "replace"))
    value = "".join(character for character in value if character in "\n\t" or character.isprintable())
    return value.strip()[-limit:]


def compact_diagnostic(value: object, limit: int = 4000) -> str | None:
    if value in (None, {}, []):
        return None
    rendered = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    return rendered if len(rendered) <= limit else rendered[: limit - 1] + "…"


def parse_timeout(value: str) -> float:
    match = TIMEOUT_RE.fullmatch(value)
    if not match:
        raise ConversionError("timeout must look like 5000ms, 30s, or 2m")
    digits = match.group(1)
    if len(digits) > 9:
        raise ConversionError("timeout exceeds the 24-hour safety limit")
    amount = int(digits)
    unit = match.group(2) or "s"
    if amount <= 0:
        raise ConversionError("timeout must be positive")
    seconds = amount / 1000 if unit == "ms" else amount * (60 if unit == "m" else 1)
    if seconds > MAX_TIMEOUT_SECONDS:
        raise ConversionError("timeout exceeds the 24-hour safety limit")
    return seconds


def parse_version(text: str) -> tuple[int, int, int]:
    match = VERSION_RE.search(text)
    if not match or match.group(4):
        raise ConversionError("Summarize must report a stable semantic version")
    return tuple(int(match.group(index)) for index in range(1, 4))


def terminate(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGTERM)
        elif os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        else:
            proc.terminate()
    except (OSError, subprocess.SubprocessError):
        try:
            if proc.poll() is None:
                proc.terminate()
        except OSError:
            pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    if proc.poll() is None:
        try:
            if os.name == "posix":
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
        except OSError:
            try:
                if proc.poll() is None:
                    proc.kill()
            except OSError:
                pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


def run_process(
    command: list[str],
    cwd: Path,
    timeout: float,
    env: dict[str, str],
    stdout_limit: int = MAX_STDOUT_BYTES,
    stderr_limit: int = MAX_STDERR_BYTES,
) -> tuple[bytes, bytes]:
    kwargs: dict[str, object] = {
        "cwd": cwd,
        "env": env,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
    }
    if os.name == "posix":
        kwargs["start_new_session"] = True
    elif hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        proc = subprocess.Popen(command, **kwargs)
    except OSError as error:
        raise ConversionError(f"could not start Summarize: {error}") from error

    captures: dict[str, tuple[bytes, OSError | None]] = {}
    overflow = threading.Event()

    def drain(label: str, stream, limit: int) -> None:
        data = bytearray()
        problem = None
        try:
            for chunk in iter(lambda: stream.read(64 * 1024), b""):
                remaining = limit + 1 - len(data)
                if remaining > 0:
                    data.extend(chunk[:remaining])
                if len(data) > limit:
                    overflow.set()
        except OSError as error:
            problem = error
        finally:
            stream.close()
            captures[label] = (bytes(data), problem)

    assert proc.stdout is not None and proc.stderr is not None
    threads = [
        threading.Thread(target=drain, args=("stdout", proc.stdout, stdout_limit), daemon=True),
        threading.Thread(target=drain, args=("stderr", proc.stderr, stderr_limit), daemon=True),
    ]
    for thread in threads:
        thread.start()

    deadline = time.monotonic() + timeout
    while proc.poll() is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            terminate(proc)
            for thread in threads:
                thread.join(timeout=2)
            raise ConversionError(f"Summarize timed out after {timeout:g} seconds")
        if overflow.wait(min(0.05, remaining)):
            terminate(proc)
            break

    for thread in threads:
        thread.join(timeout=2)
    if any(thread.is_alive() for thread in threads):
        terminate(proc)
        raise ConversionError("Summarize output streams did not close")
    for label, limit in (("stdout", stdout_limit), ("stderr", stderr_limit)):
        data, problem = captures[label]
        if problem is not None:
            raise ConversionError(f"could not read Summarize {label}: {problem}") from problem
        if len(data) > limit:
            raise ConversionError(f"Summarize {label} exceeds the {limit} byte safety limit")
    stdout, _ = captures["stdout"]
    stderr, _ = captures["stderr"]
    if proc.returncode:
        detail = sanitize_diagnostic(stderr)
        raise ConversionError(
            f"Summarize exited with status {proc.returncode}"
            + (f": {detail}" if detail else "")
        )
    return stdout, stderr


def resolve_binary(override: str | None = None) -> str:
    binary = override or shutil.which("summarize")
    if not binary:
        raise ConversionError(
            "Summarize >=0.21.11 is required. Install it explicitly with "
            "`brew install summarize` or `npm install --global @steipete/summarize`."
        )
    candidate = Path(binary).expanduser()
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise ConversionError(f"Summarize executable is missing or not executable: {binary}")
    return str(candidate.resolve())


def require_supported_version(binary: str, workdir: Path, env: dict[str, str]) -> str:
    stdout, _ = run_process([binary, "--version"], workdir, 10, env)
    try:
        rendered = stdout.decode("utf-8", "strict").strip()
    except UnicodeDecodeError as error:
        raise ConversionError("Summarize version output is not UTF-8") from error
    version = parse_version(rendered)
    if version < MIN_SUMMARIZE:
        floor = ".".join(map(str, MIN_SUMMARIZE))
        raise ConversionError(f"Summarize {floor} or newer is required; found {rendered}")
    return ".".join(map(str, version))


def is_remote(value: str) -> bool:
    try:
        scheme = urlsplit(value).scheme.lower()
    except ValueError as error:
        if "://" in value or value.lower().startswith(("http:", "https:")):
            raise ConversionError(f"malformed source URL: {error}") from error
        return False
    if scheme in {"http", "https"}:
        return True
    if "://" in value:
        raise ConversionError("source URL must use HTTP or HTTPS")
    return False


def validate_remote(value: str) -> str:
    if len(value) > 8192 or any(character.isspace() or ord(character) < 32 for character in value):
        raise ConversionError("source URL contains whitespace/control characters or is too long")
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError as error:
        raise ConversionError(f"malformed source URL: {error}") from error
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ConversionError("source URL must be absolute HTTP(S)")
    if parsed.username is not None or parsed.password is not None:
        raise ConversionError("source URL credentials are not allowed")
    try:
        query_keys = (key for key, _ in parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=200))
        normalized = (re.sub(r"[^a-z0-9]", "", key.casefold()) for key in query_keys)
        if any(key in SECRET_QUERY_NAMES or key.endswith(SECRET_QUERY_SUFFIXES) for key in normalized):
            raise ConversionError("credential-bearing source URL query parameters are not allowed")
    except ValueError as error:
        raise ConversionError(f"malformed source URL query: {error}") from error
    host = parsed.hostname.rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost"):
        raise ConversionError("localhost sources are not allowed")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ConversionError("private, loopback, and link-local source addresses are not allowed")
    return parsed._replace(fragment="").geturl()


def resolve_local(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise ConversionError(f"local source is not a regular file: {value}")
    if path.stat().st_size > MAX_LOCAL_BYTES:
        raise ConversionError("local source exceeds the 2 GiB safety limit")
    return path


def same_file(left: Path, right: Path) -> bool:
    if left == right:
        return True
    try:
        return left.exists() and right.exists() and os.path.samefile(left, right)
    except OSError as error:
        raise ConversionError(f"could not verify path identity: {error}") from error


def validate_paths(source: Path | None, raw_output: Path, raw_destination: Path, output: Path, destination: Path) -> None:
    if output.suffix.lower() != ".md" or destination.suffix.lower() != ".md":
        raise ConversionError("staged output and canonical destination must be Markdown files")
    if destination.parent.name != "knowledge_bank" or len(destination.parents) < 6 or destination.parents[2].name != "topics" or destination.parents[4].name != "projects":
        raise ConversionError("canonical destination must be knowledge_bank/<source-id>.md")
    if raw_output.is_symlink() or raw_destination.is_symlink() or output.is_dir() or destination.is_dir():
        raise ConversionError("output paths must be ordinary files, not directories or symlinks")
    if same_file(output, destination):
        raise ConversionError("staged output and canonical destination must be different files")
    if source is not None:
        if same_file(source, output):
            raise ConversionError("source and staged output must be different files")
        if same_file(source, destination):
            raise ConversionError("source and canonical destination must be different files")
    workspace_root = destination.parents[5]
    if not is_within(Path(tempfile.gettempdir()).resolve(), output):
        raise ConversionError("staged output must be inside the OS temporary directory")
    if is_within(workspace_root, output):
        raise ConversionError("staged output must be outside the workspace")
    try:
        output.relative_to(destination.parent)
    except ValueError:
        pass
    else:
        raise ConversionError("staged output must be outside the canonical knowledge_bank directory")


def strip_frontmatter_and_comments(markdown: str) -> str:
    inspected = markdown.lstrip("\ufeff")
    lines = inspected.splitlines()
    if lines and lines[0].strip() == "---":
        for index, line in enumerate(lines[1:], 1):
            if line.strip() in {"---", "..."}:
                inspected = "\n".join(lines[index + 1 :])
                break
    return re.sub(r"<!--.*?-->", "", inspected, flags=re.DOTALL)


def validate_markdown(markdown: str) -> None:
    if "\x00" in markdown:
        raise ConversionError("Summarize extraction contains a NUL byte")
    if not any(character.isalnum() for character in strip_frontmatter_and_comments(markdown)):
        raise ConversionError("Summarize returned no substantive Markdown content")


def yaml_value(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def build_markdown(
    body: bytes,
    original: str,
    local_source: Path | None,
    destination: Path,
    source_hash: str | None,
    body_hash: str,
    version: str,
    transcript_for: str | None,
    caption_language: str | None,
    caption_type: str | None,
) -> bytes:
    fields: list[tuple[str, str | None]] = [
        ("original_source", original),
        ("source_path", str(local_source) if local_source is not None else None),
        ("source_url", original if local_source is None else None),
        ("canonical_markdown_path", f"knowledge_bank/{destination.name}"),
        ("converted_at", datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")),
        ("source_sha256", source_hash),
        ("markdown_body_sha256", body_hash),
        ("converter", "steipete/summarize"),
        ("converter_version", version),
        ("media_source", transcript_for),
        ("caption_language", caption_language),
        ("caption_type", caption_type),
        (
            "conversion_notes",
            "Extracted with Summarize; inspect source scope and figure/transcript fidelity before promotion.",
        ),
    ]
    header = ["---"]
    header.extend(f"{key}: {yaml_value(value)}" for key, value in fields if value is not None)
    header.extend(["---", "", ""])
    try:
        return "\n".join(header).encode("utf-8") + body
    except UnicodeEncodeError as error:
        raise ConversionError("provenance contains invalid Unicode") from error


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=path.parent, prefix=f".{path.name}.", delete=False
        ) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, 0o600)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def convert(
    source_value: str,
    output_value: str,
    destination_value: str,
    transcript_for: str | None = None,
    caption_language: str | None = None,
    caption_type: str | None = None,
    timeout_value: str = "2m",
    *,
    binary_override: str | None = None,
    hard_timeout: float | None = None,
) -> dict[str, str]:
    transcript_values = (transcript_for, caption_language, caption_type)
    if any(transcript_values) and not all(transcript_values):
        raise ConversionError("transcript metadata flags must be supplied together")
    if caption_type is not None and caption_type not in {"authored", "automatic"}:
        raise ConversionError("caption type must be authored or automatic")
    if caption_language is not None and not LANGUAGE_RE.fullmatch(caption_language):
        raise ConversionError("caption language must be a BCP-47-style language tag")
    if transcript_for is not None and is_remote(transcript_for):
        transcript_for = validate_remote(transcript_for)

    remote = is_remote(source_value)
    local_source = None if remote else resolve_local(source_value)
    source = validate_remote(source_value) if remote else str(local_source)
    if transcript_for is not None and local_source is None:
        raise ConversionError("transcript metadata is only valid for a supplied local transcript")

    raw_output = Path(output_value).expanduser()
    raw_destination = Path(destination_value).expanduser()
    if raw_output.is_symlink() or raw_destination.is_symlink():
        raise ConversionError("output paths must be ordinary files, not directories or symlinks")
    output = raw_output.resolve()
    destination = raw_destination.resolve()
    validate_paths(local_source, raw_output, raw_destination, output, destination)
    requested_timeout = parse_timeout(timeout_value)

    environment = os.environ.copy()
    environment["NO_COLOR"] = "1"
    binary = resolve_binary(binary_override)
    with tempfile.TemporaryDirectory(prefix="learn-summarize-") as temporary_name:
        workdir = Path(temporary_name)
        isolated_home = workdir / "home"
        isolated_home.mkdir()
        environment.update(
            {
                "HOME": str(isolated_home),
                "USERPROFILE": str(isolated_home),
                "XDG_CACHE_HOME": str(isolated_home / ".cache"),
                "XDG_CONFIG_HOME": str(isolated_home / ".config"),
            }
        )
        version = require_supported_version(binary, workdir, environment)
        source_hash = None
        cli_source = source
        if local_source is not None:
            snapshot = workdir / f"source{local_source.suffix.lower()}"
            source_hash = copy_and_hash(local_source, snapshot)
            cli_source = str(snapshot)

        command = [
            binary,
            cli_source,
            "--extract",
            "--format",
            "md",
            "--json",
            "--no-cache",
            "--no-media-cache",
            "--no-slides",
            "--no-slides-ocr",
            "--markdown-mode",
            "readability",
            "--metrics",
            "off",
            "--timeout",
            timeout_value,
        ]
        stdout, stderr = run_process(
            command,
            workdir,
            hard_timeout if hard_timeout is not None else requested_timeout + 10,
            environment,
        )
        try:
            payload = json.loads(stdout.decode("utf-8", "strict"))
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError) as error:
            raise ConversionError(
                "Summarize stdout must be UTF-8 JSON with extracted.content"
            ) from error
        if not isinstance(payload, dict) or any(field not in payload for field in ("input", "env", "extracted", "prompt", "llm", "metrics", "summary")):
            raise ConversionError("Summarize stdout does not match the stable JSON envelope")
        if not isinstance(payload["input"], dict) or not isinstance(payload["env"], dict):
            raise ConversionError("Summarize input and env diagnostics must be objects")
        if payload["input"].get("markdownMode") not in (None, "readability"):
            raise ConversionError("Summarize did not honor the required readability Markdown mode")
        extracted = payload["extracted"]
        if not isinstance(extracted, dict):
            raise ConversionError("Summarize extracted must be an object")
        body = extracted.get("content")
        if not isinstance(body, str):
            raise ConversionError("Summarize extracted.content must be a string")
        if extracted.get("truncated") is True:
            raise ConversionError("Summarize reported a truncated extraction")
        if extracted.get("truncated") not in (None, False):
            raise ConversionError("Summarize extracted.truncated must be boolean when present")
        if payload["llm"] is not None or payload["summary"] is not None:
            raise ConversionError("Summarize extraction unexpectedly returned LLM or summary output")
        validate_markdown(body)
        try:
            body_bytes = body.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ConversionError("Summarize extracted.content contains invalid Unicode") from error
        body_hash = sha256_bytes(body_bytes)
        rendered = build_markdown(
            body_bytes,
            source if remote else source_value,
            local_source,
            destination,
            source_hash,
            body_hash,
            version,
            transcript_for,
            caption_language,
            caption_type,
        )
        atomic_write(output, rendered)

    return {
        "output": str(output),
        "canonicalDestination": str(destination),
        "converter": "steipete/summarize",
        "converterVersion": version,
        "markdownBodySha256": body_hash,
        **({"extractionDiagnostics": diagnostic} if (diagnostic := compact_diagnostic(extracted.get("diagnostics"))) else {}),
        **({"stderrDiagnostics": diagnostic} if (diagnostic := sanitize_diagnostic(stderr)) else {}),
        **({"sourceSha256": source_hash} if source_hash else {}),
    }


def expect_error(action, text: str) -> None:
    try:
        action()
    except (ConversionError, OSError) as error:
        assert text.lower() in str(error).lower(), (text, str(error))
    else:
        raise AssertionError(f"expected ConversionError containing {text!r}")


def check() -> None:
    with tempfile.TemporaryDirectory(prefix="learn-converter-check-") as temporary_name:
        root = Path(temporary_name)
        fake = root / "summarize"
        log = root / "arguments.jsonl"
        fake.write_text(
            """#!/usr/bin/env python3
import json, os, sys, time
if sys.argv[1:] == ["--version"]:
    print(os.environ.get("FAKE_VERSION", "0.21.11")); raise SystemExit
with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(sys.argv[1:]) + "\\n")
mode = os.environ.get("FAKE_MODE", "ok")
if mode == "sleep": time.sleep(60)
if mode == "flood": sys.stdout.write("x" * 4096); raise SystemExit
if mode == "malformed": print("not-json"); raise SystemExit
if mode == "failed": print("\\x1b[31mfailure\\x1b[0m\\x01", file=sys.stderr); raise SystemExit(7)
body = "ok\\ud800" if mode == "surrogate" else os.environ.get("FAKE_BODY", "# Default\\n")
print("\\x1b[33mwarning\\x1b[0m\\x01", file=sys.stderr)
print(json.dumps({
    "input": {}, "env": {},
    "extracted": {"content": body, "truncated": mode == "truncated", "diagnostics": {"route": "fake"}},
    "prompt": "", "llm": {"provider": "fake"} if mode == "llm" else None,
    "metrics": None, "summary": None,
}))
""",
            encoding="utf-8",
        )
        fake.chmod(0o700)
        source = root / "source.md"
        source.write_text("original bytes\n", encoding="utf-8")
        workspace = root / "workspace"
        bank = workspace / "projects" / "p" / "topics" / "t" / "knowledge_bank"
        bank.mkdir(parents=True)
        destination = bank / "source.md"
        stage = root / "stage" / "source.md"
        stage.parent.mkdir()
        stage.write_text("replace me", encoding="utf-8")
        body = "# Exact body\n\nAlpha: beta.\n"
        os.environ.update(
            {"FAKE_VERSION": "0.21.11", "FAKE_BODY": body, "FAKE_LOG": str(log), "FAKE_MODE": "ok"}
        )

        result = convert(str(source), str(stage), str(destination), binary_override=str(fake))
        rendered = stage.read_text(encoding="utf-8")
        assert rendered.endswith(body)
        assert result["sourceSha256"] == sha256_bytes(source.read_bytes())
        assert result["markdownBodySha256"] == sha256_bytes(body.encode())
        assert result["extractionDiagnostics"] == '{"route":"fake"}'
        assert result["stderrDiagnostics"] == "warning"
        assert 'converter: "steipete/summarize"' in rendered
        assert 'converter_version: "0.21.11"' in rendered
        assert f'source_path: {json.dumps(str(source.resolve()))}' in rendered
        invocation = json.loads(log.read_text(encoding="utf-8").splitlines()[-1])
        assert invocation[1:] == [
            "--extract", "--format", "md", "--json", "--no-cache", "--no-media-cache",
            "--no-slides", "--no-slides-ocr", "--markdown-mode", "readability",
            "--metrics", "off", "--timeout", "2m"
        ]

        assert validate_remote("https://example.com/article#section") == "https://example.com/article"
        expect_error(
            lambda: validate_remote("https://example.com/article?X-Amz-Signature=secret"),
            "credential-bearing",
        )
        expect_error(
            lambda: validate_remote("https://example.com/article?clientSecret=secret"),
            "credential-bearing",
        )
        expect_error(
            lambda: validate_remote("https://example.com/article?jwt=secret"),
            "credential-bearing",
        )
        expect_error(lambda: parse_timeout("9" * 5000), "24-hour")
        expect_error(lambda: parse_timeout("1441m"), "24-hour")
        flood_environment = os.environ.copy()
        flood_environment.update({"FAKE_MODE": "flood", "FAKE_LOG": str(log)})
        expect_error(
            lambda: run_process(
                [str(fake), "source"], root, 2, flood_environment,
                stdout_limit=32, stderr_limit=32,
            ),
            "stdout exceeds",
        )

        transcript = root / "stage" / "transcript.md"
        convert(
            str(source),
            str(transcript),
            str(bank / "transcript.md"),
            "https://example.com/media",
            "en-US",
            "authored",
            binary_override=str(fake),
        )
        transcript_text = transcript.read_text(encoding="utf-8")
        assert 'media_source: "https://example.com/media"' in transcript_text
        assert 'caption_language: "en-US"' in transcript_text

        expect_error(
            lambda: convert(str(source), str(source), str(destination), binary_override=str(fake)),
            "source and staged",
        )
        expect_error(
            lambda: convert(str(source), str(destination), str(destination), binary_override=str(fake)),
            "staged output and canonical",
        )
        canonical_source = bank / "same.md"
        canonical_source.write_text("source", encoding="utf-8")
        expect_error(
            lambda: convert(
                str(canonical_source), str(root / "stage" / "same.md"), str(canonical_source),
                binary_override=str(fake),
            ),
            "source and canonical",
        )
        expect_error(
            lambda: convert(
                str(source), str(root / "stage" / "partial.md"), str(bank / "partial.md"),
                transcript_for="media", binary_override=str(fake),
            ),
            "supplied together",
        )
        expect_error(
            lambda: convert(
                str(source), str(root / "stage" / "wrong.md"),
                str(workspace / "wrong" / "source.md"), binary_override=str(fake),
            ),
            "canonical destination",
        )
        expect_error(
            lambda: convert(
                str(source), str(workspace / "stage.md"),
                str(bank / "workspace-stage.md"), binary_override=str(fake),
            ),
            "outside the workspace",
        )
        stage_link = root / "stage-link.md"
        stage_link.symlink_to(stage)
        expect_error(
            lambda: convert(
                str(source), str(stage_link), str(bank / "symlink-stage.md"),
                binary_override=str(fake),
            ),
            "symlinks",
        )
        destination_target = bank / "destination-target.md"
        destination_target.write_text("canonical", encoding="utf-8")
        destination_link = bank / "destination-link.md"
        destination_link.symlink_to(destination_target)
        expect_error(
            lambda: convert(
                str(source), str(root / "stage" / "dest-link.md"), str(destination_link),
                binary_override=str(fake),
            ),
            "symlinks",
        )
        expect_error(
            lambda: convert(
                str(source), str(root / "stage" / "missing.md"), str(bank / "missing.md"),
                binary_override=str(root / "missing-summarize"),
            ),
            "missing or not executable",
        )

        preserved = root / "stage" / "preserved.md"
        preserved.write_text("keep me", encoding="utf-8")
        os.environ["FAKE_VERSION"] = "0.21.10"
        expect_error(
            lambda: convert(str(source), str(preserved), str(bank / "old.md"), binary_override=str(fake)),
            "newer is required",
        )
        assert preserved.read_text() == "keep me"

        os.environ["FAKE_VERSION"] = "0.21.11"
        os.environ["FAKE_MODE"] = "failed"
        expect_error(
            lambda: convert(str(source), str(preserved), str(bank / "failed.md"), binary_override=str(fake)),
            "failure",
        )
        assert preserved.read_text() == "keep me"

        os.environ["FAKE_MODE"] = "truncated"
        expect_error(
            lambda: convert(str(source), str(preserved), str(bank / "truncated.md"), binary_override=str(fake)),
            "truncated",
        )
        assert preserved.read_text() == "keep me"

        os.environ["FAKE_MODE"] = "llm"
        expect_error(
            lambda: convert(str(source), str(preserved), str(bank / "llm.md"), binary_override=str(fake)),
            "unexpectedly",
        )
        assert preserved.read_text() == "keep me"

        os.environ["FAKE_MODE"] = "surrogate"
        expect_error(
            lambda: convert(str(source), str(preserved), str(bank / "surrogate.md"), binary_override=str(fake)),
            "invalid Unicode",
        )
        assert preserved.read_text() == "keep me"

        os.environ["FAKE_MODE"] = "malformed"
        expect_error(
            lambda: convert(str(source), str(preserved), str(bank / "bad.md"), binary_override=str(fake)),
            "UTF-8 JSON",
        )
        assert preserved.read_text() == "keep me"

        os.environ["FAKE_MODE"] = "ok"
        os.environ["FAKE_BODY"] = "---\r\ntitle: only metadata\r\n---\r\n<!-- empty -->"
        expect_error(
            lambda: convert(str(source), str(preserved), str(bank / "empty.md"), binary_override=str(fake)),
            "substantive",
        )
        assert preserved.read_text() == "keep me"

        os.environ["FAKE_MODE"] = "sleep"
        os.environ["FAKE_BODY"] = body
        expect_error(
            lambda: convert(
                str(source), str(preserved), str(bank / "slow.md"), timeout_value="1s",
                binary_override=str(fake), hard_timeout=0.05,
            ),
            "timed out",
        )
        assert preserved.read_text() == "keep me"

    print("LEARN Summarize converter checks passed")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--canonical-destination")
    parser.add_argument("--transcript-for")
    parser.add_argument("--caption-language")
    parser.add_argument("--caption-type", choices=("authored", "automatic"))
    parser.add_argument("--timeout", default="2m")
    parser.add_argument("--check", action="store_true")
    return parser


def main() -> int:
    arguments = build_parser().parse_args()
    try:
        if arguments.check:
            check()
            return 0
        if not arguments.source or not arguments.output or not arguments.canonical_destination:
            raise ConversionError("SOURCE, OUTPUT, and --canonical-destination are required")
        result = convert(
            arguments.source,
            arguments.output,
            arguments.canonical_destination,
            arguments.transcript_for,
            arguments.caption_language,
            arguments.caption_type,
            arguments.timeout,
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ConversionError, OSError) as error:
        print(f"LEARN converter: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
