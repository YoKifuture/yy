"""Read the text layer of a PDF supplied on stdin, with page references."""
import io
import sys

from pypdf import PdfReader


def main():
    reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()), strict=False)
    if reader.is_encrypted or len(reader.pages) > 80:
        raise ValueError("encrypted PDF or page limit")
    remaining = 90_000
    pages = []
    for number, page in enumerate(reader.pages, 1):
        text = page.extract_text().strip()
        if not text:
            continue
        section = f"[PDF page {number}]\n{text}"
        if len(section) > remaining:
            raise ValueError("text limit")
        pages.append(section)
        remaining -= len(section) + 2
    result = "\n\n".join(pages)
    if len(result) < 100:
        raise ValueError("no searchable text")
    sys.stdout.buffer.write(result.encode("utf-8"))


if __name__ == "__main__":
    main()
