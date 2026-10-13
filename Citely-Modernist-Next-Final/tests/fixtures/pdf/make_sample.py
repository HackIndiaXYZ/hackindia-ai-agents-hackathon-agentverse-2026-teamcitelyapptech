"""Writes sample.pdf: page 1 and 2 have typed text; page 3 is a picture only (a filled
rectangle, no text), like a scanned page. Pure Python, no PDF library needed.
Run:  python3 tests/fixtures/pdf/make_sample.py"""
from pathlib import Path

pages = [
    ["Quarterly revenue grew by twelve percent.", "Enterprise sales led the growth."],
    ["Costs were flat.", "Headcount stayed at 40."],
    None,
]

def text_stream(lines):
    out = ["BT", "/F1 14 Tf", "72 700 Td", "20 TL"]
    for i, line in enumerate(lines):
        out.append(f"({line}) Tj" if i == 0 else f"T* ({line}) Tj")
    out.append("ET")
    return "\n".join(out)

picture = "0.8 0.85 0.9 rg\n72 300 468 200 re f"
objects = []   # index 0 is object 1
objects.append("<< /Type /Catalog /Pages 2 0 R >>")
kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(len(pages)))
objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>")
objects.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")      # object 3
for i, lines in enumerate(pages):
    content_no = 5 + 2 * i
    objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_no} 0 R >>")
    body = text_stream(lines) if lines else picture
    objects.append(f"<< /Length {len(body)} >>\nstream\n{body}\nendstream")

pdf = bytearray(b"%PDF-1.4\n")
offsets = []
for n, body in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += f"{n} 0 obj\n{body}\nendobj\n".encode("latin-1")
xref = len(pdf)
pdf += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
for off in offsets:
    pdf += f"{off:010d} 00000 n \n".encode()
pdf += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
Path(__file__).with_name("sample.pdf").write_bytes(pdf)
print("wrote sample.pdf", len(pdf), "bytes")
