"""Native spreadsheet extraction: values, merges, anchors, routing, citations."""

import datetime as dt
import io
import os
import unittest
from unittest import mock

import openpyxl
from openpyxl.chart import BarChart, Reference
from langchain_core.documents import Document

import APP.rag  # noqa: F401 — import order the app uses (APP.parsers ↔ APP.rag)
from APP.parsers import router, xlsx_native
from APP.parsers.xlsx_native import WorkbookTooLarge, cell_text, format_number, parse_workbook
from APP.rag.chunking import build_page_texts, finalize_native_chunks
from APP.rag.evidence import native_anchor_for


def _xlsx(build) -> bytes:
    wb = openpyxl.Workbook()
    build(wb)
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def _span_texts(doc):
    return {ref["range"]: doc.page_content[s:e] for s, e, ref in doc.metadata["anchor_spans"]}


class ValueFormattingTest(unittest.TestCase):
    def test_numbers_render_as_excel_displays_them(self):
        cases = [
            (0.412, "0.0%", "41.2%"),
            (48250000, "#,##0", "48,250,000"),
            (1234.5, '"$"#,##0.00', "$1,234.50"),
            (1234.5, "[$€-407]#,##0.00", "€1,234.50"),
            (-1500, "#,##0", "-1,500"),
            (0.30000000000000004, "General", "0.3"),
            (5.0, "General", "5"),
            (12345.678, "0.00E+00", "12345.678"),
            (0, "0.0%", "0.0%"),
        ]
        for value, fmt, expected in cases:
            with self.subTest(fmt=fmt, value=value):
                self.assertEqual(format_number(value, fmt), expected)

    def test_dates_are_dates_not_serial_numbers(self):
        self.assertEqual(cell_text(dt.datetime(2026, 3, 31), "yyyy-mm-dd"), "2026-03-31")
        self.assertEqual(cell_text(dt.date(2026, 3, 31), "General"), "2026-03-31")
        self.assertEqual(cell_text(dt.datetime(2026, 3, 31, 14, 5), "General"), "2026-03-31 14:05")
        self.assertEqual(cell_text(True, "General"), "TRUE")
        self.assertEqual(cell_text("  two\nlines  ", "General"), "two lines")


class ParseWorkbookTest(unittest.TestCase):
    def test_rows_keep_their_headers_and_cells_their_addresses(self):
        def build(wb):
            ws = wb.active
            ws.title = "Summary"
            ws.merge_cells("A1:C1")
            ws["A1"] = "Quarterly summary"
            ws.append([])
            ws.append(["Metric", "Actual", "Target"])
            ws.append(["Gross margin", 0.412, 0.4])
            ws["B4"].number_format = "0.0%"
            ws["A5"] = "Computed"
            ws["B5"] = "=B4*2"            # no cached value: skipped, never guessed
            ws["A6"] = "As of"
            ws["B6"] = dt.date(2026, 3, 31)
        docs = parse_workbook(_xlsx(build), "s.xlsx")
        self.assertEqual(len(docs), 1)
        doc = docs[0]
        self.assertEqual(doc.page_content.splitlines()[:4], [
            "Sheet: Summary",
            "Row 1: Quarterly summary",                       # above the header: no labels
            "Row 3 (headers): Metric | Actual | Target",
            "Row 4: Metric: Gross margin | Actual: 41.2% | Target: 0.4",
        ])
        self.assertIn("Row 6: Metric: As of | Actual: 2026-03-31", doc.page_content)
        # A formula with no saved value is recorded, not guessed, and is not an anchored unit.
        self.assertIn("[formula =B4*2; no saved value]", doc.page_content)
        self.assertEqual(doc.metadata["formula_values"], "saved_not_recalculated")
        self.assertNotIn("B5", [span[2]["range"] for span in doc.metadata["anchor_spans"]])
        spans = _span_texts(doc)
        self.assertEqual(spans["A1:C1"], "Quarterly summary")  # merge anchored on its top-left
        self.assertEqual(spans["B4"], "Actual: 41.2%")
        self.assertNotIn("B5", spans)
        meta = doc.metadata
        self.assertEqual((meta["page"], meta["sheet_name"], meta["sheet_index"]), (1, "Summary", 0))
        self.assertEqual(meta["native_anchor"], {"format": "xlsx", "sheet_name": "Summary", "sheet_index": 0,
                                                 "range": "A1:C6"})

    def test_cells_covered_by_a_merge_are_never_units(self):
        def build(wb):
            ws = wb.active
            ws["A1"], ws["B1"] = "Group", "Value"
            ws["A2"] = "North"
            ws["A3"] = "hidden by the merge"
            ws.merge_cells("A2:A4")
            for r in (2, 3, 4):
                ws[f"B{r}"] = r
        spans = _span_texts(parse_workbook(_xlsx(build), "m.xlsx")[0])
        self.assertEqual(spans["A2:A4"], "Group: North")
        self.assertNotIn("A3", spans)
        self.assertEqual(spans["B3"], "Value: 3")

    def test_sheet_index_is_the_workbook_position_including_chartsheets(self):
        def build(wb):
            wb.active.title = "First"
            wb.active["A1"] = "one"
            chart = BarChart()
            chart.add_data(Reference(wb.active, min_col=1, min_row=1, max_row=1))
            wb.create_chartsheet("Chart").add_chart(chart)
            third = wb.create_sheet("Third")
            third["A1"] = "three"
        docs = parse_workbook(_xlsx(build), "c.xlsx")
        self.assertEqual([(d.metadata["sheet_name"], d.metadata["sheet_index"], d.metadata["page"]) for d in docs],
                         [("First", 0, 1), ("Third", 2, 3)])

    def test_chunks_stay_within_budget_and_split_long_rows_between_cells(self):
        def build(wb):
            ws = wb.active
            ws.append([f"col{c}" for c in range(1, 61)])
            for r in range(2, 40):
                ws.append([r * c for c in range(1, 61)])
        docs = parse_workbook(_xlsx(build), "w.xlsx", chunk_chars=400)
        self.assertGreater(len(docs), 10)
        for doc in docs:
            self.assertLessEqual(len(doc.page_content), 400)
            for s, e, ref in doc.metadata["anchor_spans"]:
                self.assertTrue(doc.page_content[s:e])
        every = {ref["range"] for d in docs for _, _, ref in d.metadata["anchor_spans"]}
        self.assertEqual(len(every), 60 * 39)          # each cell exactly once

    def test_oversized_workbooks_are_refused_so_the_router_falls_back(self):
        def build(wb):
            for r in range(1, 30):
                wb.active.append(list(range(10)))
        with mock.patch.object(xlsx_native, "MAX_CELLS", 100):
            with self.assertRaises(WorkbookTooLarge):
                parse_workbook(_xlsx(build), "big.xlsx")


class RoutingTest(unittest.TestCase):
    def setUp(self):
        self.small = _xlsx(lambda wb: wb.active.append(["A", 1]))
        self.azure = mock.patch.object(router._azure_di, "is_available", return_value=True)
        self.azure.start()
        self.addCleanup(self.azure.stop)
        self.azure_parse = mock.patch.object(router._azure_di, "parse",
                                             return_value=[Document(page_content="x" * 500, metadata={"page": 1})])
        self.azure_parse.start()
        self.addCleanup(self.azure_parse.stop)

    def test_flag_off_keeps_azure_document_intelligence(self):
        with mock.patch.dict(os.environ, {"NATIVE_CHUNKS_XLSX": "false"}):
            self.assertEqual(router.parse_document(self.small, "a.xlsx").parser, "azure-document-intelligence")

    def test_flag_on_uses_native_even_for_a_tiny_sheet(self):
        with mock.patch.dict(os.environ, {"NATIVE_CHUNKS_XLSX": "true"}):
            result = router.parse_document(self.small, "a.xlsx")
        self.assertEqual((result.parser, result.fallback_used), ("local-xlsx", False))

    def test_a_native_failure_falls_back_to_azure(self):
        with mock.patch.dict(os.environ, {"NATIVE_CHUNKS_XLSX": "true"}), \
                mock.patch.object(router._local_xlsx, "parse", side_effect=WorkbookTooLarge("too big")):
            result = router.parse_document(self.small, "a.xlsx")
        self.assertEqual((result.parser, result.fallback_used), ("azure-document-intelligence", True))


class AnchorsTest(unittest.TestCase):
    def setUp(self):
        def build(wb):
            ws = wb.active
            ws.title = "Regions"
            ws.append(["Region", "Q3", "Lead"])
            ws.append(["Nordics", 3910000, "Ingrid Solberg"])
            ws.append(["Iberia", 2115000, "Lucía Ferrer"])
            ws.append(["Iberia", 2115000, "Lucía Ferrer"])
        self.doc = parse_workbook(_xlsx(build), "r.xlsx")[0]

    def test_a_quote_narrows_the_citation_to_the_cells_it_covers(self):
        anchor = native_anchor_for(self.doc.metadata, self.doc.page_content, "Lead: Ingrid Solberg")
        self.assertEqual((anchor["range"], anchor["cells"]), ("C2", ["C2"]))
        anchor = native_anchor_for(self.doc.metadata, self.doc.page_content,
                                   "Region: Nordics | Q3: 3910000 | Lead: Ingrid Solberg")
        self.assertEqual(anchor["range"], "A2:C2")

    def test_an_ambiguous_quote_keeps_the_whole_chunk(self):
        anchor = native_anchor_for(self.doc.metadata, self.doc.page_content, "Lead: Lucía Ferrer")
        self.assertEqual(anchor["range"], self.doc.metadata["native_anchor"]["range"])
        self.assertNotIn("cells", anchor)

    def test_documents_without_native_anchors_get_none(self):
        self.assertIsNone(native_anchor_for({"page": 1}, "text", "text"))

    def test_native_chunks_are_located_exactly_in_their_page_text(self):
        def build(wb):
            wb.active.title = "One"
            for r in range(60):
                wb.active.append([f"row {r} text", r])
            wb.create_sheet("Two").append(["only", 1])
        docs = parse_workbook(_xlsx(build), "p.xlsx", chunk_chars=300)
        pages = build_page_texts(docs)
        chunks = finalize_native_chunks(docs)
        self.assertEqual(sorted(pages), [1, 2])
        for chunk in chunks:
            page = pages[chunk.metadata["page"]]
            start, end = chunk.metadata["page_char_start"], chunk.metadata["page_char_end"]
            self.assertEqual(page[start:end], chunk.page_content)
            self.assertIn("native_anchor", chunk.metadata)


if __name__ == "__main__":
    unittest.main()


class CellHighlightApiTest(unittest.TestCase):
    """Manual highlights made in the spreadsheet viewer persist as cell anchors."""

    def setUp(self):
        import tempfile
        from pathlib import Path

        from fastapi.testclient import TestClient

        from APP import db
        from APP.auth import get_current_user
        from APP.main import app

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        patcher = mock.patch.object(db, "DB_PATH", Path(tmp.name) / "test.db")
        patcher.start()
        self.addCleanup(patcher.stop)
        db.init_db()
        self.owner = db.create_user("cells@example.invalid")
        self.document = db.create_document(self.owner, "book.xlsx", pages=2)
        service = mock.Mock()
        service.get_document_pages.return_value = [
            {"page": 1, "text": "Sheet: Summary\nRow 1: a", "extraction_version": "1:abc"},
            {"page": 2, "text": "Sheet: Regions\nRow 1: b", "extraction_version": "1:abc"},
        ]
        service_patch = mock.patch.object(app.state, "rag_service", service, create=True)
        service_patch.start()
        self.addCleanup(service_patch.stop)
        app.dependency_overrides[get_current_user] = lambda: {"id": self.owner}
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app)
        self.url = "/conversations/conv-x/annotations"
        self.payload = {"document_id": self.document, "kind": "manual-highlight", "page_number": 2,
                        "quote": "Nordics 3,910,000", "extraction_version": "1:abc",
                        "anchor": {"format": "xlsx", "sheet_name": "Regions", "sheet_index": 1, "range": "A3:D3"}}

    def test_a_cell_highlight_round_trips_with_its_anchor(self):
        created = self.client.post(self.url, json=self.payload)
        self.assertEqual(created.status_code, 201, created.text)
        listed = self.client.get(self.url).json()
        self.assertEqual(listed[0]["anchor"], self.payload["anchor"])
        self.assertIsNone(listed[0]["page_char_start"])

    def test_text_highlights_keep_no_anchor(self):
        payload = {k: v for k, v in self.payload.items() if k != "anchor"}
        self.assertEqual(self.client.post(self.url, json=payload).status_code, 201)
        self.assertIsNone(self.client.get(self.url).json()[0]["anchor"])

    def test_invalid_anchors_are_refused(self):
        def anchor(**changes):
            return {**self.payload, "anchor": {**self.payload["anchor"], **changes}}
        for name, body, status in [
            ("stale extraction", {**self.payload, "extraction_version": "1:old"}, 409),
            ("wrong page for sheet", {**self.payload, "page_number": 1}, 422),
            ("malformed range", anchor(range="A0:ZZZZ1"), 422),
            ("unknown key", anchor(note="x"), 422),
            ("unknown format", anchor(format="pdf"), 422),
        ]:
            with self.subTest(name):
                self.assertEqual(self.client.post(self.url, json=body).status_code, status)
        self.assertEqual(self.client.get(self.url).json(), [])


class FormulaRecordTest(unittest.TestCase):
    def test_a_formula_with_a_saved_value_keeps_the_value_as_its_anchor_and_the_expression_beside_it(self):
        from pathlib import Path
        fixtures = Path(__file__).resolve().parents[1] / "Citely-Modernist-Next-Final" / "tests" / "fixtures" / "xlsx"
        docs = parse_workbook((fixtures / "merge_formula_cached.xlsx").read_bytes(), "merge_formula_cached.xlsx")
        formula_docs = [d for d in docs if " [formula =" in d.page_content]
        self.assertTrue(formula_docs)
        for doc in formula_docs:
            self.assertEqual(doc.metadata["formula_values"], "saved_not_recalculated")
            for start, end, _ref in doc.metadata["anchor_spans"]:
                self.assertNotIn("[formula", doc.page_content[start:end])      # the anchor is the value alone, as the browser shows it


class IdentityContractTest(unittest.TestCase):
    """The browser viewer (SheetJS) must address the same cells the backend
    cites. This half pins what openpyxl emits; the frontend test
    tests/xlsx-identity.test.mjs checks SheetJS against the same snapshot."""

    def test_native_units_match_the_shared_snapshot(self):
        import json
        from pathlib import Path

        fixtures = Path(__file__).resolve().parents[1] / "Citely-Modernist-Next-Final" / "tests" / "fixtures" / "xlsx"
        snapshot = json.loads((fixtures / "native-units.json").read_text())["units"]
        for name, expected in snapshot.items():
            with self.subTest(name):
                units = []
                for doc in parse_workbook((fixtures / name).read_bytes(), name):
                    meta = doc.metadata
                    units += [[meta["sheet_name"], meta["sheet_index"], ref["range"], doc.page_content[s:e]]
                              for s, e, ref in meta["anchor_spans"]]
                self.assertEqual(units, expected)
