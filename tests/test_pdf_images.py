"""Reading the pictures of a PDF: only the pictures are sent, a picture repeated on several
pages is read once, each place it appears keeps its own location, and the limit counts distinct
pictures. The PDF is built by hand (no PDF library needed): page 1 has a logo, page 2 has the
same logo again plus a different picture drawn inside a form, a 4x4 spacer sits beside them."""

import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from APP import db
from APP.extraction import inventory, store


def image_object(width, height, colour):
    data = bytes(colour) * (width * height)
    return (f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length {len(data)} >>\n"
            "stream\n").encode("latin-1") + data + b"\nendstream"


def build_pdf():
    """3 pages: 612x792 points each. Returns the PDF bytes."""
    objects: dict[int, bytes] = {}
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[2] = b"<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>"
    objects[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    objects[10] = image_object(60, 30, (200, 30, 30))          # the logo
    objects[11] = image_object(50, 50, (30, 30, 200))          # a different picture
    objects[12] = image_object(4, 4, (0, 0, 0))                # a spacer
    objects[13] = (b"<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Matrix [1 0 0 1 0 0] /Resources << /XObject << /Im2 11 0 R >> >> /Length 33 >>\n"
                   b"stream\nq 100 0 0 100 72 72 cm /Im2 Do Q\nendstream")

    def page(page_obj, content_obj, content):
        objects[page_obj] = (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> "
                             f"/XObject << /Im1 10 0 R /Im3 12 0 R /Fm1 13 0 R >> >> /Contents {content_obj} 0 R >>").encode()
        objects[content_obj] = f"<< /Length {len(content)} >>\nstream\n{content}\nendstream".encode()

    text = "BT /F1 12 Tf 72 740 Td (Some typed text on the page.) Tj ET"
    page(4, 5, f"{text}\nq 120 0 0 60 400 700 cm /Im1 Do Q\nq 4 0 0 4 10 10 cm /Im3 Do Q")                # logo (top right) + spacer
    page(6, 7, f"{text}\nq 120 0 0 60 400 700 cm /Im1 Do Q\nq 1 0 0 1 0 0 cm /Fm1 Do Q")                  # the SAME logo, and a picture inside a form
    page(8, 9, text)                                                                                       # no pictures at all
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for number in sorted(objects):
        offsets[number] = len(out)
        out += f"{number} 0 obj\n".encode() + objects[number] + b"\nendobj\n"
    top = max(objects) + 1
    xref = len(out)
    out += f"xref\n0 {top}\n".encode() + b"0000000000 65535 f \n"
    for number in range(1, top):
        out += (f"{offsets[number]:010d} 00000 n \n" if number in offsets else "0000000000 65535 f \n").encode()
    out += f"trailer\n<< /Size {top} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


class PdfPicturesTest(unittest.TestCase):
    def setUp(self):
        self.pdf = build_pdf()
        self.inv = inventory.inspect(self.pdf, "Report.pdf")

    def test_every_place_a_picture_appears_is_found_and_spacers_are_ignored(self):
        self.assertEqual(self.inv.pages, 3)
        self.assertEqual([(v.location["page"]) for v in self.inv.visuals], [1, 2, 2])      # logo, logo again, the form's picture; no spacer
        self.assertTrue(all(v.error is None and v.data.startswith(b"\x89PNG") for v in self.inv.visuals))

    def test_the_same_picture_on_two_pages_has_one_key_and_the_same_pixels(self):
        first, again, other = self.inv.visuals
        self.assertEqual(first.key, again.key)
        self.assertEqual(first.data, again.data)
        self.assertNotEqual(first.key, other.key)

    def test_each_place_keeps_its_own_position_on_its_page(self):
        first, again, other = self.inv.visuals
        for logo in (first, again):                                                         # 120x60 at (400, 700) of a 612x792 page
            self.assertEqual(logo.location["box"], [0.6536, 0.0404, 0.1961, 0.0758])
        self.assertEqual(other.location["box"], [0.1176, 0.7828, 0.1634, 0.1263])          # 100x100 at (72, 72), inside a form: found by following it
        self.assertEqual(other.location["size"], [50, 50])

    def test_the_pages_typed_text_is_not_sent_only_the_picture(self):
        for visual in self.inv.visuals:
            self.assertTrue(visual.data.startswith(b"\x89PNG"))                            # a picture, not a page of the PDF
        self.assertTrue(all(v.location["native_text_present"] for v in self.inv.visuals))

    def test_a_page_whose_pictures_cannot_be_taken_out_is_sent_whole(self):
        from pypdf._page import PageObject
        with patch.object(PageObject, "images", property(lambda self: (_ for _ in ()).throw(ValueError("undecodable")))):
            inv = inventory.inspect(self.pdf, "Report.pdf")
        self.assertEqual(len(inv.visuals), 3)                                               # every page, since none can be taken apart
        self.assertTrue(all(v.data.startswith(b"%PDF") and v.location["box"] == [0, 0, 1, 1] for v in inv.visuals))


class PersistTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name)
        for target in ("APP.db.DB_PATH",):
            p = patch(target, self.temp / "test.db")
            p.start()
            self.addCleanup(p.stop)
        p = patch("APP.rag.vector_store.document_index_dir", lambda owner, doc: self.temp / owner / doc)
        p.start()
        self.addCleanup(p.stop)
        db.init_db()
        self.owner = db.create_user("pdf@example.invalid")
        self.document = db.create_document(self.owner, "Report.pdf", pages=3)
        self.pdf = build_pdf()

    def regions(self):
        with db._connect() as conn:
            return [dict(r) for r in conn.execute("SELECT state, error, asset_hash, asset_path FROM evidence_regions WHERE asset_hash IS NOT NULL ORDER BY created")]

    def test_a_repeated_picture_shares_one_stored_file_and_is_queued_at_every_place(self):
        inventory.persist(self.owner, self.document, self.pdf, "Report.pdf", inventory.inspect(self.pdf, "Report.pdf"), [])
        rows = self.regions()
        self.assertEqual([r["state"] for r in rows], ["queued"] * 3)
        self.assertEqual(len({r["asset_hash"] for r in rows}), 2)                          # three places, two distinct pictures
        self.assertEqual(len({r["asset_path"] for r in rows}), 2)
        self.assertEqual(len(list((self.temp / self.owner / self.document / "evidence").glob("*.png"))), 2)

    def test_the_limit_counts_distinct_pictures_so_repeats_are_free(self):
        with patch.dict("os.environ", {"EXTRACTION_MAX_IMAGES": "1"}):
            inventory.persist(self.owner, self.document, self.pdf, "Report.pdf", inventory.inspect(self.pdf, "Report.pdf"), [])
        rows = self.regions()
        self.assertEqual([r["state"] for r in rows], ["queued", "queued", "unsupported"])   # the logo twice is fine; the second picture is over the limit
        self.assertIn("Image limit reached", rows[2]["error"])

    def test_the_default_limit_is_sized_for_a_long_deck(self):
        import os
        with patch.dict("os.environ", {}, clear=False):
            os.environ.pop("EXTRACTION_MAX_IMAGES", None)
            many = inventory.Inventory(200, [inventory.Visual({"format": "pdf", "page": n, "box": [0, 0, 1, 1]}, f"png{n}".encode(), key=f"k{n}") for n in range(1, 201)])
            inventory.persist(self.owner, self.document, self.pdf, "Report.pdf", many, [])
        states = [r["state"] for r in self.regions()]
        self.assertEqual((states.count("queued"), states.count("unsupported")), (150, 50))


if __name__ == "__main__":
    unittest.main()


class ClippingTest(unittest.TestCase):
    def test_a_picture_drawn_larger_than_the_page_is_clipped_to_the_page(self):
        data = build_pdf().replace(b"q 120 0 0 60 400 700 cm /Im1 Do Q\nq 4 0 0 4 10 10 cm /Im3 Do Q", b"q 900 0 0 900 -100 -50 cm /Im1 Do Q\nq 4 0 0 4 10 10 cm /Im3 Do Q  ")
        box = inventory.inspect(data, "Big.pdf").visuals[0].location["box"]
        left, top, width, height = box
        self.assertTrue(0 <= left and 0 <= top and left + width <= 1.0001 and top + height <= 1.0001)       # inside the page
        self.assertEqual((left, top), (0.0, 0.0))
