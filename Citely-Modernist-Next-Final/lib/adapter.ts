import * as api from '@/services/api';
import { AUTH_CALLBACK_URL, GITHUB_CLIENT_ID, GOOGLE_CLIENT_ID, STORAGE_KEYS } from '@/config';
import { siteConfig } from './config';
import type { AccountStatus, AuthTokenResponse } from '@/types/api';
import { ensureAwake, markServerReady } from './wake';
import { clearSnapshots } from './snapshot.mjs';
export type Session = { user: { id: string; email: string; status?: AccountStatus }; acceptedPrivacyVersion?: string };
/** A sign-in that still needs the code emailed to the account's address. */
export type CodeChallenge = { codeRequired: true; ticket: string; sentTo: string; email: string };
export type SignInResult = Session | CodeChallenge;
export const needsCode = (r: SignInResult): r is CodeChallenge => 'codeRequired' in r;
/** Where a signed-in account belongs: the workspace, or the review screen. */
export const landingFor = (s: Session) => (s.user.status && s.user.status !== 'approved' ? '/review' : '/home');

// Browsers trusted to skip the sign-in code, as {email: token}. Kept on this
// device only; the server stores a hash and forgets it after 30 days, on a
// password reset, a suspension, or "sign out everywhere".
const trustKey = (email: string) => email.trim().toLowerCase();
function trustedMap(): Record<string, string> {
 try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.trustedBrowsers) || '{}') || {}; } catch { return {}; }
}
function saveTrusted(email: string, token: string | null) {
 try {
  const map = trustedMap();
  if (token) map[trustKey(email)] = token; else delete map[trustKey(email)];
  localStorage.setItem(STORAGE_KEYS.trustedBrowsers, JSON.stringify(map));
 } catch { /* private browsing: the code is simply asked again */ }
}
const trustedFor = (email: string) => trustedMap()[trustKey(email)];
const allTrusted = () => Object.values(trustedMap()).slice(0, 10);
/** "Chrome on macOS": how this browser is listed under Trusted browsers. */
function browserLabel(): string {
 const ua = navigator.userAgent;
 const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
 const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
 return os ? `${browser} on ${os}` : browser;
}
export type Connectivity = 'online' | 'waking' | 'degraded' | 'offline';
export async function session(): Promise<Session | null> {
 try {
  const token = api.getToken();
  const user = JSON.parse(localStorage.getItem(STORAGE_KEYS.user) || 'null');
  if (!token || !user || JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).exp * 1000 <= Date.now()) return null;
  return { user, acceptedPrivacyVersion: user.privacyPolicyAccepted ? siteConfig.privacyVersion : undefined };
 } catch { return null; }
}
function store(payload: AuthTokenResponse): Session {
 if (!payload.access_token) throw Error('Sign-in did not complete. Please try again.');
 const user = { id: payload.user_id, email: payload.email, status: payload.status, privacyPolicyAccepted: payload.privacy_policy_accepted };
 localStorage.setItem(STORAGE_KEYS.jwt, payload.access_token);
 localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
 if (payload.trusted_browser) saveTrusted(payload.email, payload.trusted_browser);
 return { user, acceptedPrivacyVersion: user.privacyPolicyAccepted ? siteConfig.privacyVersion : undefined };
}
function finish(payload: AuthTokenResponse): SignInResult {
 if (payload.code_required && payload.ticket)
  return { codeRequired: true, ticket: payload.ticket, sentTo: payload.sent_to || payload.email, email: payload.email };
 return store(payload);
}
function endSession() {
 localStorage.removeItem(STORAGE_KEYS.jwt); localStorage.removeItem(STORAGE_KEYS.user); clearSnapshots();
 window.dispatchEvent(new Event('rag:signed-out'));
}
export const adapter = {
 session,
 /** Reports `online | waking | degraded | offline` through `report`, which may
  *  be called twice: "waking" straight away, then the outcome of the wake. */
 connectivity: async (report: (state: Connectivity) => void) => {
  try {
   const health = await api.getHealth();
   markServerReady();
   return report(health.readiness === 'degraded' ? 'degraded' : 'online');
  } catch {
   // No answer within the warm budget: a scale-to-zero replica is most likely
   // starting. Say so, and only call it offline once a bounded wake gives up.
   report('waking');
  }
  try { await ensureAwake(); report('online'); }
  catch { report('offline'); }
 },
 signIn: async (email: string, password: string) => finish(await api.signInEmail(email, password, trustedFor(email))),
 /** The emailed sign-in code; `trust` keeps this browser trusted for 30 days. */
 enterCode: async (ticket: string, code: string, trust: boolean) => store(await api.enterLoginCode(ticket, code, trust, browserLabel())),
 resendLoginCode: async (ticket: string) => api.resendLoginCode(ticket),
 /** Signs this account out on every device and forgets every trusted browser. */
 signOutEverywhere: async () => {
  const user = JSON.parse(localStorage.getItem(STORAGE_KEYS.user) || 'null');
  await api.signOutEverywhere();          // the server ends presence on every device itself
  if (user?.email) saveTrusted(user.email, null);
  endSession();
 },
 signUp: async (email: string, password: string, turnstileToken?: string) => { await api.signUpEmail(email.trim(),password,turnstileToken); },
 /** Every sign-out on this device (workspace, site header, review page,
  *  privacy prompt) comes here: the admin console shows it offline at once. */
 signOut: async () => { api.sendSignedOut(); endSession(); },
 oauthStart: async (provider: 'google' | 'github') => {
  const clientId = provider === 'google' ? GOOGLE_CLIENT_ID : GITHUB_CLIENT_ID;
  if (!clientId) throw Error(`${provider} authentication is not configured.`);
  const state = provider + ':' + crypto.randomUUID();
  sessionStorage.setItem(STORAGE_KEYS.oauthState,state);
  const url = new URL(provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({client_id:clientId,redirect_uri:AUTH_CALLBACK_URL,state,scope:provider === 'google' ? 'openid email profile' : 'user:email',response_type:'code'}).toString();
  return url.href;
 },
 oauthCallback: async (params: URLSearchParams) => {
  if (params.get('error')) throw Error(params.get('error_description') || params.get('error')!);
  const state = params.get('state'), stored = sessionStorage.getItem(STORAGE_KEYS.oauthState), code = params.get('code');
  sessionStorage.removeItem(STORAGE_KEYS.oauthState);
  if (!stored || state !== stored || !code) throw Error('Sign-in state did not match. Please start again.');
  return finish(await (state.startsWith('google:') ? api.signInWithGoogle(code, AUTH_CALLBACK_URL, allTrusted()) : api.signInWithGithub(code, allTrusted())));
 },
 verifyEmail: async (email: string, code: string) => {
  const result = store(await api.verifyOtp(email,code));
  return result;
 },
 resendCode: async (email: string) => { await api.resendOtp(email); },
 forgotPassword: (email: string) => api.requestPasswordReset(email),
 resetPassword: async (email: string, token: string, password: string) => { await api.resetPassword(email,token,password); },
 acceptPrivacy: async (_version: string) => {
  await api.acceptPrivacyPolicy();
  const user = JSON.parse(localStorage.getItem(STORAGE_KEYS.user) || 'null');
  if (!user) throw Error('Please sign in again.');
  localStorage.setItem(STORAGE_KEYS.user,JSON.stringify({...user,privacyPolicyAccepted:true}));
  return {user,acceptedPrivacyVersion:siteConfig.privacyVersion};
 },
};
