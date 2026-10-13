"""Temporary / disposable email detection: the domain list, the allowlist, the
mail-server (MX infrastructure) check, the DNS cache and failing open.

DNS is faked (tests/conftest.py blocks the real thing); scripts/check_disposable_live.py
proves the same against today's internet.
"""

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import dns.exception
import dns.resolver
from fastapi.testclient import TestClient

import APP.rag  # noqa: F401 — import order the app uses
from APP import access_control as ac
from APP import db, disposable, email_policy
from APP.main import app, limiter


def mx(*hosts):
    return [SimpleNamespace(preference=10 * i, exchange=f"{h}.") for i, h in enumerate(hosts)]


class FakeDNS:
    """Answers from a table {(name, record): answers | exception class}; anything
    else is "no such record". Counts queries."""

    def __init__(self, table):
        self.table, self.queries = table, []

    def __call__(self, name, record, timeout):
        self.queries.append((name, record))
        answer = self.table.get((name, record), dns.resolver.NoAnswer)
        if isinstance(answer, type) and issubclass(answer, Exception):
            raise answer()
        return answer


# Real-world shapes of mainstream setups (Google Workspace, Microsoft 365, ...).
MAINSTREAM = {
    ("gmail.com", "MX"): mx("gmail-smtp-in.l.google.com", "alt1.gmail-smtp-in.l.google.com"),
    ("gmail-smtp-in.l.google.com", "A"): ["142.250.27.26"],
    ("outlook.com", "MX"): mx("outlook-com.olc.protection.outlook.com"),
    ("outlook-com.olc.protection.outlook.com", "A"): ["52.101.8.44"],
    ("acme-workspace.com", "MX"): mx("aspmx.l.google.com", "alt1.aspmx.l.google.com"),
    ("aspmx.l.google.com", "A"): ["192.178.158.26"],
    ("contoso.com", "MX"): mx("contoso-com.mail.protection.outlook.com"),
    ("contoso-com.mail.protection.outlook.com", "A"): ["52.101.40.0"],
    ("zoho.com", "MX"): mx("smtpin.zoho.com"),
    ("smtpin.zoho.com", "A"): ["136.143.191.44"],
    ("yahoo.co.in", "MX"): mx("mta5.am0.yahoodns.net"),
    ("mta5.am0.yahoodns.net", "A"): ["67.195.204.72"],
    ("solarion.ai", "MX"): mx("smtp.google.com"),
    ("smtp.google.com", "A"): ["192.178.158.27"],
    # A small company forwarding through Cloudflare Email Routing, like many temp domains do.
    ("tinyfirm.dev", "MX"): mx("route1.mx.cloudflare.net", "route2.mx.cloudflare.net"),
    ("route1.mx.cloudflare.net", "A"): ["162.159.205.11"],
}


class Layered(unittest.TestCase):
    def dns(self, table):
        fake = FakeDNS({**MAINSTREAM, **table})
        p = patch.object(disposable, "_resolve", fake)
        p.start()
        self.addCleanup(p.stop)
        return fake


class DomainListTest(Layered):
    def test_listed_domains_and_their_subdomains(self):
        for d in ("mailinator.com", "inbox.mailinator.com", "yopmail.com", "temp-mail.org", "guerrillamail.com"):
            with self.subTest(d):
                self.assertTrue(disposable.listed(d))
                self.assertTrue(ac.is_disposable(d))

    def test_mainstream_providers_are_never_listed(self):
        for name in sorted(disposable._allowed()):
            with self.subTest(name):
                self.assertFalse(disposable.listed(name))
        for d in ("gmail.com", "outlook.com", "zoho.com", "yahoo.co.in", "proton.me", "icloud.com", "example.com", "solarion.ai"):
            self.assertFalse(disposable.listed(d), d)

    def test_allowlist_beats_a_parent_entry_but_not_a_more_specific_one(self):
        with patch.object(disposable, "_listed", return_value=frozenset({"it.com", "temp.it.com", "gmail.com"})), \
             patch.object(disposable, "_allowed", return_value=frozenset({"it.com", "gmail.com"})):
            self.assertFalse(disposable.listed("gmail.com"))           # allowlist wins a tie
            self.assertFalse(disposable.listed("acme.it.com"))         # covered by the allowlisted parent
            self.assertTrue(disposable.listed("temp.it.com"))          # a more specific list entry still counts
            self.assertTrue(disposable.listed("x.temp.it.com"))

    def test_imported_false_positives_stay_out(self):
        # Real sites found in the looser imported lists (filtered by the refresh).
        for d in ("example.com", "craigslist.org", "nus.edu.sg", "asics.com", "21cn.com", "sify.com", "pp.ua"):
            self.assertFalse(disposable.listed(d), d)


class MailServerTest(Layered):
    def test_a_new_domain_on_a_temp_mail_server_name_is_refused(self):
        self.dns({("fresh-temp-domain.xyz", "MX"): mx("mail.wabblywabble.com"),
                  ("mail.wabblywabble.com", "A"): ["203.0.113.9"]})
        self.assertFalse(disposable.listed("fresh-temp-domain.xyz"))
        self.assertEqual(disposable.infrastructure_match("fresh-temp-domain.xyz"), "mail.wabblywabble.com")
        with self.assertRaisesRegex(ac.EmailRejected, "Temporary or disposable") as caught:
            ac.check_signup_email("someone@fresh-temp-domain.xyz")
        self.assertEqual(caught.exception.reason, "disposable")

    def test_a_new_domain_on_a_temp_mail_server_address_is_refused(self):
        # Own-looking MX name, but it resolves to generator.email's server.
        self.dns({("brandnew.click", "MX"): mx("mx.brandnew.click"),
                  ("mx.brandnew.click", "A"): ["91.196.52.205"]})
        self.assertEqual(disposable.infrastructure_match("brandnew.click"), "91.196.52.205")
        self.assertEqual(disposable.disposable_reason("brandnew.click"), "mail-servers")
        self.assertTrue(email_policy.is_temporary("x@brandnew.click"))

    def test_the_address_fallback_is_checked_when_there_is_no_mx(self):
        self.dns({("nomx-temp.top", "A"): ["157.230.203.88"]})
        self.assertEqual(disposable.infrastructure_match("nomx-temp.top"), "157.230.203.88")

    def test_any_matching_mail_server_counts(self):
        self.dns({("mixed.example", "MX"): mx("mx.mixed.example", "smtp.yopmail.com"),
                  ("mx.mixed.example", "A"): ["198.51.100.4"]})
        self.assertEqual(disposable.infrastructure_match("mixed.example"), "smtp.yopmail.com")

    def test_mainstream_and_shared_providers_pass(self):
        self.dns({})
        for email in ("a@gmail.com", "b@outlook.com", "c@acme-workspace.com", "d@contoso.com", "e@zoho.com",
                      "f@yahoo.co.in", "g.h@solarion.ai", "i@tinyfirm.dev"):
            with self.subTest(email):
                self.assertEqual(ac.check_signup_email(email), email)
                self.assertFalse(email_policy.is_temporary(email))

    def test_a_shared_provider_never_matches_even_if_its_address_is_listed(self):
        self.dns({})
        names, networks = disposable._infrastructure()
        import ipaddress
        with patch.object(disposable, "_infrastructure", return_value=(names, networks + (ipaddress.ip_network("192.178.158.0/24"),))):
            self.assertIsNone(disposable.infrastructure_match("acme-workspace.com"))

    def test_a_shared_provider_in_the_data_file_is_ignored(self):
        disposable._infrastructure.cache_clear()
        self.addCleanup(disposable._infrastructure.cache_clear)
        with patch.object(disposable, "_names", return_value=frozenset({"google.com", "outlook.com", "wabblywabble.com", "91.196.52.205"})), \
             self.assertLogs("rag_api.access", "WARNING"):
            names, networks = disposable._infrastructure()
        self.assertEqual(names, frozenset({"wabblywabble.com"}))
        self.assertEqual(len(networks), 1)

    def test_allowlisted_domains_skip_the_mail_server_check(self):
        fake = self.dns({("gmail.com", "MX"): mx("mail.wabblywabble.com")})   # absurd, but must not refuse Gmail
        self.assertIsNone(disposable.infrastructure_match("gmail.com"))
        self.assertNotIn(("gmail.com", "MX"), fake.queries)

    def test_data_files_are_sound(self):
        names, networks = disposable._infrastructure()
        self.assertGreater(len(names), 40)
        self.assertGreater(len(networks), 40)
        self.assertFalse([n for n in names if disposable._shared(n)])
        self.assertFalse([n for n in networks if n.is_private or n.is_loopback])
        for host in ("in.mail.tm", "mail.mailinator.com", "smtp.yopmail.com", "mail.guerrillamail.com", "mx4.beavis99.com", "generator.email"):
            self.assertTrue(disposable._longest_suffix(host, names), host)


class DnsBehaviourTest(Layered):
    def test_answers_are_cached(self):
        fake = self.dns({("cached.example", "MX"): mx("mx.cached.example"), ("mx.cached.example", "A"): ["198.51.100.7"]})
        ac.check_signup_email("a@cached.example")
        ac.check_signup_email("b@cached.example")
        self.assertEqual(fake.queries.count(("cached.example", "MX")), 1)

    def test_answers_expire(self):
        fake = self.dns({("ttl.example", "MX"): mx("mx.ttl.example")})
        clock = [1000.0]
        with patch.object(disposable.time, "monotonic", lambda: clock[0]):
            disposable.mail_servers("ttl.example")
            clock[0] += disposable._TTL + 1
            disposable.mail_servers("ttl.example")
        self.assertEqual(fake.queries.count(("ttl.example", "MX")), 2)

    def test_resolver_trouble_fails_open_and_is_logged(self):
        fake = self.dns({("flaky.example", "MX"): dns.exception.Timeout})
        with self.assertLogs("rag_api.access", "WARNING") as logs:
            self.assertEqual(ac.check_signup_email("a@flaky.example"), "a@flaky.example")
        self.assertIn("email_domain_lookup_failed", logs.output[0])
        self.assertIsNone(disposable.infrastructure_match("flaky.example"))
        self.assertTrue(disposable.receives_mail("flaky.example"))
        # Trouble is retried after a minute, not remembered for an hour.
        clock = [10_000.0]
        with patch.object(disposable.time, "monotonic", lambda: clock[0]), self.assertLogs("rag_api.access", "WARNING"):
            fake.table[("flaky2.example", "MX")] = dns.exception.Timeout
            self.assertEqual(disposable.mail_servers("flaky2.example").status, "error")
            fake.table[("flaky2.example", "MX")] = mx("mx.flaky2.example")
            clock[0] += disposable._ERROR_TTL - 1
            self.assertEqual(disposable.mail_servers("flaky2.example").status, "error")   # still the cached answer
            clock[0] += 2
            self.assertEqual(disposable.mail_servers("flaky2.example").status, "ok")

    def test_the_whole_lookup_is_time_bounded(self):
        clock = [0.0]

        def slow(name, record, timeout):
            self.assertLessEqual(timeout, disposable._QUERY_TIMEOUT)
            clock[0] += timeout                     # every query uses its whole allowance
            if record == "MX":
                return mx(*[f"mx{i}.slow.example" for i in range(6)])
            raise dns.exception.Timeout()

        with patch.object(disposable, "_resolve", slow), patch.object(disposable.time, "monotonic", lambda: clock[0]):
            result = disposable.mail_servers("slow.example")
        self.assertLessEqual(clock[0], disposable._BUDGET + 0.001)
        self.assertEqual(result.status, "ok")       # the MX answer arrived; unresolved servers are still checked by name

    def test_domains_without_mail_are_refused_as_before(self):
        self.dns({("nullmx.example", "MX"): [SimpleNamespace(preference=0, exchange=".")],
                  ("gone.example", "MX"): dns.resolver.NXDOMAIN})
        for email in ("a@nullmx.example", "b@gone.example", "c@nothing-at-all.example"):
            with self.subTest(email), self.assertRaisesRegex(ac.EmailRejected, "doesn't receive mail") as caught:
                ac.check_signup_email(email)
            self.assertEqual(caught.exception.reason, "no_mail")


class RoutesTest(Layered):
    """Every place an account or demo request starts uses the mail-server check."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for p in (patch.object(db, "DB_PATH", Path(tmp.name) / "test.db"),
                  patch.dict(os.environ, {"JWT_SECRET_KEY": "test-only-secret-key-not-for-production", "CITELY_APPROVED_EMAILS": "",
                                          "CITELY_ADMIN_EMAILS": "", "TURNSTILE_SECRET_KEY": "", "QUOTA_ENABLED": "false",
                                          "CITELY_DEMO_RECIPIENT": "owner@example.com", "ACS_SENDER_ADDRESS": "noreply@citely.test"})):
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        limiter.reset()
        import APP.main as main_module
        main_module._otp_last_sent.clear()
        self.client = TestClient(app)
        self.dns({("newtemp.shop", "MX"): mx("mx.newtemp.shop"), ("mx.newtemp.shop", "A"): ["116.202.9.167"],
                  ("realco.com", "MX"): mx("aspmx.l.google.com")})

    def refusal_reasons(self, kind):
        import json
        return [json.loads(e["detail"])["reason"] for e in db.list_events(types=[kind], limit=50)]

    def test_signup_sends_no_code_to_a_new_temp_domain(self):
        with patch("APP.main.otp_email.send_otp_email") as sent:
            r = self.client.post("/auth/signup", json={"email": "x@newtemp.shop", "password": "Velvet-Harbor-73x"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Temporary or disposable", r.json()["detail"])
        sent.assert_not_called()
        self.assertIsNone(db.get_pending_signup("x@newtemp.shop"))
        self.assertEqual(self.refusal_reasons("auth.signup_refused"), ["disposable"])

    def test_demo_request_from_a_new_temp_domain_is_refused(self):
        with patch("APP.main.deliver_demo_request") as delivered:
            r = self.client.post("/demo-requests", json={"name": "T", "email": "x@newtemp.shop", "phone": "+91 9876543210", "comment": "hi"})
        self.assertEqual(r.status_code, 400)
        delivered.assert_not_called()
        self.assertEqual(self.refusal_reasons("demo.request_refused"), ["disposable"])

    def test_new_social_accounts_on_a_temp_domain_are_refused_but_existing_ones_sign_in(self):
        for provider in ("github", "google"):
            with self.subTest(provider), patch(f"APP.main.auth.exchange_{provider}_code", return_value={"email": f"{provider}@newtemp.shop", "provider_user_id": provider}):
                r = self.client.post(f"/auth/{provider}/callback", json={"code": "c", "redirect_uri": "http://localhost/callback"})
                self.assertEqual(r.status_code, 400)
                self.assertIsNone(db.get_user_by_email(f"{provider}@newtemp.shop"))
        db.get_or_create_user_for_oauth("old@newtemp.shop", "github", "old-id")
        with patch("APP.main.auth.exchange_github_code", return_value={"email": "old@newtemp.shop", "provider_user_id": "old-id"}):
            self.assertEqual(self.client.post("/auth/github/callback", json={"code": "c"}).status_code, 200)

    def test_a_real_work_domain_still_signs_up(self):
        with patch("APP.main.otp_email.send_otp_email") as sent:
            r = self.client.post("/auth/signup", json={"email": "x@realco.com", "password": "Velvet-Harbor-73x"})
        self.assertEqual(r.status_code, 201)
        sent.assert_called_once()


if __name__ == "__main__":
    unittest.main()
