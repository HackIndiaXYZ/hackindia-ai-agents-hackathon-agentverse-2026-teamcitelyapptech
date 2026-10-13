"""HTML and plain-text bodies for every email Citely sends.

One layout (_layout) wraps five messages: the verification code, the password
reset, the reset notice for Google/GitHub accounts, the access request that
reaches the admin, and the "you're approved" invite.

Email-client rules this file follows on purpose:
- Tables and inline styles only. Outlook ignores flex/grid and most of <style>;
  the <style> block carries just dark mode and the phone layout, and clients
  that drop it fall back to the inline light design.
- Images are PNGs hosted on the site (Gmail shows no SVG and strips data: URIs),
  each with alt text, and nothing important lives only in an image: the logo
  sits next to the "Citely" wordmark in text, and every social icon has a label.
- Every message also has a plain-text part. HTML-only mail scores worse with
  spam filters, and some people read text-only.
- Anything a visitor typed (a name, a reason) is escaped before it is placed in
  HTML, because the access request carries it into the admin's inbox.
"""

from __future__ import annotations

import html
import os
from urllib.parse import quote

# Where links point. Env-overridable so dev builds aim at /dev/.
APP_PUBLIC_URL = os.getenv("APP_PUBLIC_URL", "https://citely.example/")

# Images live on the production site whatever the environment, so they still
# load when a dev email is opened after a dev deploy has moved on.
ASSET_BASE = os.getenv("EMAIL_ASSET_BASE", "https://citely.example/branding/email/")

INSTAGRAM_URL = "https://www.instagram.com/citely.example/"
X_URL = "https://x.com/citely-example"
CONTACT_EMAIL = "admin@citely.example"
LOCATION = "Dwarka, New Delhi, India"

# Brand tokens, matching the site: warm paper, near-black ink, Citely red.
PAPER = "#FAF9F6"
GROUND = "#EFECE6"
INK = "#1F1E1B"
MUTED = "#5F5E58"
LINE = "#DEDAD2"
RED = "#E52B15"
TINT = "#F3EFE8"
FONT = "Manrope, 'Helvetica Neue', Helvetica, Arial, sans-serif"

# Dark mode for clients that honour prefers-color-scheme (Apple Mail, iOS,
# Outlook.com via [data-ogsc]). Kept as one list so the preview can reuse it.
DARK_RULES = {
    ".c-ground": "background-color:#161613 !important;",
    ".c-card": f"background-color:#22221E !important; border-color:#F2F0EA !important;",
    ".c-ledge": "border-color:#FF6448 !important;",
    ".c-ink": "color:#F2F0EA !important;",
    ".c-muted": "color:#B5B6AA !important;",
    ".c-red": "color:#FF7A61 !important;",
    ".c-line": "border-color:#3A3B35 !important;",
    ".c-tint": "background-color:#2C2C27 !important;",
    ".c-btn": "background-color:#FF6448 !important; border-color:#FF6448 !important;",
    ".c-btn-text": "color:#161613 !important;",
}


def _dark_css(prefix: str) -> str:
    return "\n".join(f"    {prefix}{sel} {{ {rule} }}" for sel, rule in DARK_RULES.items())


def _e(value: object) -> str:
    return html.escape(str(value), quote=True)


def _button(url: str, label: str) -> str:
    """A 'bulletproof' button: a table cell with its own background and a
    full-size link, so it renders as a button in Outlook too."""
    return f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0;">
  <tr>
    <td class="c-btn" bgcolor="{RED}" style="background-color:{RED}; border:2px solid {INK};">
      <a class="c-btn-text" href="{_e(url)}" target="_blank" style="display:inline-block; padding:15px 26px; font-family:{FONT}; font-size:15px; font-weight:800; letter-spacing:0.2px; color:#FFFFFF; text-decoration:none;">{_e(label)}&nbsp;&rarr;</a>
    </td>
  </tr>
</table>"""


def _link_fallback(url: str) -> str:
    return f"""
<p class="c-muted" style="margin:18px 0 0; font-family:{FONT}; font-size:13px; line-height:1.55; color:{MUTED};">
  Button not working? Paste this into your browser:<br>
  <a class="c-red" href="{_e(url)}" target="_blank" style="color:{RED}; text-decoration:underline; word-break:break-all;">{_e(url)}</a>
</p>"""


def _eyebrow(text: str) -> str:
    return (f'<p class="c-red" style="margin:0 0 14px; font-family:{FONT}; font-size:12px; font-weight:800; '
            f'letter-spacing:2.2px; text-transform:uppercase; color:{RED};">{_e(text)}</p>')


def _h1(text: str) -> str:
    return (f'<h1 class="c-ink" style="margin:0 0 16px; font-family:{FONT}; font-size:30px; line-height:1.15; '
            f'font-weight:800; letter-spacing:-0.8px; color:{INK};">{text}</h1>')


def _p(text: str, *, size: int = 16, gap: int = 0) -> str:
    return (f'<p class="c-muted" style="margin:0 0 {gap}px; font-family:{FONT}; font-size:{size}px; line-height:1.6; '
            f'color:{MUTED};">{text}</p>')


def _note(title: str, text: str) -> str:
    """The quiet 'didn't ask for this?' block under a divider."""
    return f"""
<tr><td class="c-line" style="border-top:1px solid {LINE}; padding:24px 0 0;">
  <p class="c-ink" style="margin:0 0 4px; font-family:{FONT}; font-size:14px; font-weight:800; color:{INK};">{_e(title)}</p>
  <p class="c-muted" style="margin:0; font-family:{FONT}; font-size:14px; line-height:1.55; color:{MUTED};">{text}</p>
</td></tr>"""


def _social(icon: str, label: str, url: str) -> str:
    return f"""
<td style="padding:0 18px 0 0;">
  <a href="{_e(url)}" target="_blank" style="text-decoration:none;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding:0 8px 0 0;"><img src="{ASSET_BASE}{icon}" width="24" height="24" alt="" style="display:block; width:24px; height:24px; border:0;"></td>
      <td class="c-ink" style="font-family:{FONT}; font-size:13px; font-weight:700; color:{INK};">{_e(label)}</td>
    </tr></table>
  </a>
</td>"""


def _layout(*, title: str, preheader: str, section: str, body: str, reason: str) -> str:
    """The shared frame: wordmark row, the card with its red ledge, and the
    footer with social links, location and why the email was sent."""
    return f"""<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{_e(title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&display=swap" rel="stylesheet">
<style>
  body, table, td, a {{ -ms-text-size-adjust:100%; -webkit-text-size-adjust:100%; }}
  table, td {{ mso-table-lspace:0pt; mso-table-rspace:0pt; border-collapse:collapse; }}
  img {{ border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }}
  body {{ margin:0 !important; padding:0 !important; width:100% !important; }}
  @media (prefers-color-scheme: dark) {{
{_dark_css("")}
  }}
{_dark_css("[data-ogsc] ")}
  @media screen and (max-width: 620px) {{
    .container {{ width:100% !important; }}
    .pad {{ padding-left:22px !important; padding-right:22px !important; }}
    .code {{ font-size:36px !important; letter-spacing:8px !important; }}
    .h-section {{ display:none !important; }}
  }}
</style>
</head>
<body class="c-ground" style="margin:0; padding:0; background-color:{GROUND};">
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:{GROUND}; opacity:0;">{_e(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="c-ground" bgcolor="{GROUND}" style="background-color:{GROUND};">
<tr><td align="center" style="padding:40px 14px 48px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="container" style="width:600px; max-width:600px;">

    <!-- Wordmark -->
    <tr><td style="padding:0 0 22px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle">
          <a href="{_e(APP_PUBLIC_URL)}" target="_blank" style="text-decoration:none;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="padding:0 12px 0 0;"><img src="{ASSET_BASE}logo-tile.png" width="44" height="44" alt="Citely" style="display:block; width:44px; height:44px; border:0;"></td>
              <td class="c-ink" style="font-family:{FONT}; font-size:24px; font-weight:800; letter-spacing:-0.6px; color:{INK};">Citely</td>
            </tr></table>
          </a>
        </td>
        <td align="right" valign="middle" class="h-section c-muted" style="font-family:{FONT}; font-size:11px; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:{MUTED};">{_e(section)}</td>
      </tr></table>
    </td></tr>

    <!-- Card: ink frame with a red ledge, like the site's offset shadow -->
    <tr><td class="c-ledge" style="border-right:8px solid {RED}; border-bottom:8px solid {RED};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td class="c-card pad" bgcolor="{PAPER}" style="background-color:{PAPER}; border:2px solid {INK}; padding:44px 46px 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
{body}
          </table>
        </td></tr>
      </table>
    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:30px 2px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
{_social("instagram.png", "Instagram", INSTAGRAM_URL)}
{_social("x.png", "Twitter", X_URL)}
{_social("email.png", "Email us", "mailto:" + CONTACT_EMAIL)}
      </tr></table>
      <p class="c-muted" style="margin:22px 0 6px; font-family:{FONT}; font-size:13px; line-height:1.55; color:{MUTED};">
        <strong class="c-ink" style="color:{INK};">Citely</strong> &middot; Answers from your documents, with the source on the page.<br>
        {_e(LOCATION)} &middot; <a class="c-muted" href="{_e(APP_PUBLIC_URL)}" target="_blank" style="color:{MUTED}; text-decoration:underline;">citely.example</a>
      </p>
      <p class="c-muted" style="margin:0; font-family:{FONT}; font-size:12px; line-height:1.55; color:{MUTED};">{reason}</p>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>
"""


def _plain_footer(reason: str) -> str:
    return (
        f"\n--\nCitely - answers from your documents, with the source on the page.\n"
        f"{LOCATION} - {APP_PUBLIC_URL}\n"
        f"Instagram: {INSTAGRAM_URL}\nTwitter: {X_URL}\nEmail: {CONTACT_EMAIL}\n\n{reason}\n"
    )


# ---------------------------------------------------------------------------
# Verification code
# ---------------------------------------------------------------------------

OTP_SUBJECT = "Your Citely verification code"
_OTP_REASON = "You're receiving this because this address was used to sign up or sign in on citely.example."


def otp_plaintext(code: str, expiry_minutes: int = 10) -> str:
    return (
        f"Your Citely verification code is {code}\n\n"
        f"Enter it on the sign-in page to finish. It expires in {expiry_minutes} minutes.\n\n"
        f"Didn't request this? You can ignore this email. Nothing changes without the code."
        + _plain_footer(_OTP_REASON)
    )


def otp_html(code: str, expiry_minutes: int = 10) -> str:
    body = f"""
<tr><td>
  {_eyebrow("Verify it's you")}
  {_h1("Your verification code")}
  {_p("Enter this code on the Citely sign-in page to finish.", gap=26)}
</td></tr>
<tr><td style="padding:0 0 12px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="c-tint" bgcolor="{TINT}" style="background-color:{TINT}; border-left:6px solid {RED}; padding:20px 28px 20px 24px;">
      <span class="code c-ink" style="font-family:'SF Mono', Menlo, Consolas, 'Courier New', monospace; font-size:42px; line-height:1; font-weight:700; letter-spacing:12px; color:{INK};">{_e(code)}</span>
    </td>
  </tr></table>
</td></tr>
<tr><td style="padding:0 0 30px;">
  {_p(f"Expires in <strong class='c-ink' style='color:{INK};'>{expiry_minutes} minutes</strong>. Use it once.", size=14)}
</td></tr>
{_note("Didn't ask for this?", "You can ignore this email. Nobody can sign in to your account without this code.")}"""
    return _layout(title=OTP_SUBJECT, preheader=f"{code} is your Citely code. It expires in {expiry_minutes} minutes.",
                   section="Account security", body=body, reason=_e(_OTP_REASON))


# ---------------------------------------------------------------------------
# Password reset
# ---------------------------------------------------------------------------

RESET_SUBJECT = "Reset your Citely password"
_RESET_REASON = "You're receiving this because a password reset was requested for this address on citely.example."


def build_reset_url(email: str, token: str) -> str:
    # Trailing slash matters: next.config.mjs sets trailingSlash: true, so the
    # static-exported route is reset-password/index.html.
    return f"{APP_PUBLIC_URL.rstrip('/')}/reset-password/?email={quote(email)}&token={quote(token)}"


def reset_password_plaintext(reset_url: str, expiry_minutes: int = 10) -> str:
    return (
        f"Reset your Citely password:\n{reset_url}\n\n"
        f"The link expires in {expiry_minutes} minutes and works once.\n\n"
        f"Didn't request this? Ignore this email. Your password stays the same unless you open the link and choose a new one."
        + _plain_footer(_RESET_REASON)
    )


def reset_password_html(reset_url: str, expiry_minutes: int = 10) -> str:
    body = f"""
<tr><td>
  {_eyebrow("Password reset")}
  {_h1("Choose a new password")}
  {_p(f"Someone asked to reset the password for this Citely account. If it was you, choose a new one below. The link expires in <strong class='c-ink' style='color:{INK};'>{expiry_minutes} minutes</strong> and works once.", gap=28)}
</td></tr>
<tr><td style="padding:0 0 30px;">
  {_button(reset_url, "Choose a new password")}
  {_link_fallback(reset_url)}
</td></tr>
{_note("Didn't ask for this?", "Ignore this email. Your password stays the same unless you open the link and choose a new one.")}"""
    return _layout(title=RESET_SUBJECT, preheader=f"Choose a new password. The link expires in {expiry_minutes} minutes.",
                   section="Account security", body=body, reason=_e(_RESET_REASON))


# ---------------------------------------------------------------------------
# Reset requested for an account that signs in with Google or GitHub
# ---------------------------------------------------------------------------

OAUTH_ONLY_RESET_SUBJECT = "About your Citely password reset"


def oauth_only_reset_plaintext() -> str:
    """Sent instead of a reset link when the account has no password. No token
    is issued, and only the account owner ever sees which email they got."""
    return (
        "We received a request to reset the password for this Citely account.\n\n"
        "This account signs in with Google or GitHub, so it has no password to reset. "
        "Sign in with whichever of those you used before:\n"
        f"{APP_PUBLIC_URL.rstrip('/')}/signin/\n\n"
        "Didn't request this? You can ignore this email."
        + _plain_footer(_RESET_REASON)
    )


def oauth_only_reset_html() -> str:
    signin = APP_PUBLIC_URL.rstrip("/") + "/signin/"
    body = f"""
<tr><td>
  {_eyebrow("Password reset")}
  {_h1("This account has no password to reset")}
  {_p("It signs in with <strong class='c-ink' style='color:#1F1E1B;'>Google</strong> or <strong class='c-ink' style='color:#1F1E1B;'>GitHub</strong>. Sign in with whichever of those you used before.", gap=28)}
</td></tr>
<tr><td style="padding:0 0 30px;">
  {_button(signin, "Go to sign in")}
</td></tr>
{_note("Didn't ask for this?", "You can ignore this email. Nothing about your account has changed.")}"""
    return _layout(title=OAUTH_ONLY_RESET_SUBJECT, preheader="Your account signs in with Google or GitHub.",
                   section="Account security", body=body, reason=_e(_RESET_REASON))


# ---------------------------------------------------------------------------
# Access request (to the admin)
# ---------------------------------------------------------------------------

# Fixed, like the new-account notice: the visitor's text stays in the body,
# escaped, and never reaches the subject line.
ACCESS_REQUEST_SUBJECT = "New Citely demo request"
_ADMIN_REASON = "You're receiving this because you're the Citely admin."


def access_request_subject() -> str:
    return ACCESS_REQUEST_SUBJECT


def access_request_plaintext(*, name: str, email: str, phone: str, reason: str, review_url: str | None) -> str:
    text = f"New access request\n\nName: {name}\nEmail: {email}\nPhone: {phone}\n\nWhy Citely:\n{reason}\n"
    if review_url:
        text += f"\nReview it in the admin console:\n{review_url}\n"
    return text + _plain_footer(_ADMIN_REASON)


def access_request_html(*, name: str, email: str, phone: str, reason: str, review_url: str | None) -> str:
    def row(label: str, value: str) -> str:
        return f"""
    <tr>
      <td class="c-line c-muted" width="88" valign="top" style="border-top:1px solid {LINE}; padding:12px 12px 12px 0; font-family:{FONT}; font-size:12px; font-weight:800; letter-spacing:1.4px; text-transform:uppercase; color:{MUTED};">{label}</td>
      <td class="c-line c-ink" valign="top" style="border-top:1px solid {LINE}; padding:12px 0; font-family:{FONT}; font-size:15px; font-weight:700; color:{INK}; word-break:break-word;">{value}</td>
    </tr>"""
    action = (f"""
<tr><td style="padding:0 0 4px;">
  {_button(review_url, "Review in admin")}
</td></tr>
<tr><td style="padding:14px 0 30px;">
  {_p("Opens Demo requests in the admin console. Approving there emails them the sign-up link.", size=13)}
</td></tr>""" if review_url else "")
    body = f"""
<tr><td>
  {_eyebrow("New access request")}
  {_h1(f"{_e(name)} wants to try Citely")}
</td></tr>
<tr><td style="padding:6px 0 24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    {row("Email", f'<a class="c-ink" href="mailto:{_e(email)}" style="color:{INK}; text-decoration:underline;">{_e(email)}</a>')}
    {row("Phone", _e(phone))}
  </table>
</td></tr>
<tr><td style="padding:0 0 30px;">
  <p class="c-muted" style="margin:0 0 8px; font-family:{FONT}; font-size:12px; font-weight:800; letter-spacing:1.4px; text-transform:uppercase; color:{MUTED};">Why Citely</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="c-tint c-ink" bgcolor="{TINT}" style="background-color:{TINT}; border-left:4px solid {RED}; padding:16px 20px; font-family:{FONT}; font-size:15px; line-height:1.6; color:{INK};">{_e(reason).replace(chr(10), "<br>")}</td>
  </tr></table>
</td></tr>{action}
{_note("Not expecting this?", f"Ignore it and nothing happens. To answer {_e(name)}, write to the address above.")}"""
    return _layout(title=access_request_subject(), preheader=f"{name} asked for access to Citely.",
                   section="Access request", body=body, reason=_ADMIN_REASON)


# ---------------------------------------------------------------------------
# Access approved (to the person)
# ---------------------------------------------------------------------------

ACCESS_APPROVED_SUBJECT = "You're approved: create your Citely account"
_APPROVED_REASON = "You're receiving this because you asked for access to Citely on citely.example."


def _signup_url() -> str:
    return APP_PUBLIC_URL.rstrip("/") + "/signin/?mode=signup"


def access_approved_plaintext(*, email: str, allowance: str | None = None) -> str:
    text = (
        "Good news: your request to try Citely was approved.\n\n"
        f"Create your account:\n{_signup_url()}\n\n"
        f"Sign up with this email address: {email}\n\n"
        "1. Create your account with this email.\n"
        "2. Enter the code we email you.\n"
        "3. Upload a document and ask your first question.\n"
    )
    if allowance:
        text += f"\nYour demo includes {allowance}.\n"
    return text + _plain_footer(_APPROVED_REASON)


def access_approved_html(*, email: str, allowance: str | None = None) -> str:
    def step(n: int, title: str, detail: str) -> str:
        return f"""
    <tr>
      <td width="40" valign="top" style="padding:0 0 14px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td class="c-ink" width="28" height="28" align="center" valign="middle" style="width:28px; height:28px; border:2px solid {INK}; font-family:{FONT}; font-size:13px; font-weight:800; color:{INK};">{n}</td>
        </tr></table>
      </td>
      <td valign="top" style="padding:3px 0 14px;">
        <p class="c-ink" style="margin:0; font-family:{FONT}; font-size:15px; font-weight:800; color:{INK};">{title}</p>
        <p class="c-muted" style="margin:2px 0 0; font-family:{FONT}; font-size:14px; line-height:1.5; color:{MUTED};">{detail}</p>
      </td>
    </tr>"""
    allowance_row = (f"""
<tr><td class="c-line" style="border-top:1px solid {LINE}; padding:20px 0 0;">
  {_p(f"Your demo includes {_e(allowance)}.", size=14)}
</td></tr>""" if allowance else "")
    body = f"""
<tr><td>
  {_eyebrow("Access approved")}
  {_h1("You're in. Create your Citely account.")}
  {_p("Your request to try Citely was approved. Upload a document, ask a question, and every answer shows the exact passage it came from.", gap=24)}
</td></tr>
<tr><td style="padding:0 0 26px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="c-tint" bgcolor="{TINT}" style="background-color:{TINT}; border-left:6px solid {RED}; padding:14px 20px;">
      <p class="c-muted" style="margin:0 0 2px; font-family:{FONT}; font-size:11px; font-weight:800; letter-spacing:1.6px; text-transform:uppercase; color:{MUTED};">Sign up with</p>
      <p class="c-ink" style="margin:0; font-family:{FONT}; font-size:17px; font-weight:800; color:{INK}; word-break:break-all;">{_e(email)}</p>
    </td>
  </tr></table>
</td></tr>
<tr><td style="padding:0 0 30px;">
  {_button(_signup_url(), "Create my account")}
</td></tr>
<tr><td style="padding:0 0 10px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    {step(1, "Create your account", "Use the email address above. Approval is tied to it.")}
    {step(2, "Enter the code we email you", "It arrives within a minute and expires after 10.")}
    {step(3, "Upload a document and ask", "PDF, Word, PowerPoint, Excel or an image.")}
  </table>
</td></tr>{allowance_row}"""
    return _layout(title=ACCESS_APPROVED_SUBJECT, preheader="Your request was approved. Create your account with this email address.",
                   section="Welcome", body=body, reason=_e(_APPROVED_REASON))


# ---------------------------------------------------------------------------
# Sign-in code (an approved account confirming a sign-in)
# ---------------------------------------------------------------------------

LOGIN_CODE_SUBJECT = "Your Citely sign-in code"
_LOGIN_CODE_REASON = "You're receiving this because someone signed in to your Citely account on citely.example."


def login_code_plaintext(code: str, expiry_minutes: int = 10) -> str:
    return (
        f"Your Citely sign-in code is {code}\n\n"
        f"Enter it to finish signing in. It expires in {expiry_minutes} minutes.\n\n"
        "Didn't try to sign in? Someone may know your password. Reset it from the sign-in page; "
        "nobody can get in without this code."
        + _plain_footer(_LOGIN_CODE_REASON)
    )


def login_code_html(code: str, expiry_minutes: int = 10) -> str:
    body = f"""
<tr><td>
  {_eyebrow("Sign-in")}
  {_h1("Confirm it's you")}
  {_p("Enter this code to finish signing in to Citely.", gap=26)}
</td></tr>
<tr><td style="padding:0 0 12px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="c-tint" bgcolor="{TINT}" style="background-color:{TINT}; border-left:6px solid {RED}; padding:20px 28px 20px 24px;">
      <span class="code c-ink" style="font-family:'SF Mono', Menlo, Consolas, 'Courier New', monospace; font-size:42px; line-height:1; font-weight:700; letter-spacing:12px; color:{INK};">{_e(code)}</span>
    </td>
  </tr></table>
</td></tr>
<tr><td style="padding:0 0 30px;">
  {_p(f"Expires in <strong class='c-ink' style='color:{INK};'>{expiry_minutes} minutes</strong>. Use it once.", size=14)}
</td></tr>
{_note("Didn't try to sign in?", "Someone may know your password. Reset it from the sign-in page. Nobody can get in without this code.")}"""
    return _layout(title=LOGIN_CODE_SUBJECT, preheader=f"{code} is your Citely sign-in code. It expires in {expiry_minutes} minutes.",
                   section="Account security", body=body, reason=_e(_LOGIN_CODE_REASON))


# ---------------------------------------------------------------------------
# New account awaiting review (to the admin)
# ---------------------------------------------------------------------------

# The subject is fixed: no address or visitor text in it. A stranger's
# address (often a temporary one) in the subject or as Reply-To is a strong
# spam signal, and it hid this notice in the admin's spam folder once.
NEW_ACCOUNT_SUBJECT = "New Citely account awaiting review"
_TEST_NOTE = "This is a test from the admin console. Nobody signed up; the address above is a sample."


def new_account_subject(*, test: bool = False) -> str:
    return ("Test: " if test else "") + NEW_ACCOUNT_SUBJECT


def new_account_plaintext(*, email: str, method: str, review_url: str, test: bool = False) -> str:
    return (
        (f"{_TEST_NOTE}\n\n" if test else "")
        + f"{email} created a Citely account ({method}) and is waiting for review.\n\n"
        f"Approve or decline it in the admin console: {review_url}\n"
        + _plain_footer(_ADMIN_REASON)
    )


def new_account_html(*, email: str, method: str, review_url: str, test: bool = False) -> str:
    test_row = f"""
<tr><td style="padding:0 0 22px;">
  {_p(f"<strong class='c-ink' style='color:{INK};'>Test.</strong> {_e(_TEST_NOTE)}", size=14)}
</td></tr>""" if test else ""
    body = f"""{test_row}
<tr><td>
  {_eyebrow("Review")}
  {_h1("A new account is waiting.")}
  {_p("Someone created a Citely account. They can't use it until you approve them.", gap=24)}
</td></tr>
<tr><td style="padding:0 0 26px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="c-tint" bgcolor="{TINT}" style="background-color:{TINT}; border-left:6px solid {RED}; padding:14px 20px;">
      <p class="c-muted" style="margin:0 0 2px; font-family:{FONT}; font-size:11px; font-weight:800; letter-spacing:1.6px; text-transform:uppercase; color:{MUTED};">Signed up with {_e(method)}</p>
      <p class="c-ink" style="margin:0; font-family:{FONT}; font-size:17px; font-weight:800; color:{INK}; word-break:break-all;">{_e(email)}</p>
    </td>
  </tr></table>
</td></tr>
<tr><td style="padding:0 0 30px;">
  {_button(review_url, "Review in admin")}
  {_link_fallback(review_url)}
</td></tr>
{_note("Not sure?", "Leave it pending, or decline it there. They'll get a polite note either way.")}"""
    return _layout(title=new_account_subject(test=test), preheader=f"Someone signed up with {method} and is waiting for approval.",
                   section="Account review", body=body, reason=_ADMIN_REASON)


# ---------------------------------------------------------------------------
# Account approved / declined (to the person)
# ---------------------------------------------------------------------------

ACCOUNT_APPROVED_SUBJECT = "Your Citely account is approved"
_ACCOUNT_REASON = "You're receiving this because you created a Citely account on citely.example."


def _signin_url() -> str:
    return APP_PUBLIC_URL.rstrip("/") + "/signin/"


def account_approved_plaintext(*, email: str) -> str:
    return (
        "Good news: your Citely account is approved.\n\n"
        f"Sign in: {_signin_url()}\n\nwith {email}.\n\n"
        "Upload a document, ask a question, and every answer shows the exact passage it came from."
        + _plain_footer(_ACCOUNT_REASON)
    )


def account_approved_html(*, email: str) -> str:
    body = f"""
<tr><td>
  {_eyebrow("Account approved")}
  {_h1("You're in.")}
  {_p("Your Citely account is approved. Upload a document, ask a question, and every answer shows the exact passage it came from.", gap=24)}
</td></tr>
<tr><td style="padding:0 0 26px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="c-tint" bgcolor="{TINT}" style="background-color:{TINT}; border-left:6px solid {RED}; padding:14px 20px;">
      <p class="c-muted" style="margin:0 0 2px; font-family:{FONT}; font-size:11px; font-weight:800; letter-spacing:1.6px; text-transform:uppercase; color:{MUTED};">Sign in with</p>
      <p class="c-ink" style="margin:0; font-family:{FONT}; font-size:17px; font-weight:800; color:{INK}; word-break:break-all;">{_e(email)}</p>
    </td>
  </tr></table>
</td></tr>
<tr><td style="padding:0 0 10px;">
  {_button(_signin_url(), "Sign in to Citely")}
  {_link_fallback(_signin_url())}
</td></tr>"""
    return _layout(title=ACCOUNT_APPROVED_SUBJECT, preheader="Your account is approved. Sign in and ask your first question.",
                   section="Welcome", body=body, reason=_e(_ACCOUNT_REASON))


ACCOUNT_DECLINED_SUBJECT = "About your Citely account"


def _demo_url() -> str:
    return APP_PUBLIC_URL.rstrip("/") + "/demo.html"


def account_declined_plaintext(*, email: str) -> str:
    return (
        "Thank you for your interest in Citely.\n\n"
        f"We weren't able to approve the account for {email} this time. Citely is in a limited preview, "
        "and we're opening it to more people step by step.\n\n"
        f"You can still try the interactive demo, with sample files, any time:\n{_demo_url()}\n\n"
        "If you think this was a mistake, just reply to this email."
        + _plain_footer(_ACCOUNT_REASON)
    )


def account_declined_html(*, email: str) -> str:
    body = f"""
<tr><td>
  {_eyebrow("Your account")}
  {_h1("Thank you for your interest.")}
  {_p(f"We weren't able to approve the account for <strong class='c-ink' style='color:{INK};'>{_e(email)}</strong> this time. Citely is in a limited preview, and we're opening it to more people step by step.", gap=18)}
  {_p("You can still try the interactive demo, with sample files, any time.", gap=26)}
</td></tr>
<tr><td style="padding:0 0 30px;">
  {_button(_demo_url(), "Try the demo")}
</td></tr>
{_note("Think this was a mistake?", "Just reply to this email and we'll take another look.")}"""
    return _layout(title=ACCOUNT_DECLINED_SUBJECT, preheader="About your Citely account, and how to try the demo.",
                   section="Your account", body=body, reason=_e(_ACCOUNT_REASON))
