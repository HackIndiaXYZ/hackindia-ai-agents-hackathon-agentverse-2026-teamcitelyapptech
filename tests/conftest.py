"""Isolation shared by every test."""

import dns.resolver
import pytest


@pytest.fixture(autouse=True)
def no_real_dns(monkeypatch):
    """No test reaches a real DNS server (slow, flaky, and it would make
    results depend on today's internet). Unless a test supplies its own
    answers, every query says "no such record"; the sign-up email check is
    usually patched to "receives mail" on top of this. The in-process DNS
    cache is emptied around each test so answers never leak between tests."""
    from APP import disposable

    def no_records(name, record, timeout):
        raise dns.resolver.NoAnswer()

    monkeypatch.setattr(disposable, "_resolve", no_records)
    disposable.clear_cache()
    yield
    disposable.clear_cache()
