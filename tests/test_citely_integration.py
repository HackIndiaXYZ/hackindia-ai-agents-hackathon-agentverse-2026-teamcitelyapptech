"""Folder retrieval and workspace persistence regression checks (no external services)."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from langchain_core.documents import Document
from APP import db
from APP.rag.service import RAGService
from APP.schemas import QueryRequest


class FolderQueryTests(unittest.TestCase):
    def test_retrieves_each_owned_source_and_returns_document_identity(self):
        service = RAGService.__new__(RAGService)
        service.settings = SimpleNamespace(qdrant_collection="test")
        service.chat_provider = Mock(chat_model="test")
        service._load_document_artifacts = Mock(side_effect=lambda ident, owner: (ident, None, []))
        service._rewrite_query_if_needed = Mock(return_value="Compare the sources")
        service._generate_answer = Mock(return_value=("Evidence from both files [C1] [C2].", False))
        service.get_document_pages = Mock(return_value=[])
        def retrieve(**kwargs):
            ident = kwargs['vectorstore']
            return [(Document(page_content=f"Evidence in {ident}", metadata={"source": "same-name.pdf", "page": 1}), 0.5)]
        with patch('APP.rag.service.hybrid_retrieve', side_effect=retrieve), \
             patch('APP.rag.service.expand_with_neighbors_scored', side_effect=lambda **kw: kw['results']), \
             patch('APP.rag.service.db.list_chat_turns', return_value=[]), \
             patch('APP.rag.service.db.create_chat_turn'):
            result = service.answer('owner-a', QueryRequest(document_id='one', document_ids=['two', 'one'], question='Compare the sources'))
        self.assertEqual(service._load_document_artifacts.call_count, 2)
        self.assertEqual(service._load_document_artifacts.call_args_list[1].args, ('two', 'owner-a'))
        self.assertEqual({source.document_id for source in result.sources}, {'one', 'two'})

    def test_unowned_single_document_cannot_be_queried(self):
        service = RAGService.__new__(RAGService)
        service.chat_provider = Mock(chat_model="test")
        service._load_document_artifacts = Mock(side_effect=FileNotFoundError('Document not found'))
        with self.assertRaises(FileNotFoundError):
            service.answer('owner-b', QueryRequest(document_id='private', question='Summarize'))


class WorkspaceStorageTests(unittest.TestCase):
    def test_owner_isolation_and_stale_revision_rejection(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(db, 'DB_PATH', Path(directory) / 'test.db'):
            db.init_db()
            owner = db.create_user('owner@example.com')
            other = db.create_user('other@example.com')
            value = json.dumps({'notes': 'private notes'})
            self.assertEqual(db.write_state(owner, 'chat:org:finance', value, 0), 1)
            self.assertEqual(db.read_state(other, 'chat:org:finance'), (None, 0))
            self.assertIsNone(db.write_state(owner, 'chat:org:finance', 'stale', 0))
            self.assertEqual(db.read_state(owner, 'chat:org:finance'), (value, 1))


if __name__ == '__main__':
    unittest.main()
