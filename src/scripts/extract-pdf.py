#!/usr/bin/env python3
"""Fast, page-scoped PDF text extraction for LEARN."""

import argparse
import json
import tempfile
from pathlib import Path


def page_numbers(spec, count):
    pages = set()
    for part in spec.split(","):
        bounds = part.strip().split("-", 1)
        try:
            start, end = (int(bounds[0]), int(bounds[-1]))
        except ValueError as exc:
            raise ValueError(f"invalid page range: {part}") from exc
        if start < 1 or end < start or end > count:
            raise ValueError(f"page range outside 1-{count}: {part}")
        pages.update(range(start, end + 1))
    if not pages:
        raise ValueError("at least one page is required")
    return sorted(pages)


def overview(pdf):
    import pymupdf

    with pymupdf.open(pdf) as doc:
        return {
            "pageCount": doc.page_count,
            "metadata": {key: value for key, value in doc.metadata.items() if value},
            "toc": doc.get_toc(),
            "pages": [
                {
                    "page": page.number + 1,
                    "characters": len(text := page.get_text("text", sort=True).strip()),
                    "opening": " ".join(text.split())[:240],
                }
                for page in doc
            ],
        }


def extract(pdf, spec):
    import pymupdf
    import pymupdf4llm

    with pymupdf.open(pdf) as doc:
        pages = page_numbers(spec, doc.page_count)
    chunks = pymupdf4llm.to_markdown(
        str(pdf), pages=[page - 1 for page in pages], page_chunks=True,
        ignore_images=True, use_ocr=True, force_text=True,
    )
    return "\n\n".join(
        f"<!-- PDF PAGE {page} -->\n\n{chunk['text'].strip()}"
        for page, chunk in zip(pages, chunks)
    )


def self_check():
    import pymupdf

    assert page_numbers("1,3-4", 4) == [1, 3, 4]
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "check.pdf"
        doc = pymupdf.open()
        for text in ("alpha", "beta"):
            page = doc.new_page()
            page.insert_text((72, 72), text)
        doc.save(path)
        doc.close()
        assert overview(path)["pageCount"] == 2
        output = extract(path, "2")
        assert "PDF PAGE 2" in output and "beta" in output and "alpha" not in output
    print("extract-pdf self-check passed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", nargs="?", type=Path)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--overview", action="store_true")
    group.add_argument("--pages", help="1-based inclusive ranges, e.g. 1-25,40-44")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        self_check()
        return
    if not args.pdf or not (args.overview or args.pages):
        parser.error("PDF and either --overview or --pages are required")
    if args.overview:
        print(json.dumps(overview(args.pdf), ensure_ascii=False, indent=2))
    else:
        print(extract(args.pdf, args.pages))


if __name__ == "__main__":
    main()
