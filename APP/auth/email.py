"""Azure Communication Services Email client for OTP delivery."""

from __future__ import annotations

import os
import threading
from typing import Callable

import structlog
from azure.communication.email import EmailClient

from APP.auth.email_templates import (
    CONTACT_EMAIL,
    OAUTH_ONLY_RESET_SUBJECT,
    OTP_SUBJECT,
    RESET_SUBJECT,
    build_reset_url,
    oauth_only_reset_html,
    oauth_only_reset_plaintext,
    otp_html,
    otp_plaintext,
    reset_password_html,
    reset_password_plaintext,
)

# NOTE: the "From" display name recipients see ("Citely") is NOT settable per-message — ACS rejects the RFC 5322
# "Name <addr>" form on senderAddress with a 400 (verified). It's domain
# configuration on the sender username instead:
#   az communication email domain sender-username update \
#     --email-service-name <acs-email-resource> -g rag-api-rg \
#     --domain-name <domain> --sender-username DoNotReply \
#     --display-name "Citely"
# (or Portal: Email Communication Service -> Provision domains -> <domain>
#  -> MailFrom addresses -> edit Display name).
OTP_EXPIRY_MINUTES = 10
CONFIRM_TIMEOUT_SECONDS = 180

logger = structlog.get_logger("rag_api.email")

# (sent, reason when not sent, the email service's message id)
Outcome = Callable[[bool, str | None, str | None], None]

_client: EmailClient | None = None


def _get_client() -> EmailClient:
    global _client
    if _client is None:
        connection_string = os.getenv("ACS_PRIMARY_CONNECTION_STRING")
        if not connection_string:
            raise RuntimeError("ACS_PRIMARY_CONNECTION_STRING is not set")
        _client = EmailClient.from_connection_string(connection_string)
    return _client


def send_message(to_address: str, subject: str, plain: str, html: str | None = None, *, reply_to: str | None = CONTACT_EMAIL,
                 wait: bool = True, kind: str = "message", on_outcome: Outcome | None = None) -> dict | None:
    """Sends one email with both an HTML and a plain-text part (HTML-only mail
    scores worse with spam filters). Replies go to a monitored inbox rather
    than the no-reply sender.

    The send request itself is made here either way, so a message the email
    service refuses (sender, recipient, credentials) raises to the caller.
    wait=False skips waiting for the service to confirm the send (3-10 s),
    for codes someone is waiting on; that confirmation is then checked in the
    background and a failure is logged and shown in the admin activity feed.
    on_outcome(sent, reason, message_id) is then called with the result
    instead of the generic "email.failed" record (admin notifications record
    their own outcome, sent or failed)."""
    sender_address = os.getenv("ACS_SENDER_ADDRESS")
    if not sender_address:
        raise RuntimeError("ACS_SENDER_ADDRESS is not set")
    content = {"subject": subject, "plainText": plain}
    if html:
        content["html"] = html
    message = {"senderAddress": sender_address, "recipients": {"to": [{"address": to_address}]}, "content": content}
    if reply_to:
        message["replyTo"] = [{"address": reply_to}]
    poller = _get_client().begin_send(message)
    if wait:
        return poller.result()
    _confirm_in_background(poller, to_address, kind, on_outcome)
    return None


def _confirm_in_background(poller, to_address: str, kind: str, on_outcome: Outcome | None = None) -> threading.Thread:
    """"Succeeded" from the email service means it accepted the message and
    handed it on; it does not say whether the recipient's provider put it in
    the inbox or in spam (that is in the service's delivery logs, matched by
    the message id logged here)."""
    def confirm() -> None:
        message_id = None
        try:
            result = poller.result(timeout=CONFIRM_TIMEOUT_SECONDS)
            message_id = (result or {}).get("id")
            status = (result or {}).get("status")
            if status != "Succeeded":
                error = (result or {}).get("error") or f"not confirmed within {CONFIRM_TIMEOUT_SECONDS} s"
                raise RuntimeError(f"status {status}: {error}")
        except Exception as exc:  # noqa: BLE001 — reported, not swallowed: logged and recorded
            reason = f"{type(exc).__name__}: {exc}"[:300]
            logger.error("email_send_failed", kind=kind, error=reason, message_id=message_id)
            if on_outcome is not None:
                _report(on_outcome, False, reason, message_id, kind)
            else:
                from APP import activity
                activity.record("email.failed", email=to_address, detail={"kind": kind, "error": reason})
            return
        logger.info("email_sent", kind=kind, message_id=message_id)
        if on_outcome is not None:
            _report(on_outcome, True, None, message_id, kind)

    thread = threading.Thread(target=confirm, name=f"email-confirm-{kind}", daemon=True)
    thread.start()
    return thread


def _report(on_outcome: Outcome, sent: bool, reason: str | None, message_id: str | None, kind: str) -> None:
    try:
        on_outcome(sent, reason, message_id)
    except Exception:  # noqa: BLE001 — a background thread has no caller to raise to: logged
        logger.exception("email_outcome_record_failed", kind=kind)


def send_otp_email(to_address: str, code: str) -> None:
    send_message(to_address, OTP_SUBJECT, otp_plaintext(code, OTP_EXPIRY_MINUTES), otp_html(code, OTP_EXPIRY_MINUTES),
                 wait=False, kind="sign-up code")


def send_password_reset_email(to_address: str, token: str) -> None:
    reset_url = build_reset_url(to_address, token)
    send_message(to_address, RESET_SUBJECT, reset_password_plaintext(reset_url, OTP_EXPIRY_MINUTES),
                 reset_password_html(reset_url, OTP_EXPIRY_MINUTES), wait=False, kind="password reset")


def send_oauth_only_reset_notice(to_address: str) -> None:
    """Sent instead of send_password_reset_email when the account has no
    password to reset — no token is generated or issued for this path.
    """
    send_message(to_address, OAUTH_ONLY_RESET_SUBJECT, oauth_only_reset_plaintext(), oauth_only_reset_html())


def send_login_code_email(to_address: str, code: str) -> None:
    from APP.auth import email_templates as t
    send_message(to_address, t.LOGIN_CODE_SUBJECT, t.login_code_plaintext(code, OTP_EXPIRY_MINUTES), t.login_code_html(code, OTP_EXPIRY_MINUTES),
                 wait=False, kind="sign-in code")


def send_new_account_review_email(admin_address: str, email: str, method: str, review_url: str, *, test: bool = False,
                                  on_outcome: Outcome | None = None) -> None:
    """To the admin. Replies go to the Citely inbox like every other Citely
    email, never to the new account's address: an unknown (often temporary)
    address as Reply-To is a phishing signal to spam filters."""
    from APP.auth import email_templates as t
    send_message(admin_address, t.new_account_subject(test=test), t.new_account_plaintext(email=email, method=method, review_url=review_url, test=test),
                 t.new_account_html(email=email, method=method, review_url=review_url, test=test), wait=False,
                 kind="test notification (to admin)" if test else "new account (to admin)", on_outcome=on_outcome)


def send_account_approved_email(to_address: str) -> None:
    from APP.auth import email_templates as t
    send_message(to_address, t.ACCOUNT_APPROVED_SUBJECT, t.account_approved_plaintext(email=to_address), t.account_approved_html(email=to_address),
                 wait=False, kind="account approved")


def send_account_declined_email(to_address: str) -> None:
    from APP.auth import email_templates as t
    send_message(to_address, t.ACCOUNT_DECLINED_SUBJECT, t.account_declined_plaintext(email=to_address), t.account_declined_html(email=to_address),
                 wait=False, kind="account declined")
