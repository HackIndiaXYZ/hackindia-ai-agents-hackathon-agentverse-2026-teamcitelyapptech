"""Codes people wait on are handed to the email service without waiting for
its slow send confirmation; a refused send still fails the request, and a
send that fails later is logged and recorded for the admin."""

import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from APP import db
from APP.auth import email as mail


class FakePoller:
    def __init__(self, result):
        self.release = threading.Event()
        self._result = result

    def result(self, timeout=None):
        self.release.wait(timeout)
        return self._result


class EmailDeliveryTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for p in (patch.object(db, "DB_PATH", Path(tmp.name) / "rag.db"),
                  patch.dict(os.environ, {"ACS_SENDER_ADDRESS": "noreply@citely.test"})):
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        self.client = Mock()
        p = patch.object(mail, "_get_client", return_value=self.client)
        p.start()
        self.addCleanup(p.stop)

    def test_a_sign_in_code_returns_before_the_service_confirms(self):
        poller = FakePoller({"status": "Succeeded"})
        self.client.begin_send.return_value = poller
        done = threading.Event()
        threading.Thread(target=lambda: (mail.send_login_code_email("a@example.org", "123456"), done.set()), daemon=True).start()
        self.assertTrue(done.wait(2), "the request waited for the send confirmation")
        sent = self.client.begin_send.call_args[0][0]
        self.assertIn("123456", sent["content"]["plainText"])
        poller.release.set()

    def test_a_refused_send_still_fails_the_request(self):
        self.client.begin_send.side_effect = RuntimeError("sender not verified")
        with self.assertRaises(RuntimeError):
            mail.send_otp_email("a@example.org", "123456")

    def test_a_send_that_fails_later_is_logged_and_shown_to_the_admin(self):
        poller = FakePoller({"status": "Failed", "error": {"code": "EmailDroppedAllRecipientsSuppressed"}})
        poller.release.set()
        with patch.object(mail, "logger") as logger:
            thread = mail._confirm_in_background(poller, "a@example.org", "sign-in code")
            thread.join(5)
        logger.error.assert_called_once()
        events = [dict(e) for e in db.list_events(types=["email.failed"], limit=5)]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["email"], "a@example.org")
        self.assertIn("Suppressed", events[0]["detail"])
        self.assertIn("sign-in code", events[0]["detail"])

    def test_admin_messages_still_wait_for_confirmation(self):
        self.client.begin_send.return_value = FakePoller({"status": "Succeeded"})
        self.client.begin_send.return_value.release.set()
        self.assertEqual(mail.send_message("a@example.org", "s", "p"), {"status": "Succeeded"})


if __name__ == "__main__":
    unittest.main()
