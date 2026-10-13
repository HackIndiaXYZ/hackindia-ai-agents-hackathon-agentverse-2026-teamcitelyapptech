"""Exercise the real annotation/notes routes against isolated SQLite storage.
Run from repository root: .venv/bin/python Citely-Modernist-Next-Final/tests/verify_persistence.py
No production account, database, email, or model calls are involved.
"""
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from fastapi.testclient import TestClient
from APP import db
from APP.auth import get_current_user
from APP.main import app

fixture = json.loads((Path(__file__).parent / 'fixtures/real-ingest.json').read_text())
with tempfile.TemporaryDirectory() as directory, patch.object(db, 'DB_PATH', Path(directory) / 'test.db'), patch.object(app.state, 'rag_service', SimpleNamespace(get_document_pages=lambda *_: fixture['pages']), create=True):
    db.init_db()
    owner = db.create_user('citely-persistence-test@example.com', email_verified=True)
    document = db.create_document(owner, fixture['filename'], pages=1)
    app.dependency_overrides[get_current_user] = lambda: {'id': owner}
    client = TestClient(app)
    conversation = 'precise-integration-test'
    annotations_url = f'/conversations/{conversation}/annotations'
    for source in fixture['sources']:
        response = client.post(annotations_url, json={
            'document_id': document, 'workspace_id': 'test', 'kind': 'citation',
            'citation_id': source['citation_id'], 'page_number': 1,
            'quote': fixture['pages'][0]['text'][source['page_char_start']:source['page_char_end']],
            'page_char_start': source['page_char_start'], 'page_char_end': source['page_char_end'],
            'extraction_version': fixture['pages'][0]['extraction_version'],
        })
        assert response.status_code == 201, response.text
    client = TestClient(app)  # fresh client: all state must come from persistence
    annotations = client.get(annotations_url).json()
    assert len(annotations) == 2
    assert client.delete('/annotations/' + annotations[0]['id']).status_code == 200
    assert len(TestClient(app).get(annotations_url).json()) == 1
    notes_url = f'/conversations/{conversation}/notes'
    assert client.put(notes_url, json={'content': 'First version', 'expected_revision': 0}).json()['revision'] == 1
    assert client.put(notes_url, json={'content': 'Newer version', 'expected_revision': 1}).json()['revision'] == 2
    conflict = client.put(notes_url, json={'content': 'Stale draft', 'expected_revision': 1})
    assert conflict.status_code == 409
    assert TestClient(app).get(notes_url).json()['content'] == 'Newer version'
    restored = client.post(notes_url + '/versions/1/restore').json()
    assert restored['revision'] == 3 and restored['content'] == 'First version'
    assert TestClient(app).get(notes_url).json()['revision'] == 3
    assert len(client.get(notes_url + '/versions').json()) == 3
    app.dependency_overrides.clear()
    print('PASS: real API annotation create/reload/delete, note save/reload, stale 409, restore appended revision 3.')
