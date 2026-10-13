"""Demo requests and approvals. A demo request never creates an account; an
approval clears an address to use Citely (and approves its account, if one
already exists)."""
import os
import re

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from APP import db
from APP.auth import email as mail


class DemoRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    phone: str = Field(min_length=7, max_length=40)
    comment: str = Field(min_length=1, max_length=2000)

    @field_validator("email")
    @classmethod
    def valid_email(cls, value):
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("Enter a valid email address")
        return value

    @field_validator("phone")
    @classmethod
    def valid_phone(cls, value):
        if not re.fullmatch(r"[+\d ().-]+", value) or len(re.sub(r"\D", "", value)) < 7:
            raise ValueError("Enter a valid phone number")
        return value


def admin_console_link(section: str) -> str:
    """The admin console, opened on this environment's section (e.g.
    https://admin.citely.example/#prod/pending): no page in between."""
    from APP.admin import _environment
    base = os.getenv("ADMIN_CONSOLE_URL", "https://admin.citely.example/").rstrip("/") + "/"
    env = _environment()["name"]
    return f"{base}#{'this' if env == 'local' else env}/{section}"


def deliver_demo_request(payload):
    # The request is already stored (the admin console lists it), so the
    # email is the notice: sent without waiting for the service's
    # confirmation. A missing address or a refused send fails here (and is
    # recorded); the outcome of the rest is recorded when it is known.
    # Recipient and subject are server-controlled; the visitor's text is
    # escaped by the template. No account creation or automatic approval.
    from APP.auth import email_templates as t
    fields = dict(name=payload.name, email=payload.email, phone=payload.phone, reason=payload.comment,
                  review_url=admin_console_link("requests"))
    if notify_admin(DEMO_REQUEST, payload.email, lambda recipient, on_outcome: mail.send_message(
            recipient, t.access_request_subject(), t.access_request_plaintext(**fields), t.access_request_html(**fields),
            wait=False, kind="demo request (to admin)", on_outcome=on_outcome)) is not None:
        raise HTTPException(status_code=503, detail="We could not confirm your request. Please try again later.")


def send_access_approved_email(email_address: str) -> None:
    """The "you can now sign up" email. Best effort: the approval is recorded
    either way, and the person can sign up from the site without it."""
    import structlog
    from APP import usage
    from APP.auth import email_templates as t
    allowance = None
    if usage.enabled():
        lim = usage.limits()
        allowance = (f"{lim[usage.UPLOAD]['account']} uploads (up to {usage.max_upload_bytes() // (1024 * 1024)} MB "
                     f"and {usage.max_pages()} pages each) and {lim[usage.QUESTION]['account']} questions" + (" a day" if usage.period() == "daily" else ""))
    try:
        mail.send_message(email_address, t.ACCESS_APPROVED_SUBJECT,
                          t.access_approved_plaintext(email=email_address, allowance=allowance),
                          t.access_approved_html(email=email_address, allowance=allowance), wait=False, kind="access approved")
    except Exception:  # noqa: BLE001
        structlog.get_logger("rag_api").warning("approval_email_failed")


def approve_email(email_address: str) -> dict:
    """Approves an address. If it already has a pending or declined account,
    that account is approved and told so; otherwise the person is invited to
    sign up. Returns {"newly": bool, "account": bool}."""
    from APP.access_control import canonical_email
    newly = db.approve_access(email_address)
    user = db.get_user_by_canonical_email(canonical_email(email_address))
    if user is not None:
        if user["status"] in ("pending", "declined"):
            db.set_user_status(user["id"], "approved")
            _send(mail.send_account_approved_email, user["email"])
            return {"newly": True, "account": True}
        return {"newly": newly, "account": True}
    if newly:
        send_access_approved_email(email_address)
    return {"newly": newly, "account": False}


# --------------------------------------------------------------------------- #
# Admin notifications: "new account awaiting review", "new demo request" and
# the admin console's test. Each one's outcome is recorded as an
# "admin.notified" event (sent or failed, with the reason), so a notice that
# never went out shows in the admin console instead of passing unnoticed.
# --------------------------------------------------------------------------- #

NEW_ACCOUNT, DEMO_REQUEST, TEST = "new account", "demo request", "test"


def admin_recipient() -> str | None:
    """Where admin notifications go (CITELY_DEMO_RECIPIENT), if it's a usable address."""
    recipient = os.getenv("CITELY_DEMO_RECIPIENT", "").strip()
    return recipient if re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", recipient) else None


def _record_notice(kind: str, about: str | None, sent: bool, reason: str | None = None, message_id: str | None = None,
                   test_id: str | None = None) -> None:
    from APP import activity
    detail = {"kind": kind, "outcome": "sent" if sent else "failed"}
    if reason:
        detail["reason"] = reason
    if message_id:
        detail["message_id"] = message_id
    if test_id:
        detail["test_id"] = test_id
    activity.record("admin.notified", email=about, detail=detail)


def notify_admin(kind: str, about: str | None, send, *, test_id: str | None = None) -> str | None:
    """Sends one admin notification with send(recipient, on_outcome). Returns
    why it failed (also logged and recorded) when there is no recipient or
    the email service refuses the send, or None once the service accepted it;
    the result, sent or failed, is then recorded when the service confirms."""
    import structlog
    log = structlog.get_logger("rag_api")
    recipient = admin_recipient()
    if recipient is None:
        reason = "No admin notification address is set (CITELY_DEMO_RECIPIENT)."
        log.error("admin_notification_failed", kind=kind, error=reason)
        _record_notice(kind, about, False, reason, test_id=test_id)
        return reason
    try:
        send(recipient, lambda sent, reason, message_id: _record_notice(kind, about, sent, reason, message_id, test_id))
    except Exception as exc:  # noqa: BLE001 — recorded and logged; the caller decides what the visitor sees
        reason = f"Refused by the email service: {type(exc).__name__}: {exc}"[:300]
        log.error("admin_notification_failed", kind=kind, error=reason)
        _record_notice(kind, about, False, reason, test_id=test_id)
        return reason
    return None


def notify_admin_of_pending_account(email_address: str, method: str) -> str | None:
    """"New account awaiting review" to the admin inbox, linking straight to
    Pending review in the admin console. Never fails the sign-up (the account
    exists and Pending review lists it); a failure is recorded instead."""
    return notify_admin(NEW_ACCOUNT, email_address, lambda recipient, on_outcome: mail.send_new_account_review_email(
        recipient, email_address, method, admin_console_link("pending"), on_outcome=on_outcome))


def send_test_notification() -> dict:
    """The admin console's "Send test notification": a sample "new account
    awaiting review" to the configured address. Returns its test id, to
    look up the outcome by, and why it failed if the service refused it."""
    import uuid
    test_id = uuid.uuid4().hex[:12]
    failed = notify_admin(TEST, None, lambda recipient, on_outcome: mail.send_new_account_review_email(
        recipient, "sample.person@example.com", "email", admin_console_link("pending"), test=True, on_outcome=on_outcome), test_id=test_id)
    return {"test_id": test_id, "failed": failed}


def _send(fn, *args) -> None:
    import structlog
    try:
        fn(*args)
    except Exception:  # noqa: BLE001 — the change is recorded either way; logged, not hidden
        structlog.get_logger("rag_api").warning("account_email_failed", kind=fn.__name__)
