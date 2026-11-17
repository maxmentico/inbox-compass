// Server-rendered pages: forms only, plus one static script on the digest page (the done switch, in
// switch-script.ts), which the CSP allows by its hash. No other script can run.

import { SWITCH_SCRIPT, SWITCH_SCRIPT_HASH } from "./switch-script";

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const SECURITY_HEADERS: Record<string, string> = {
	"Content-Type": "text/html; charset=utf-8",
	"Content-Security-Policy":
		`default-src 'none'; script-src '${SWITCH_SCRIPT_HASH}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'`,
	"X-Frame-Options": "DENY",
	// Not "no-referrer": under it browsers send `Origin: null` on same-site form POSTs, which
	// checkCsrf rejects. "same-origin" still sends nothing to other sites.
	"Referrer-Policy": "same-origin",
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
};

// The design is in docs/design-handover/design/ (app.css, mockups/). Light tokens on :root, dark ones
// under the media query; body is the size container, so layout switches with `@container oi`.
const CSS = `
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#111112;--fg-2:#3b3b3f;--muted:#66666c;--faint:#a9a9ae;--line:#e7e7e4;--line-2:#d4d4d0;--edge:#85858b;--sunk:#f2f2f0;--raised:#ffffff;
--accent:#111112;--accent-fg:#fbfbfa;--accent-hover:#2e2e31;--high:#b42318;--high-fg:#ffffff;--high-hover:#9a1d13;--med:#a35f00;--low:#5b6876;--warn:#8f5300;--warn-bg:#fbf3e3;--warn-line:#efdfc0}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0e;--fg:#ececed;--fg-2:#c4c4c8;--muted:#909097;--faint:#55555b;--line:#232326;--line-2:#36363b;--edge:#6e6e75;--sunk:#161618;--raised:#19191b;
--accent:#ececed;--accent-fg:#0d0d0e;--accent-hover:#d2d2d5;--high:#ff8a78;--high-fg:#0d0d0e;--high-hover:#ffa699;--med:#e9b04f;--low:#97a3b0;--warn:#e9b04f;--warn-bg:#1e1910;--warn-line:#3a301b}}
html{background:var(--bg)}
body{margin:0;container:oi/inline-size;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;min-height:100vh}
*{box-sizing:border-box}
:where(p,h1,h2,ul,ol,dl,dd){margin:0}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--fg);outline-offset:2px;border-radius:4px}
svg{flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.mono,time,code,.n{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-variant-numeric:tabular-nums;letter-spacing:0}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.bar{border-bottom:1px solid var(--line)}
.bar-in{max-width:752px;margin:0 auto;padding:0 16px;height:56px;display:flex;align-items:center;gap:4px}
.mark{font-size:15px;font-weight:600;letter-spacing:-.01em;margin-right:auto}
a.mark:hover{text-decoration:none}
.bar form{display:flex;align-items:center;gap:4px}
.who{font-size:13px;color:var(--muted);margin:0 8px}
@container oi (max-width:519px){.who{display:none}}
.wrap{max-width:752px;margin:0 auto;padding:32px 16px 96px}
@container oi (min-width:640px){.wrap{padding-top:56px}}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px 24px;flex-wrap:wrap}
.eyebrow{color:var(--muted);margin-bottom:8px}
h1{font-size:26px;line-height:32px;font-weight:400;letter-spacing:-.022em}
@container oi (min-width:640px){h1{font-size:32px;line-height:38px}}
.sub{font-size:14px;line-height:20px;color:var(--muted);margin-top:6px}
.flash{display:flex;align-items:center;gap:6px;font-size:13px;line-height:18px;color:var(--fg-2);margin-top:20px}
.flash.warn>svg{color:var(--warn)}
/* the copy icon on the To action header: 36 px target (44 under 640 px), the status beside it */
.copy{display:inline-grid;place-items:center;flex:none;width:36px;height:36px;margin:-6px -8px -6px auto;border-radius:6px;color:var(--muted)}
.copy:hover{background:var(--sunk);color:var(--fg);text-decoration:none}
.copy:focus-visible{outline:2px solid var(--fg);outline-offset:0}
@container oi (max-width:639px){.copy{width:44px;height:44px;margin-top:-10px;margin-bottom:-10px}}
.copy-msg{margin-left:auto;font-size:13px;font-weight:400;color:var(--muted)}
.copy-msg:empty{display:none}
.copy-msg:not(:empty)~.copy{margin-left:8px}
/* beside the copy icon: where (not) to paste. Hidden while the copy status shows; its own line on phones */
.copy-note{margin-left:auto;padding-left:16px;font-size:12px;line-height:16px;font-weight:400;color:var(--muted);text-align:right}
.copy-note+.copy{margin-left:4px}
.copy-msg:not(:empty)~.copy-note{display:none}
@container oi (max-width:639px){.sec-h:has(>.copy-note){flex-wrap:wrap}.copy-note{order:1;flex-basis:100%;margin:0;padding:0 0 10px;text-align:left}.copy-note+.copy{margin-left:auto}}
.copy-text:not(.vh){display:block;width:100%;height:160px;margin-top:12px}
.flash-a{margin-left:4px;font-size:13px;color:var(--muted)}
.flash-a:hover{color:var(--fg)}
[hidden]{display:none!important}
.sw-msg{margin-bottom:4px;font-size:13px;line-height:18px;color:var(--high)}
.sw-msg.warn{color:var(--warn)}
button,.btn{font:inherit;font-size:14px;font-weight:500;line-height:20px;min-height:36px;padding:7px 14px;border-radius:6px;border:1px solid var(--line-2);background:var(--raised);color:var(--fg);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;-webkit-user-select:none;user-select:none;transition:background-color .12s,border-color .12s}
button:hover,.btn:hover{background:var(--sunk);border-color:var(--edge);text-decoration:none}
button:active,.btn:active{background:var(--line)}
.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.primary:active{background:var(--accent-hover)}
.quiet[aria-current]{color:var(--fg);font-weight:500}
.quiet{background:transparent;border-color:transparent;color:var(--fg-2);font-weight:400}
.quiet:hover{background:var(--sunk);border-color:transparent;color:var(--fg)}
.sm{min-height:32px;padding:5px 10px;font-size:13px;line-height:18px}
.danger{background:var(--high);border-color:var(--high);color:var(--high-fg)}
.danger:hover{background:var(--high-hover);border-color:var(--high-hover)}
@container oi (max-width:639px){button,.btn{min-height:44px}}
.sec{margin-top:40px}
@container oi (min-width:640px){.sec{margin-top:48px}}
.sec-h{display:flex;align-items:center;gap:8px;min-height:44px;border-bottom:1px solid var(--line);font-size:14px;line-height:20px;font-weight:600;letter-spacing:-.005em}
.sec.lead>.sec-h{border-bottom-color:var(--fg)}
.n{font-weight:400;color:var(--muted)}
.fold>summary{list-style:none;cursor:pointer}
.fold>summary::-webkit-details-marker,.why>summary::-webkit-details-marker{display:none}
.fold>summary .plus{margin-left:auto;color:var(--muted);transition:transform .15s}
.fold[open]>summary .plus{transform:rotate(45deg)}
.fold>summary:hover .plus{color:var(--fg)}
.fold.alert>summary{color:var(--warn)}
.sec+.sec.fold,.fold+.fold{margin-top:0}
.items{list-style:none;padding:0}
.item{position:relative;display:grid;grid-template-columns:36px minmax(0,1fr) auto;column-gap:12px;padding:16px 0;border-bottom:1px solid var(--line);scroll-margin-top:24px}
.items>.item:last-child{border-bottom:0}
/* the column left of an item: full row height (and into the gap), so the row's Gmail link never covers it */
.side{grid-column:1;grid-row:1/9;align-self:stretch;position:relative;z-index:1;margin:-16px -8px -16px 0;padding-top:16px}
.lite .side,.thread-in .side{margin:-12px -8px -12px 0;padding-top:12px}
/* the done switch: squared track (radius-sm), knob left when open; done is quieter (sunk, muted, a check) */
.switch{position:relative;display:block;width:44px;height:36px;min-height:0;margin:-8px 0 0 -4px;padding:0;border:0;border-radius:4px;background:transparent}
.switch:hover,.switch:active{background:transparent}
.switch::before{content:"";position:absolute;left:6px;top:50%;width:32px;height:18px;margin-top:-9px;box-sizing:border-box;border:1.5px solid var(--edge);border-radius:4px;background:var(--raised);transition:background-color .15s,border-color .15s}
.switch::after{content:"";position:absolute;left:10px;top:50%;width:10px;height:10px;margin-top:-5px;border-radius:2px;background:var(--fg-2);transition:transform .15s,background-color .15s}
.switch svg{display:none;position:absolute;left:11px;top:50%;margin-top:-5px;color:var(--muted);stroke-width:2}
.switch:hover::before{border-color:var(--fg)}
.switch[aria-checked=true]::before{background:var(--sunk);border-color:var(--line-2)}
.switch[aria-checked=true]::after{background:var(--muted);transform:translateX(14px)}
.switch[aria-checked=true] svg{display:block}
.switch[aria-checked=true]:hover::before{border-color:var(--edge)}
.switch:focus-visible{outline:0}
.switch:focus-visible::before{outline:2px solid var(--fg);outline-offset:2px}
@container oi (max-width:639px){.switch{height:44px;min-height:0;margin-top:-12px}}
.done-mark{display:flex;justify-content:center;width:36px;padding-top:4px;color:var(--muted)}
.hint{padding-top:12px}
@media (prefers-reduced-motion:reduce){.switch::before,.switch::after{transition:none}}
.body{grid-column:2;min-width:0}
.when{grid-column:3;grid-row:1;color:var(--muted);padding-top:3px;white-space:nowrap;text-align:right}
.act{font-size:16px;line-height:22px;font-weight:600;letter-spacing:-.011em;color:var(--fg);text-wrap:pretty}
.is-done>.body>.act,.lite>.is-done>.body>.mail>summary .subj{text-decoration:line-through;text-decoration-thickness:1px}
.is-done>.body>.act,.is-done>.body>.mail>summary>.src,.is-done>.body>.mail>summary .from,.is-done>.when{color:var(--muted)}
.is-done>.body>.sig{filter:grayscale(1)}
/* the subject covers the row, so a click anywhere opens the email in place; the controls and the open email sit above it */
.mail>summary{display:block;list-style:none;cursor:pointer}
.mail>summary::-webkit-details-marker{display:none}
.subj::after{content:"";position:absolute;inset:0}
.why>summary,.why-in,.thread>summary,.thread-in,.mail-in,.gm{position:relative;z-index:1}
.item:has(>.body>.mail:not([open])>summary:hover){background:var(--sunk);box-shadow:-12px 0 0 var(--sunk),12px 0 0 var(--sunk)}
.thread-in .item:has(>.body>.mail:not([open])>summary:hover){background:var(--bg);box-shadow:-14px 0 0 var(--bg),14px 0 0 var(--bg)}
.mail>summary:hover .subj{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.lite>.is-done>.body>.mail>summary:hover .subj{text-decoration-line:underline line-through}
.sig{display:flex;flex-wrap:wrap;align-items:center;row-gap:2px;margin-top:4px;font-size:13px;line-height:18px;color:var(--muted)}
.sig>:not(:last-child)::after{content:"·";margin:0 7px;font-weight:400;color:var(--faint)}
.badge{display:inline-flex;align-items:center}
.badge.u-high,.badge.u-medium,.badge.u-low{text-transform:capitalize;font-weight:500}
.badge.u-high::before,.badge.u-medium::before,.badge.u-low::before{content:"";width:11px;height:10px;margin-right:6px;
background:linear-gradient(var(--b1),var(--b1)) 0 100%/3px 4px no-repeat,linear-gradient(var(--b2),var(--b2)) 4px 100%/3px 7px no-repeat,linear-gradient(var(--b3),var(--b3)) 8px 100%/3px 10px no-repeat}
.u-high{color:var(--high);--b1:var(--high);--b2:var(--high);--b3:var(--high)}
.u-medium{color:var(--fg-2);--b1:var(--med);--b2:var(--med);--b3:var(--line-2)}
.u-low{color:var(--muted);--b1:var(--low);--b2:var(--line-2);--b3:var(--line-2)}
.due{color:var(--fg-2)}
.due.late{color:var(--high);font-weight:500}
.flag{color:var(--warn);font-weight:500}
.est{color:var(--fg-2);font-weight:500}
.mbox{white-space:nowrap;color:var(--muted)}
.src{display:block;margin-top:8px;font-size:14px;line-height:20px;color:var(--fg-2);overflow-wrap:anywhere}
.src .from{font-weight:500;color:var(--fg)}
.src .from::after{content:"·";margin:0 7px;font-weight:400;color:var(--faint)}
.from .addr{font-weight:400;color:var(--muted)}
.subj svg{display:inline;vertical-align:-1px;margin-left:4px;color:var(--muted);transition:transform .15s}
.mail[open]>summary .subj svg{transform:rotate(90deg)}
.sum{display:block;margin-top:2px;font-size:14px;line-height:20px;color:var(--muted);overflow-wrap:anywhere}
/* the open email: headers, what they wrote (plain text, as stored), then Gmail */
.mail-in{margin-top:8px;padding:12px 14px 14px;background:var(--sunk);border-radius:10px;font-size:13px;line-height:18px;cursor:auto}
.thread-in .mail-in{background:var(--bg)}
.mail-in .facts{grid-template-columns:64px minmax(0,1fr)}
.mail-text{max-width:68ch;margin-top:12px;padding-top:12px;border-top:1px solid var(--line);font-size:14px;line-height:22px;color:var(--fg);white-space:pre-wrap;overflow-wrap:anywhere}
.thread-in .mail-text{border-top-color:var(--line-2)}
.mail-none,.mail-cut{margin-top:12px}
.mail-go{margin-top:12px}
.mail-go svg,.gm svg{display:inline;vertical-align:-1px;margin-left:4px;color:var(--muted)}
.gm{color:var(--muted);white-space:nowrap}
.gm:hover{color:var(--fg)}
@container oi (max-width:639px){.gm{display:inline-block;padding:13px 8px;margin:-13px -8px}.mail-in{width:calc(100cqw - 32px);margin-left:-48px;padding:12px}.thread-in .mail-in{width:auto}.mail-in .facts{grid-template-columns:64px minmax(0,1fr);gap:6px 10px}.mail-in .facts dd+dt{margin-top:0}}
.lite .item{padding:12px 0}
.lite .src{margin-top:0}
.lite .sig{margin-top:2px}
.why{margin-top:6px}
.why>summary,.thread>summary{display:inline-flex;align-items:center;gap:4px;min-height:32px;font-size:13px;color:var(--muted);cursor:pointer;list-style:none}
@container oi (max-width:639px){.why>summary,.thread>summary{min-height:44px}}
.why>summary:hover,.thread>summary:hover,.why[open]>summary,.thread[open]>summary{color:var(--fg)}
.why>summary svg,.thread>summary svg{transition:transform .15s}
.why[open]>summary svg,.thread[open]>summary svg{transform:rotate(90deg)}
.why-in{margin-top:2px;padding:12px 14px;background:var(--sunk);border-radius:10px;font-size:13px;line-height:18px}
.facts{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px 12px}
.facts dt{color:var(--muted)}
.facts dd{color:var(--fg-2);overflow-wrap:anywhere}
.senders{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.thread{margin-top:2px}
.thread-in{margin-top:2px;padding:0 14px;background:var(--sunk);border-radius:10px}
.thread-in .item{padding:12px 0}
.thread-in .act{font-size:14px;line-height:20px;font-weight:500}
.thread-in .why-in{background:var(--bg)}
.runinfo{margin-top:32px;color:var(--muted);overflow-wrap:anywhere;line-height:18px}
.tools{margin-top:72px}
.tools .sec-h{color:var(--fg-2)}
.tools>.sec:first-child{margin-top:0}
.pad{padding-top:16px}
.note{font-size:13px;line-height:18px;color:var(--muted)}
.rows{list-style:none;padding:0}
.mrow{display:flex;align-items:center;gap:4px 16px;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid var(--line)}
.mrow>div{flex:1 1 200px;min-width:0}
.alias{font-size:15px;font-weight:600}
.mrow .note{overflow-wrap:anywhere}
@container oi (max-width:639px){.mrow{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:16px}.mrow>.btn{grid-column:2;grid-row:1/3;align-self:center}}
.fields{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:16px}
input[type=text],input[type=number],select,textarea{font:inherit;font-size:15px;height:36px;padding:0 10px;border:1px solid var(--edge);border-radius:6px;background:var(--raised);color:var(--fg);min-width:0}
textarea{display:block;width:100%;height:auto;min-height:132px;padding:10px 12px;font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:20px;resize:vertical}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline-offset:0;border-color:var(--fg)}
.num{width:88px;flex:none}
input[type=text]{flex:1 1 180px}
@container oi (max-width:639px){input[type=text],input[type=number],select{height:44px;font-size:16px}textarea{font-size:16px;line-height:22px}}
input::placeholder{color:var(--muted)}
.check{display:inline-flex;align-items:center;gap:8px;min-height:36px;font-size:14px;color:var(--fg-2);cursor:pointer}
.check input{width:16px;height:16px;margin:0;accent-color:var(--accent)}
.runs{display:flex;flex-wrap:wrap;gap:4px 20px;padding-top:12px}
.runs a{color:var(--fg-2);padding:6px 0}
.runs a[aria-current]{color:var(--fg);font-weight:600}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
.fold>.sec-h{border-bottom:0;border-top:1px solid var(--line)}
.fold[open]>.sec-h{border-bottom:1px solid var(--line)}
@container oi (max-width:639px){.facts{grid-template-columns:minmax(0,1fr);gap:0}.facts dd+dt{margin-top:8px}.thread-in{margin-left:-48px}}
.calm{display:flex;gap:14px;align-items:flex-start;padding:24px 0 8px}
.calm-mark{flex:none;width:32px;height:32px;border-radius:50%;border:1.5px solid var(--line-2);display:grid;place-items:center;color:var(--fg-2)}
.calm-t{font-size:16px;line-height:22px;font-weight:600;letter-spacing:-.011em;margin-top:4px}
.calm .note{margin-top:4px;max-width:52ch}
.notices{list-style:none;padding:0 14px;margin-top:24px;background:var(--warn-bg);border-radius:10px;color:var(--fg)}
.notices+.notices{margin-top:8px}
.notice{display:flex;gap:10px;align-items:flex-start;padding:12px 0;font-size:14px;line-height:20px}
.notice+.notice{border-top:1px solid var(--warn-line)}
.notice>svg{margin-top:2px;color:var(--warn)}
.notice>div{min-width:0;overflow-wrap:anywhere}
.notice .note{margin-top:4px}
.notice a{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.notices:has(.info){background:var(--sunk)}
.notice.info>svg{color:var(--fg-2)}
.steps{list-style:none;padding:0;margin-top:40px;border-top:1px solid var(--fg)}
.steps li{display:flex;gap:14px;padding:16px 0;border-bottom:1px solid var(--line)}
.step-n{flex:none;width:24px;height:24px;border-radius:50%;border:1px solid var(--line-2);display:grid;place-items:center;color:var(--fg-2)}
.steps .done .step-n{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.step-t{font-size:15px;line-height:22px;font-weight:600;margin-top:1px}
.steps .done .step-t{color:var(--muted);font-weight:500}
.solo{max-width:512px;margin:0 auto;padding:48px 16px 96px}
@container oi (min-width:640px){.solo{padding-top:120px}}
.solo>*+*,.solo>div>*+*,.solo>form>*+*{margin-top:12px}
.solo .notices{margin-top:20px}
.lede{font-size:15px;line-height:22px;color:var(--fg-2);overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:28px}
.solo .actions{margin-top:28px}
.solo>.note{margin-top:20px}
.solo>div+div{margin-top:56px}
.solo>style+div{margin-top:0}
.solo .progress{margin-top:32px}
.progress{position:relative;height:2px;background:var(--line);overflow:hidden}
.progress::after{content:"";position:absolute;top:0;bottom:0;left:0;width:32%;background:var(--fg);animation:oi-slide 1.6s cubic-bezier(.6,0,.4,1) infinite}
@keyframes oi-slide{from{transform:translateX(-100%)}to{transform:translateX(320%)}}
@media (prefers-reduced-motion:reduce){.progress::after{animation-duration:6s}}
.solo>.jobpage{margin-top:0}
.jobpage h1{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jrows{list-style:none;padding:0;border-top:1px solid var(--fg)}
.solo .jrows{margin-top:28px}
/* every row the same height in every state: a one-line alias, a one-line detail slot, a fixed-width state */
.jrow{display:grid;grid-template-columns:24px minmax(0,1fr) 84px;column-gap:14px;align-items:start;height:71px;padding:14px 0;border-bottom:1px solid var(--line)}
.jmark{width:24px;height:24px;border-radius:50%;border:1px solid var(--line-2);display:grid;place-items:center;color:var(--fg-2)}
.is-done .jmark{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.is-running .jmark{border:1.5px solid var(--fg)}
.is-failed .jmark{border-color:var(--warn);color:var(--warn)}
.jbody{min-width:0}
.jbody .alias{line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jdet{position:relative;height:18px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jdet .jprog{display:block;height:18px;font-size:12px;line-height:16px;color:var(--muted)}
.jdet .progress{display:block;position:absolute;left:0;right:0;top:8px}
.is-todo .alias{color:var(--muted);font-weight:500}
.jstate{font-size:13px;line-height:24px;color:var(--muted);text-align:right;white-space:nowrap}
.is-running .jstate{color:var(--fg);font-weight:500}
.is-failed .jstate{color:var(--warn);font-weight:500}
.jbelow{margin-top:20px}
.jbelow>*+*{margin-top:12px}
.jcount{font-size:14px;line-height:20px;color:var(--fg-2)}
/* the countdown to the digest: a line that empties over 10 s (CSS only); still under reduced motion */
.countdown{display:block;position:relative;height:2px;background:var(--line);overflow:hidden}
.countdown::after{content:"";position:absolute;inset:0;background:var(--fg);transform-origin:left center;animation:oi-count 10s linear forwards}
@keyframes oi-count{to{transform:scaleX(0)}}
@media (prefers-reduced-motion:reduce){.countdown::after{animation:none}}
.jbelow .actions{margin-top:20px}
.jcont a,.flash a,.runinfo a{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.nw{white-space:nowrap}
time.ago{font-family:inherit;font-size:inherit;font-variant-numeric:tabular-nums;color:inherit}
.errbox{padding:12px 14px;background:var(--sunk);border-radius:10px;color:var(--fg-2);overflow-wrap:anywhere;line-height:18px}
.diag{margin-top:20px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:14px 0}
.diag summary{cursor:pointer;font-size:14px;font-weight:600;line-height:20px}
.diag .note{margin-top:8px}
.diagout{display:block;width:100%;height:240px;margin-top:12px;padding:12px 14px;resize:vertical;border:1px solid var(--line-2);border-radius:10px;background:var(--sunk);color:var(--fg-2);font-size:12px;line-height:18px;tab-size:2}
.diagout:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.diaglink{font-size:13px;text-decoration:underline;text-underline-offset:3px}
.warnword{display:flex;align-items:center;gap:6px;color:var(--warn)}
.crumb{display:inline-flex;align-items:center;gap:4px;font-size:13px;color:var(--muted);margin-bottom:12px;min-height:32px}
@container oi (max-width:639px){.crumb{min-height:44px}}
a.crumb:hover{color:var(--fg);text-decoration:none}
.settings{margin-top:32px;border-top:1px solid var(--fg)}
.set{display:grid;gap:12px 40px;padding:24px 0;border-bottom:1px solid var(--line)}
@container oi (min-width:640px){.set{grid-template-columns:232px minmax(0,1fr)}}
.set-h{font-size:14px;line-height:20px;font-weight:600;margin-bottom:4px}
.set .fields.top{margin-top:0;align-self:start}
.savebar{display:flex;justify-content:flex-end;padding:16px 0}
@container oi (max-width:639px){.savebar .primary{flex:1 1 100%}}
.doc h3{font-size:14px;line-height:20px;font-weight:600}
.doc-grid{display:grid;gap:24px 40px;padding-top:24px}
@container oi (min-width:640px){.doc-grid{grid-template-columns:1fr 1fr}}
.rules{list-style:none;padding:0;margin-top:12px;counter-reset:r}
.rules li{counter-increment:r;display:grid;grid-template-columns:24px minmax(0,1fr);padding:8px 0;border-top:1px solid var(--line);font-size:14px;line-height:20px;color:var(--fg-2)}
.rules li::before{content:counter(r);font:12px/20px ui-monospace,"SF Mono",Menlo,monospace;color:var(--muted)}
.doc .pad{padding-top:24px}
.doc .badge{font-size:13px}
.gap{margin-top:8px}
.mrow.bad .alias{color:var(--warn)}
`;

/** Small inline icons (no images under the CSP). All decorative: the text next to them carries the meaning. */
export const ICON = {
	plus: '<svg class="plus" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
	chevron: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>',
	back: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5"/></svg>',
	out: '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 3h5v5M9 3 3 9"/></svg>',
	check: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="m3 7.5 2.5 2.5L11 4.5"/></svg>',
	alert: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 14 13H2L8 2.5zM8 6.5v3M8 11.2v.1"/></svg>',
	info: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7.5V11M8 5.2v.1"/></svg>',
	copy: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>',
};

/** The top bar with only the wordmark: short pages, and pages that don't know the session. */
export const WORDMARK_BAR = '<header class="bar"><div class="bar-in"><a class="mark" href="/app">Inbox Compass</a></div></header>';

/**
 * `solo`: a short page (sign-in, run, unlink, error, partly done) in a narrow column; otherwise the
 * normal reading column. `bar`: the top bar's HTML, already escaped; none on the sign-in page.
 */
export interface Layout {
	solo?: boolean;
	bar?: string;
	/** Adds the done-switch script (the one script the CSP allows). Only on a digest page with switches. */
	script?: boolean;
}

function docStart(title: string, layout: Layout): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body>${layout.bar ?? ""}<main class="${layout.solo ? "solo" : "wrap"}">`;
}

const DOC_END = "</main></body></html>";

export function page(
	title: string,
	bodyHtml: string,
	opts: Layout & { status?: number; setCookies?: string[] } = {},
): Response {
	const headers = new Headers(SECURITY_HEADERS);
	for (const c of opts.setCookies ?? []) headers.append("Set-Cookie", c);
	const script = opts.script ? `<script>${SWITCH_SCRIPT}</script>` : "";
	return new Response(docStart(title, opts) + bodyHtml + script + DOC_END, { status: opts.status ?? 200, headers });
}

/** Enqueues a chunk for an open streamed page (mid-step ticks; does not wait on the client). */
export type StreamWriter = (chunk: string) => void;

/** CSS-only update for the in-progress mailbox row: fill width and "k of N" (integers only). */
export function stepProgressStyleTag(done: number, total: number): string {
	if (total <= 0) return "";
	const pct = Math.min(100, Math.max(0, Math.round((done / total) * 100)));
	return `<style>.is-running .progress::after{animation:none;transform:none;width:${pct}%}.is-running .jprog::before{content:"${done} of ${total}"}.is-running .progress{top:auto;bottom:0}</style>`;
}

/** Helps some runtimes flush a small streamed chunk before the mailbox step finishes. */
const STREAM_TICK_PAD = `<!--${" ".repeat(2048)}-->`;

/** Mid-step progress tick: style tag; padding on the first tick only to help some runtimes flush. */
export function stepProgressTick(done: number, total: number): string {
	const style = stepProgressStyleTag(done, total);
	return style ? style + (done === 0 ? STREAM_TICK_PAD : "") : "";
}

/**
 * Sends `firstHtml` at once, then `rest(write)`'s HTML when it resolves, in one streamed page.
 * Still script-free: the first part shows progress, ticks may arrive via `write`, the last part can end with a meta refresh.
 */
export function streamPage(
	title: string,
	firstHtml: string,
	rest: (write: StreamWriter) => Promise<string>,
	opts: Layout & { waitUntil?: (p: Promise<unknown>) => void } = {},
): Response {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const enc = new TextEncoder();
	let latestTick: string | null = null;
	let tickInFlight: Promise<void> | null = null;
	const pumpTick = () => {
		if (tickInFlight || !latestTick) return;
		const chunk = latestTick;
		latestTick = null;
		tickInFlight = writer
			.write(enc.encode(chunk))
			.catch(() => {})
			.finally(() => {
				tickInFlight = null;
				pumpTick();
			});
	};
	const write: StreamWriter = (chunk) => {
		if (!chunk) return;
		latestTick = chunk;
		pumpTick();
	};
	const drainTicks = async () => {
		for (;;) {
			pumpTick();
			if (tickInFlight) await tickInFlight.catch(() => {});
			else if (!latestTick) break;
		}
	};
	const work = (async () => {
		try {
			await writer.write(enc.encode(docStart(title, opts) + firstHtml));
			const tail = (await rest(write)) + DOC_END;
			await drainTicks();
			await writer.write(enc.encode(tail));
			await writer.close();
		} catch (e) {
			await writer.abort(e).catch(() => {});
		}
	})();
	opts.waitUntil?.(work);
	return new Response(readable, { headers: new Headers(SECURITY_HEADERS) });
}

export function errorPage(message: string, status = 400): Response {
	return page(
		"Something went wrong",
		`<p class="eyebrow mono warnword">${ICON.alert}Error</p><h1>Something went wrong</h1>
<p class="lede">${escapeHtml(message)}</p>
<p class="actions"><a class="btn" href="/app">${ICON.back}Back</a></p>`,
		{ status, solo: true, bar: WORDMARK_BAR },
	);
}
