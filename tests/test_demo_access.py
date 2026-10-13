"""Review-mode sign-up and demo delivery, with isolated DB and stubbed email."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
from fastapi.testclient import TestClient
from APP import db, auth
from APP.main import app, limiter

class DemoAccessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dbpatch = patch.object(db, 'DB_PATH', Path(self.tmp.name) / 'test.db')
        self.dbpatch.start(); self.addCleanup(self.dbpatch.stop)
        env = patch.dict(os.environ, {'CITELY_APPROVED_EMAILS':'', 'CITELY_DEMO_RECIPIENT':'owner@example.com', 'ACS_SENDER_ADDRESS':'sender@example.com', 'JWT_SECRET_KEY':'test-only-secret-key-not-for-production'})
        env.start(); self.addCleanup(env.stop)
        dns = patch('APP.access_control._domain_receives_mail', return_value=True)   # no real DNS in tests
        dns.start(); self.addCleanup(dns.stop)
        db.init_db(); limiter.reset(); self.client = TestClient(app)
        self.payload = {'name':'Test Person','email':'visitor@example.com','phone':'+91 9876543210','comment':'Review research documents'}

    def test_direct_signup_creates_no_account_until_the_code(self):
        with patch('APP.main.otp_email.send_otp_email'):
            response = self.client.post('/auth/signup', json={'email':'visitor@example.com','password':'Velvet-Harbor-73x'})
        self.assertEqual(response.status_code, 201)
        self.assertIsNone(db.get_user_by_email('visitor@example.com'))

    def test_new_social_accounts_start_pending_and_the_admin_is_told(self):
        for n, provider in enumerate(['github','google']):
            email = f'visitor{n}@example.com'
            with self.subTest(provider=provider), patch(f'APP.main.auth.exchange_{provider}_code', return_value={'email':email,'provider_user_id':str(n)}), \
                 patch('APP.demo_access.notify_admin_of_pending_account') as told, patch('APP.main.notify_admin_of_pending_account') as told_main:
                response = self.client.post(f'/auth/{provider}/callback', json={'code':'test','redirect_uri':'http://localhost/callback'})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['status'], 'pending')
                self.assertEqual(db.get_user_by_email(email)['status'], 'pending')
                self.assertEqual(told_main.call_count, 1)

    def test_existing_member_can_log_in(self):
        db.create_user('member@example.com', password_hash=auth.hash_password('TestPassword123'), email_verified=True)
        response = self.client.post('/auth/login', json={'email':'member@example.com','password':'TestPassword123'})
        self.assertEqual(response.status_code, 200)

    def test_existing_provider_identity_keeps_access_after_email_change(self):
        db.get_or_create_user_for_oauth('old@example.com','github','123')
        with patch('APP.main.auth.exchange_github_code', return_value={'email':'new@example.com','provider_user_id':'123'}):
            self.assertEqual(self.client.post('/auth/github/callback',json={'code':'test'}).status_code,200)

    def test_explicitly_approved_social_user_can_join(self):
        with patch.dict(os.environ, {'CITELY_APPROVED_EMAILS':'visitor@example.com'}), patch('APP.main.auth.exchange_google_code',return_value={'email':'visitor@example.com','provider_user_id':'123'}):
            self.assertEqual(self.client.post('/auth/google/callback',json={'code':'test','redirect_uri':'http://localhost/callback'}).status_code,200)

    def test_demo_delivery_never_creates_user(self):
        client = Mock(); client.begin_send.return_value.result.return_value = {'status':'Succeeded'}
        with patch('APP.demo_access.mail._get_client',return_value=client):
            response = self.client.post('/demo-requests',json=self.payload)
        self.assertEqual(response.status_code,202)
        message = client.begin_send.call_args.args[0]
        self.assertEqual(message['recipients']['to'],[{'address':'owner@example.com'}])
        self.assertIn('Review research documents',message['content']['plainText'])
        self.assertIsNone(db.get_user_by_email('visitor@example.com'))

    def test_invalid_or_missing_fields_do_not_send(self):
        with patch('APP.demo_access.mail._get_client') as client:
            for update in [{'name':' '},{'email':'not-an-email'},{'phone':'abcdefg'},{'comment':''},{'recipient':'attacker@example.com'}]:
                self.assertEqual(self.client.post('/demo-requests',json={**self.payload,**update}).status_code,422)
            client.assert_not_called()

    def test_failed_delivery_and_missing_config_are_not_success(self):
        with patch('APP.demo_access.mail._get_client',side_effect=RuntimeError('private secret')):
            response = self.client.post('/demo-requests',json=self.payload)
            self.assertEqual(response.status_code,503); self.assertNotIn('private secret', response.text)
        with patch.dict(os.environ, {'CITELY_DEMO_RECIPIENT':''}):
            self.assertEqual(self.client.post('/demo-requests',json=self.payload).status_code,503)

    def test_requests_are_rate_limited(self):
        with patch('APP.main.deliver_demo_request'):
            codes = [self.client.post('/demo-requests',json=self.payload).status_code for _ in range(4)]
            self.assertEqual(codes,[202,202,202,429])


class DesignedEmailTest(unittest.TestCase):
    def test_request_email_has_html_reply_to_and_escapes_visitor_text(self):
        from APP.auth import email_templates as t
        html = t.access_request_html(name='<b>Eve</b>', email='eve@example.org', phone='+1 555', reason='<script>x</script>', review_url='https://admin.citely.example/#prod/requests')
        self.assertNotIn('<script>x</script>', html)
        self.assertNotIn('<b>Eve</b>', html)
        self.assertIn('&lt;b&gt;Eve&lt;/b&gt;', html)
        for link in (t.INSTAGRAM_URL, t.X_URL, 'mailto:' + t.CONTACT_EMAIL):
            self.assertIn(link, html)
        self.assertEqual(t.X_URL, 'https://x.com/citely-example')

    def test_every_email_has_a_plain_text_part_and_location(self):
        from APP.auth import email_templates as t
        for text in (t.otp_plaintext('123456'), t.reset_password_plaintext('https://x/r'), t.oauth_only_reset_plaintext(),
                     t.access_approved_plaintext(email='a@b.co'), t.access_request_plaintext(name='A', email='a@b.co', phone='1', reason='r', review_url=None)):
            self.assertIn('Dwarka, New Delhi', text)
            self.assertNotIn('MRIIRS', text)
