// The sign-up form's live password checklist. It mirrors the server's rules
// (APP/access_control.password_problem) so people see what to fix while they
// type; the server is still the one that decides, and it also rejects the
// 10,000 most common passwords, which are not shipped to the browser.

const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

function hasRun(text, length = 4) {
  if (new RegExp(`(.)\\1{${length - 1},}`).test(text)) return true;
  for (const seq of SEQUENCES)
    for (const s of [seq, [...seq].reverse().join('')])
      for (let i = 0; i + length <= s.length; i++) if (text.includes(s.slice(i, i + length))) return true;
  return false;
}

/** [{id, label, ok}] for the checklist, in display order. */
export function passwordChecks(password, email = '') {
  const lower = password.toLowerCase();
  const local = (email.trim().toLowerCase().split('@')[0] || '');
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(password)).length;
  return [
    { id: 'length', label: 'At least 12 characters', ok: password.length >= 12 && password.length <= 128 },
    { id: 'mix', label: 'Three of: lowercase, uppercase, numbers, symbols', ok: kinds >= 3 },
    { id: 'email', label: "Doesn't contain your email", ok: !(local.length >= 4 && lower.includes(local)) },
    { id: 'runs', label: "No runs like 'aaaa', '1234' or 'qwer'", ok: password.length > 0 && !hasRun(lower) },
  ];
}

/** 'weak' | 'fair' | 'strong' for the meter. */
export function passwordStrength(password, email = '') {
  const checks = passwordChecks(password, email);
  if (!checks.every(c => c.ok)) return 'weak';
  return password.length >= 16 ? 'strong' : 'fair';
}
