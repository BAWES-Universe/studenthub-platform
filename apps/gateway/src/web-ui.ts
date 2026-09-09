import type { ServerResponse } from "node:http";
import type { BrowserResponse, LoginApplication } from "@studenthub/login-contract";

/** Browser-only projection; the JSON login contract stays unchanged. */
export interface BrowserLoginApplication extends LoginApplication {
  readonly web?: {
    readonly origin: string;
    readonly returnTo?: string;
    readProfile(personId: string): Promise<{
      readonly id: string;
      readonly displayName?: string;
      readonly email?: string;
    } | undefined>;
  };
}

/** HTML is opt-in. Missing, wildcard and JSON-preferred Accept keep the API. */
export function wantsHtml(accept: string | undefined): boolean {
  const qualities = new Map<string, number>();
  for (const part of accept?.toLowerCase().split(",") ?? []) {
    const [mime, ...parameters] = part.trim().split(";");
    const q = parameters.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    if (mime && Number.isFinite(quality) && quality >= 0 && quality <= 1) {
      qualities.set(mime.trim(), Math.max(qualities.get(mime.trim()) ?? 0, quality));
    }
  }
  const html = qualities.get("text/html") ?? 0;
  return html > 0 && html > (qualities.get("application/json") ?? 0);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "vary": "Accept",
};

export function writeHtml(response: ServerResponse, status: number, html: string,
  headers: Readonly<Record<string, string>> = {}): void {
  response.writeHead(status, { ...headers, ...securityHeaders, "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

const brand = `<a class="brand" href="/" aria-label="StudentHub home"><span class="brand-mark" aria-hidden="true">s</span>studenthub<span class="brand-dot" aria-hidden="true">.</span></a>`;

function document(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)} · StudentHub</title><link rel="stylesheet" href="/assets/studenthub.css"></head><body><a class="skip" href="#main">Skip to content</a>${content}</body></html>`;
}

function signIn(login?: BrowserLoginApplication): string {
  const returnTo = login?.web?.returnTo;
  if (!returnTo) return `<div class="notice" role="status"><strong>Sign-in is temporarily unavailable</strong><p>Please try again later.</p></div>`;
  // This URL is supplied by validated runtime configuration, never Host or a query.
  return `<a class="button primary" href="/login/universe?return_to=${escapeHtml(encodeURIComponent(returnTo))}">Continue with Universe <span aria-hidden="true">↗</span></a>`;
}

export function renderLanding(login?: BrowserLoginApplication): string {
  return document("Welcome", `<div class="entry"><header class="entry-header">${brand}<span class="eyebrow">YOUR STUDENTHUB</span></header><main id="main" class="entry-grid"><section class="intro"><div class="eyebrow">ONE ACCOUNT. YOUR NEXT CHAPTER.</div><h1>Good to<br>have you here<span class="accent">.</span></h1><p class="intro-copy">Your profile. Your possibilities.<br>One place to be yourself.</p><div class="intro-foot"><span class="line"></span><span>Connected through BAWES Universe</span></div></section><section class="sign-in" aria-labelledby="welcome"><div class="section-number" aria-hidden="true">01 / WELCOME</div><h2 id="welcome">Make yourself<br>at home.</h2><p>Use your Universe account to open your StudentHub profile.</p>${signIn(login)}<p class="small">Already signed in?</p><a class="text-link" href="/profile">Open my profile <span aria-hidden="true">→</span></a><div class="sign-in-note"><strong>One person. One account.</strong><p>You don’t need a separate login for each role.</p></div></section></main><footer class="entry-footer"><span>StudentHub · Connected by Universe</span><span>Profile access is read-only for now.</span></footer></div>`);
}

export function renderError(status: number, login?: BrowserLoginApplication): string {
  const [title, message] = status === 401
    ? ["Let’s get you signed in.", "Sign in to view your profile. If you were already here, your session may have ended."]
    : status === 503
      ? ["We couldn’t load that just now.", "Your profile hasn’t been changed. Please try again in a moment."]
      : status === 404
        ? ["This profile isn’t available.", "You can only open a profile you have access to."]
        : ["We couldn’t complete that request.", "Start again from StudentHub. Your private account details haven’t been displayed."];
  return document("Account access", `<header class="topbar">${brand}<a class="text-link" href="/">Back to StudentHub</a></header><main id="main" class="error-page"><div class="eyebrow">STUDENTHUB ACCOUNT</div><h1>${title}</h1><p>${message}</p>${status === 401 ? signIn(login) : '<a class="button primary" href="/profile">Try my profile again <span aria-hidden="true">→</span></a>'}</main>`);
}

export async function profileDocument(result: BrowserResponse, login: BrowserLoginApplication): Promise<{ status: number; html: string }> {
  if (result.status !== 200) return { status: result.status, html: renderError(result.status, login) };
  const personId = result.body?.personId;
  if (typeof personId !== "string" || !personId) throw new Error("invalid authorized profile");
  const profile = await login.web?.readProfile(personId);
  // A broken adapter may not substitute another principal's private fields.
  if (login.web && (!profile || profile.id !== personId)) throw new Error("profile binding mismatch");
  const name = typeof profile?.displayName === "string" && profile.displayName.trim() ? profile.displayName : undefined;
  const email = typeof profile?.email === "string" && profile.email.trim() ? profile.email : undefined;
  const initial = name ? Array.from(name.trim())[0]!.toUpperCase() : "S";
  const value = (text?: string) => text ? escapeHtml(text) : '<span class="missing">Not available yet</span>';
  return { status: 200, html: document("My profile", `<header class="topbar">${brand}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out <span aria-hidden="true">↗</span></button></form></header><div class="workspace"><aside class="sidebar"><div class="eyebrow">YOUR WORKSPACE</div><nav aria-label="Workspace"><a class="nav-item active" href="/profile" aria-current="page"><span aria-hidden="true">◉</span> My profile</a></nav><p class="sidebar-note">One Universe account.<br>Your StudentHub space.</p></aside><main id="main" class="profile-main"><div class="profile-heading"><div><div class="eyebrow">YOUR ACCOUNT</div><h1>My profile<span class="accent">.</span></h1><p>Your Universe-linked StudentHub account.</p></div><span class="badge">Read-only</span></div><section class="profile-card" aria-labelledby="profile-details"><div class="identity"><div class="avatar" aria-hidden="true">${escapeHtml(initial)}</div><div><h2 id="profile-details">${name ? escapeHtml(name) : "Your StudentHub profile"}</h2><p>Connected with Universe</p></div><span class="identity-label">PERSONAL ACCOUNT</span></div><dl class="profile-fields"><div><dt>Display name</dt><dd>${value(name)}</dd></div><div><dt>Email address</dt><dd>${value(email)}</dd></div><div class="full"><dt>StudentHub account ID</dt><dd class="account-id">${escapeHtml(personId)}</dd></div></dl><div class="privacy-note"><span class="privacy-symbol" aria-hidden="true">↳</span><p>This is your own profile. Your account details are not shared on the public welcome page.</p></div></section><section class="next-note" aria-labelledby="next-title"><div class="eyebrow">ABOUT THIS PROFILE</div><h2 id="next-title">A starting point, not your full record.</h2><p>Only details currently available in this StudentHub account are shown. Your previous applications, work history and documents aren’t available here yet.</p><p>You can view this profile, but editing isn’t enabled yet.</p></section><footer class="profile-footer">StudentHub · Connected by Universe</footer></main></div>`) };
}

export const WEB_CSS = `
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172433;background:#f7f9fc;font-synthesis:none;line-height:1.5;font-size:16px;--blue:#2256e8;--muted:#566579;--border:#dfe5ef}
*{box-sizing:border-box}body{margin:0}a{color:inherit}button{font:inherit}a,button{-webkit-tap-highlight-color:transparent}a:focus-visible,button:focus-visible{outline:3px solid #a74400;outline-offset:5px}p,h1,h2{margin:0}p{color:var(--muted)}button,a{touch-action:manipulation}.skip{position:absolute;left:1rem;top:-8rem;background:white;padding:1rem;z-index:5}.skip:focus{top:1rem}.brand{display:inline-flex;align-items:center;text-decoration:none;font-weight:800;font-size:1.6rem;letter-spacing:-.07em;white-space:nowrap}.brand-mark{display:grid;place-items:center;width:2.25rem;height:2.25rem;background:var(--blue);color:white;border-radius:.65rem;margin-right:.65rem;font-size:1.8rem;line-height:1;letter-spacing:0}.brand-dot,.accent{color:var(--blue)}.eyebrow{font-size:.75rem;letter-spacing:.12em;font-weight:750;color:#4e6075}.entry{max-width:1440px;margin:auto;padding:0 5.5vw;min-height:100svh;display:flex;flex-direction:column}.entry-header{display:flex;align-items:center;justify-content:space-between;padding:2rem 0;border-bottom:1px solid var(--border);gap:1rem}.entry-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:7vw;align-items:center;flex:1;padding:4rem 0}.intro h1{font-size:clamp(3rem,5.7vw,5.5rem);line-height:1.05;letter-spacing:-.065em;margin:1.5rem 0 1.75rem;font-weight:750}.intro-copy{font-size:1.25rem;line-height:1.7}.intro-foot{display:flex;align-items:center;gap:1rem;margin-top:3rem;font-size:.875rem;color:var(--muted)}.line{height:2px;width:2rem;background:var(--blue)}.sign-in{background:white;border:1px solid var(--border);border-radius:1.5rem;padding:clamp(1.5rem,4vw,3.5rem);box-shadow:0 18px 60px #182b4b08;max-width:33rem;width:100%}.section-number{font-family:ui-monospace,monospace;font-size:.75rem;letter-spacing:.12em;color:var(--blue);margin-bottom:2rem}.sign-in h2{font-size:2.25rem;line-height:1.15;letter-spacing:-.045em;margin-bottom:1rem}.sign-in>p{margin-bottom:1.5rem}.button{min-height:3.4rem;display:flex;justify-content:space-between;align-items:center;gap:1.5rem;padding:.95rem 1.25rem;border-radius:.65rem;text-decoration:none;font-weight:650}.primary{background:var(--blue);color:white}.primary:hover{background:#1641be}.button span{font-size:1.4rem}.sign-in .small{font-size:.875rem;margin:1.5rem 0 .2rem}.text-link{font-weight:650;font-size:.9375rem;text-underline-offset:4px}.sign-in-note{margin-top:2rem;padding-top:1.5rem;border-top:1px solid var(--border);font-size:.875rem}.sign-in-note p{margin-top:.3rem}.entry-footer{display:flex;justify-content:space-between;gap:1rem;padding:1.5rem 0;border-top:1px solid var(--border);font-size:.8125rem;color:var(--muted)}.notice{padding:1rem;border:1px solid #ccd7ea;border-radius:.65rem;background:#f7f9ff}.notice p{margin-top:.35rem}.topbar{background:white;border-bottom:1px solid var(--border);min-height:5.5rem;padding:1.4rem 4vw;display:flex;align-items:center;justify-content:space-between;gap:1.5rem}.sign-out{border:1px solid var(--border);border-radius:.6rem;background:white;padding:.65rem 1rem;min-height:2.75rem;cursor:pointer;color:#253e5a;font-size:.9375rem}.sign-out:hover{background:#f0f4fc}.workspace{max-width:1440px;margin:auto;display:grid;grid-template-columns:15rem minmax(0,1fr);min-height:calc(100svh - 5.5rem)}.sidebar{padding:2.5rem 1.75rem;border-right:1px solid var(--border);display:flex;flex-direction:column}.sidebar nav{margin-top:1.5rem}.nav-item{display:flex;align-items:center;gap:.75rem;text-decoration:none;font-weight:650;font-size:.9375rem;padding:.85rem 1rem;border-radius:.65rem}.active{background:#e8eeff;color:#1d46b8}.sidebar-note{font-size:.8125rem;line-height:1.7;margin-top:auto;padding-top:3rem}.profile-main{max-width:1050px;width:100%;padding:3rem clamp(1.25rem,5vw,5rem)}.profile-heading{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:2.25rem}.profile-heading h1{font-size:clamp(2.5rem,4vw,3.5rem);letter-spacing:-.065em;line-height:1.2;margin:.4rem 0 .6rem}.badge{font-size:.8125rem;border:1px solid #cbd5e4;border-radius:2rem;padding:.4rem .8rem;color:#475a72;white-space:nowrap;background:white}.profile-card{background:white;border:1px solid var(--border);border-radius:1rem;overflow:hidden}.identity{display:flex;gap:1rem;align-items:center;padding:2rem;border-bottom:1px solid var(--border);flex-wrap:wrap}.avatar{width:3.5rem;height:3.5rem;border-radius:1rem;display:grid;place-items:center;flex-shrink:0;background:#e9efff;color:#234ebd;font-size:1.5rem;font-weight:750}.identity h2{font-size:1.3rem;letter-spacing:-.025em;overflow-wrap:anywhere}.identity p{font-size:.875rem;margin-top:.25rem}.identity-label{font-size:.75rem;letter-spacing:.07em;color:#57677b;margin-left:auto}.profile-fields{display:grid;grid-template-columns:1fr 1fr;margin:0;padding:0 2rem}.profile-fields>div{padding:1.6rem 0;border-bottom:1px solid var(--border);min-width:0}.profile-fields>div:first-child{padding-right:1rem}.profile-fields .full{grid-column:1/-1;border-bottom:0}dt{font-size:.875rem;color:var(--muted);margin-bottom:.45rem}dd{margin:0;font-size:1rem;font-weight:550;overflow-wrap:anywhere}.missing{font-weight:400;color:#66758a}.account-id{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.875rem}.privacy-note{display:flex;align-items:flex-start;gap:1rem;padding:1.25rem 2rem;background:#f5f8ff;font-size:.875rem}.privacy-symbol{color:var(--blue);font-size:1.4rem;line-height:1}.next-note{margin-top:2rem;padding:1.5rem 0}.next-note h2{font-size:1.125rem;letter-spacing:-.015em;margin:.65rem 0}.next-note p{font-size:.9375rem;margin-top:.5rem;max-width:42rem;line-height:1.7}.profile-footer{margin-top:2rem;padding-top:1.5rem;border-top:1px solid var(--border);font-size:.8125rem;color:var(--muted)}.error-page{max-width:44rem;margin:6rem auto;padding:0 1.5rem}.error-page h1{font-size:clamp(2rem,5vw,3.5rem);letter-spacing:-.05em;line-height:1.15;margin:1rem 0}.error-page p{line-height:1.7}.error-page .button,.error-page .notice{margin-top:2rem;max-width:26rem}
@media(max-width:800px){.entry-grid{gap:2.5rem;grid-template-columns:1fr;padding:2.5rem 0}.intro h1{font-size:3.5rem}.intro-foot{margin-top:1.5rem}.sign-in{max-width:none}.entry-footer{flex-direction:column;gap:.4rem}.workspace{grid-template-columns:1fr}.sidebar{padding:1rem 1.25rem;border-right:0;border-bottom:1px solid var(--border)}.sidebar>.eyebrow,.sidebar-note{display:none}.sidebar nav{margin:0}.nav-item{display:inline-flex}.profile-main{padding-top:2rem}.identity{padding:1.5rem}.identity-label{width:100%;margin-left:4.5rem}.profile-fields{padding:0 1.5rem}.privacy-note{padding:1.25rem 1.5rem}.profile-heading{align-items:flex-start}.badge{margin-top:.5rem}}
@media(max-width:480px){.entry-header>.eyebrow{display:none}.intro h1{font-size:3rem}.topbar{padding:1rem}.brand{font-size:1.4rem}.profile-fields{grid-template-columns:1fr}.profile-fields>div:first-child{padding-right:0}.profile-heading{flex-wrap:wrap}.identity-label{margin-left:0}.sign-out span{display:none}.error-page{margin-top:3rem}}
.topbar{flex-wrap:wrap}body{overflow-wrap:anywhere}.entry-grid>*{min-width:0}
@media(prefers-reduced-motion:no-preference){.button,.sign-out{transition:background-color .15s ease}}
`;
