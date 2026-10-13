"""Prove public format claims using real parser output, not extension lists."""
import unittest
from APP.parsers import parse_document


class MarketingFormatClaims(unittest.TestCase):
    def test_text_markdown_json_and_csv_extract_actual_content(self):
        fixtures = {
            'example.txt': b'Citely document evidence. The project review happens every Monday. ' * 8,
            'example.md': b'# Project review\nThe project review happens every Monday.\n' * 8,
            'example.json': b'{"meeting":"Monday","description":"Weekly project review with source evidence"}',
            'example.csv': b'meeting,description\nMonday,Weekly project review with source evidence\n',
        }
        for filename, content in fixtures.items():
            with self.subTest(filename=filename):
                result = parse_document(content, filename)
                text = '\n'.join(doc.page_content for doc in result.documents)
                self.assertIn('Monday', text)
                self.assertTrue(result.parser.startswith('local-'))
                if filename.endswith('.csv'):
                    self.assertIn('meeting: Monday', text)


if __name__ == '__main__':
    unittest.main()
