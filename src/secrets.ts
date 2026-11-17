// Sign-in codes and recovery links: kept out of everything the app stores, shows or hands on.
//
// The threat: an email tells an AI to find a password-recovery code and send it somewhere, while the
// attacker triggers a real reset so a code arrives at the same time. The in-app model can't send
// anything, but text the app keeps (digests, the cache, history, the To action copy the owner pastes
// into other LLMs) could carry the code to an AI that can. So security emails (resets, verification
// and sign-in codes, magic links, new sign-in alerts) have every code-like token and every link
// masked, and in all other mail a code right after a word like "code" or "PIN" is masked too.
//
// Every regex here has bounded quantifiers only (or none that can overlap), so the work is linear in
// the text: a hostile email can't make this slow.

/** What a masked code becomes. */
export const MASK = "••••••";
/** What a link in a security email becomes. */
export const LINK_REMOVED = "[link removed]";

/** Case-insensitive without the `i` flag (which would also make [A-Z] match lower case below). */
function ci(word: string): string {
	return [...word].map((ch) => (ch.toLowerCase() !== ch.toUpperCase() ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch)).join("");
}
/** A regex source from phrase alternatives written in lower case: letters made case-insensitive, \s etc. kept. */
const alt = (phrases: string[]) =>
	phrases.map((p) => p.replace(/(\\p\{[A-Za-z]+\}|\\[a-zA-Z]|\[[^\]]*\]|\(\?<?[:!=]|\{\d+(?:,\d*)?\})|(\p{L})/gu, (_m, esc, ch) => (ch ? ci(ch) : esc))).join("|");

// Every quantifier is bounded, the subject and sender are capped and the text is looked at only at
// its head, so this costs the same on a hostile email as on any other.

/** Phrases that make an email a security email: in the subject on their own; in the text with evidence. */
const DEFINITE = [
	// English
	"(?:password|passcode|pin)\\s{1,3}(?:reset|recovery|change\\s{1,3}request)",
	"reset\\s{1,3}(?:your\\s{1,3}|the\\s{1,3})?(?:password|passcode|pin)",
	"forgot\\s{1,3}(?:your\\s{1,3})?password",
	"recover\\s{1,3}your\\s{1,3}(?:account|password)",
	"(?:change|set|choose|create)\\s{1,3}(?:a\\s{1,3})?(?:new\\s{1,3})?(?:your\\s{1,3})?password",
	"(?:verification|verify|security|confirmation|sign[- ]?in|log[- ]?in|login|authentication|one[- ]time|single[- ]use|temporary|backup|recovery|2fa|mfa)\\s{1,3}(?:code|pin|passcode|password|link)s?",
	"one[- ]time\\s{1,3}pass(?:word|code)",
	"code\\s{1,3}to\\s{1,3}(?:sign|log)\\s{1,3}in",
	"(?:magic|sign[- ]?in|log[- ]?in|login)\\s{1,3}link",
	"(?:verify|confirm)\\s{1,3}your\\s{1,3}(?:e-?mail(?:\\s{1,3}address)?|account|identity|login|registration|phone\\s{1,3}number)(?!\\s{1,3}(?:preferences|settings|subscription|details))",
	"new\\s{1,3}(?:sign[- ]?in|login|log[- ]?in)\\s{1,3}(?:to|on|from|attempt|detected)",
	"(?:sign[- ]?in|login)\\s{1,3}attempt",
	"click\\s{1,3}(?:the\\s{1,3}(?:button|link)[\\s,]{1,3}(?:below[\\s,]{1,3})?|below[\\s,]{1,3}|here[\\s,]{1,3})to\\s{1,3}(?:sign|log)\\s{0,3}in",
	// Russian
	"код\\s{1,3}(?:подтверждения|для\\s{1,3}входа|безопасности|верификации|авторизации|восстановления)",
	"(?:одноразов|проверочн)\\p{L}{0,8}\\s{1,3}(?:код|пароль)",
	"(?:восстановлени|сброс|смен|изменени)\\p{L}{0,8}\\s{1,3}пароля",
	"(?:задайте|придумайте|установите)\\s{1,3}(?:новый\\s{1,3})?пароль",
	"подтвердите\\s{1,3}(?:вашу\\s{1,3}|свою\\s{1,3}|ваш\\s{1,3}|свой\\s{1,3})?(?:почту|адрес\\s{1,3}(?:электронной\\s{1,3}почты|e-?mail)|e-?mail|электронную\\s{1,3}почту|вход|регистрацию|аккаунт|учётную\\s{1,3}запись|учетную\\s{1,3}запись|номер\\s{1,3}телефона)",
	"подтверждени\\p{L}{0,4}\\s{1,3}(?:почты|входа|регистрации|e-?mail)",
	"ссылк\\p{L}{0,4}\\s{1,3}для\\s{1,3}входа",
	"(?:новый|подозрительный)\\s{1,3}вход\\s{1,3}в\\s{1,3}(?:аккаунт|учётную|учетную|систему|профиль|ваш)",
	"нажмите\\s{1,3}(?:на\\s{1,3})?(?:кнопку|ссылку)\\p{L}{0,2}[\\s,]{1,3}(?:ниже[\\s,]{1,3})?(?:чтобы\\s{1,3})?войти",
	// German
	"(?:bestätigungs|sicherheits|verifizierungs|einmal|anmelde)code",
	"(?:passwort|kennwort)\\s{1,3}(?:zurücksetzen|vergessen|ändern)",
	"(?:e-?mail(?:-adresse)?|konto)\\s{1,3}bestätigen",
	// French
	"code\\s{1,3}(?:de\\s{1,3}vérification|de\\s{1,3}sécurité|de\\s{1,3}confirmation|à\\s{1,3}usage\\s{1,3}unique|de\\s{1,3}connexion)",
	"réinitialis\\p{L}{0,8}\\s{1,3}(?:de\\s{1,3})?(?:votre\\s{1,3}|du\\s{1,3})?mot\\s{1,3}de\\s{1,3}passe",
	"mot\\s{1,3}de\\s{1,3}passe\\s{1,3}oublié",
	"confirmez\\s{1,3}votre\\s{1,3}(?:adresse|e-?mail|compte|inscription)",
	// Spanish
	"código\\s{1,3}(?:de\\s{1,3}verificación|de\\s{1,3}seguridad|de\\s{1,3}confirmación|de\\s{1,3}un\\s{1,3}solo\\s{1,3}uso|de\\s{1,3}inicio)",
	"(?:restablecer|recuperar|cambiar)\\s{1,3}(?:la\\s{1,3}|tu\\s{1,3}|su\\s{1,3})?contraseña",
	"confirma\\s{1,3}tu\\s{1,3}(?:correo|cuenta|e-?mail|dirección\\s{1,3}de\\s{1,3}correo)",
	"nuevo\\s{1,3}inicio\\s{1,3}de\\s{1,3}sesión",
];
const BOUND_L = String.raw`(?<![\p{L}\p{N}])`;
const BOUND_R = String.raw`(?![\p{L}\p{N}])`;
const DEFINITE_RE = new RegExp(`${BOUND_L}(?:${alt(DEFINITE)})`, "u");
const DEFINITE_ALL = new RegExp(`${BOUND_L}(?:${alt(DEFINITE)})`, "gu");
/** A code: 4–10 digits (also grouped "482 913"), or 4–10 capitals and digits ("XKQPTZ", "G-482913"). */
const CODE_TOKEN = String.raw`(?:\d{4,10}|\d{2,4}(?:[ \t.-]\d{2,4}){1,3}|[A-Z]{1,4}-\d{4,10}|[A-Z0-9]{4,10})`;
/** "Your Apple Account code is: 482913", "Ваш код: 734201": a code phrase with the code right after it. */
const CODE_IS = new RegExp(
	`${BOUND_L}(?:${alt(["your\\s{1,3}(?:\\p{L}{1,20}\\s{1,3}){0,3}?(?:code|passcode|pin|otp)", "ваш\\s{1,3}(?:\\p{L}{1,20}\\s{1,3}){0,2}?код"])})\\s{0,3}(?:${alt(["is", "это"])}|:|—|-)?\\s{0,3}:?\\s{0,3}${CODE_TOKEN}${BOUND_R}`,
	"u",
);
/** Only in the subject: "Sign in to Notion", "Your Apple Account code", "New sign-in", "2FA"… */
const SUBJECT_ONLY = new RegExp(
	`^\\s{0,3}(?:${alt(["(?:sign|log)[- ]?in\\s{1,3}to\\s", "войдите\\s{1,3}в\\s", "вход\\s{1,3}в\\s"])})|${BOUND_L}(?:${alt([
		"two[- ](?:factor|step)",
		"2fa",
		"mfa",
		"двухфакторн\\p{L}{0,8}",
		"zwei-?faktor\\p{L}{0,8}",
		"security\\s{1,3}alert",
		"new\\s{1,3}device",
		"your\\s{1,3}(?:\\p{L}{1,20}\\s{1,3}){0,3}?(?:code|passcode|pin)(?=\\s{0,3}(?:$|[:.!(]))",
		"ваш\\s{1,3}код(?=\\s{0,3}(?:$|[:.!(]))",
		"код\\s{1,3}входа",
	])})${BOUND_R}`,
	"u",
);
/** Product names that only ever mean a sign-in code, in the subject or the text: Steam Guard's codes are often letters only. */
const GUARD = new RegExp(`${BOUND_L}${ci("steam")}\\s{1,3}${ci("guard")}${BOUND_R}`, "u");
/** "OTP" counts only next to a code: "OTP Bank statement" is a bank. */
const OTP = new RegExp(`${BOUND_L}${ci("otp")}${BOUND_R}`, "u");
/** Evidence near a phrase in the text: a link, or a code with a digit in it. */
const EVIDENCE = new RegExp(
	String.raw`https?://|www\.|(?<![\p{L}\p{N}.,/:€$£-])(?:\d{4,10}|\d{2,4}(?:[ \t.-]\d{2,4}){1,3}|[A-Z]{1,4}-\d{4,10}|(?=[A-Z]{0,9}\d)[A-Z0-9]{4,10})(?![\p{L}\p{N}]|[.,]\d)`,
	"u",
);
/** A sender whose whole local part says it only sends security mail: security@, verify@, no-reply-security@… */
const SECURITY_SENDER = /(?:^|[<\s"])(?:security|verify|verification|otp|2fa|mfa|auth|login|signin|account-security|accounts?-noreply|no-?reply-security|security-no-?reply)@/i;

const SUBJECT_CHARS = 300;
const FROM_CHARS = 300;
/** How much of the text is looked at: security emails say what they are at the top. */
const HEAD_CHARS = 1_500;
/** How far from a phrase in the text a link or code counts as evidence. */
const NEAR = 300;

/**
 * A password reset or recovery, a verification, one-time, sign-in or login code, a magic sign-in
 * link, "confirm your email", or a new sign-in alert. English, Russian, German, French, Spanish.
 * In the subject a phrase is enough; in the text it needs a link or a code near it.
 */
export function isSecurityEmail(subject: string, from: string, text: string): boolean {
	const subj = subject.slice(0, SUBJECT_CHARS);
	const head = text.slice(0, HEAD_CHARS);
	if (DEFINITE_RE.test(subj) || SUBJECT_ONLY.test(subj) || CODE_IS.test(subj) || CODE_IS.test(head)) return true;
	if (GUARD.test(subj) || GUARD.test(head)) return true;
	if (OTP.test(subj) && EVIDENCE.test(`${subj}\n${head}`)) return true;
	for (const m of head.matchAll(DEFINITE_ALL)) {
		if (EVIDENCE.test(head.slice(Math.max(0, m.index - NEAR), m.index + m[0].length + NEAR))) return true;
	}
	// A security-only sender (security@, verify@…) with a code in the subject or text.
	return SECURITY_SENDER.test(from.slice(0, FROM_CHARS)) && EVIDENCE.test(`${subj}\n${head}`);
}

// --- Redaction ----------------------------------------------------------------------------------

// Whole non-space runs: a long link leaves no tail. Linear: matches never overlap and nothing follows \S+.
const URL = /\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi;
/** "example.com/reset?token=…": a host with a path. Anchored per token, so linear. */
const HOST_PATH = /^[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,8}\/\S*$/u;
/** Dates are never codes: "2026-11-03", "03.11.2026", "3/11/26". */
const NOT_DATE = String.raw`(?!\d{4}[-./]\d{1,2}[-./]\d{1,2}(?![\p{N}])|\d{1,2}[-./]\d{1,2}[-./]\d{2,4}(?![\p{N}]))`;

/** Code-like tokens, masked in security emails wherever they are. */
const CODE_PATTERNS: RegExp[] = [
	// A code on a line of its own: "FXKQP", "482913", "a7k9p2".
	/^[ \t]{0,40}(?:[A-Z0-9]{4,10}|(?=[a-z0-9]{0,9}\d)[a-z0-9]{4,10})[ \t]{0,40}$/gmu,
	// 4–10 digits standing alone (not part of a date, time, amount or longer number): years excepted.
	/(?<![\p{L}\p{N}.,/:€$£-])(?!(?:19|20)\d\d(?![\p{N}]))\d{4,10}(?![\p{L}\p{N}/:-]|[.,]\d)/gu,
	// "123 456", "123-456", "12 34 56", tab-split cells "482\t913".
	new RegExp(String.raw`(?<![\p{L}\p{N}.,/:-])${NOT_DATE}\d{2,4}(?:[ \t-]\d{2,4}){1,3}(?![\p{L}\p{N}/:-]|[.,]\d)`, "gu"),
	// "4 8 2 9 1 3", "4\t8\t2\t9\t1\t3" (table cells), "4.8.2.9": single digits apart.
	/(?<![\p{L}\p{N}.,/:-])\d(?:[ \t.-]\d){3,9}(?![\p{L}\p{N}]|[.,]\d)/gu,
	// "482.913", "482.913.071".
	/(?<![\p{L}\p{N}.,/:-])\d{3}(?:\.\d{3}){1,2}(?![\p{L}\p{N}]|[.,]\d)/gu,
	// "G-123456", "ABCD-EFGH", "AB12-CD34", "ab12-cd34" (lower case with a digit). Not dates.
	new RegExp(
		String.raw`(?<![\p{L}\p{N}-])${NOT_DATE}(?:[A-Z0-9]{1,6}(?:-[A-Z0-9]{2,8}){1,3}|(?=[a-zA-Z0-9-]{0,30}\d)[a-zA-Z0-9]{2,6}(?:-[a-zA-Z0-9]{2,8}){1,3})(?![\p{L}\p{N}-])`,
		"gu",
	),
	// "X7K9P2": 5–10 capitals and digits with at least one of each.
	/(?<![\p{L}\p{N}-])(?=[A-Z]{0,9}\d)(?=\d{0,9}[A-Z])[A-Z0-9]{5,10}(?![\p{L}\p{N}-])/gu,
];

/** Code words. Not "error code", "sort code", "promo code", "zip code", "ticket code" and the like. */
const KEYWORD = `${BOUND_L}(?<!${BOUND_L}(?:${alt([
	"error",
	"sort",
	"promo",
	"promotional",
	"discount",
	"coupon",
	"voucher",
	"gift",
	"zip",
	"post",
	"postal",
	"ticket",
	"status",
	"country",
	"area",
	"source",
	"dress",
	"tax",
	"product",
	"item",
	"qr",
	"http",
	"bar",
])})\\s{1,3})(?:${alt(["code", "passcode", "pin", "otp", "password", "код", "пароль", "пин", "código", "contraseña", "mot\\s{1,3}de\\s{1,3}passe", "passwort", "kennwort"])})${BOUND_R}`;
/** Right after the code word: ": ", " is ", " — ", or just a space. */
const DIRECT = `(?:\\s{0,3}[:=—–-]\\s{0,3}|\\s{1,3}(?:${alt(["is", "was", "это", "est", "es", "ist"])})\\s{0,3}:?\\s{0,3}|\\s{1,3})`;
/** The code: digits (also grouped), or a token of 3–12 letters and digits with a digit in it. */
const CODE_ANY = String.raw`(?:\d{2,4}(?:[ \t.-]\d{2,4}){1,3}|[\p{L}\p{N}][\p{L}\p{N}-]{2,11})`;
// Matched at the code, not at the word: a token start with a digit in it (or, in a security email,
// all capitals), cheap to rule out everywhere else; then the code word looked for just before it.
const keywordCode = (gate: string) =>
	new RegExp(String.raw`(?<![\p{L}\p{N}])(?=${gate})${NOT_DATE}(?<=${KEYWORD}${DIRECT})${CODE_ANY}(?![\p{L}\p{N}]|[.,]\d)`, "gu");
const KEYWORD_CODE = keywordCode(String.raw`[\p{L}\p{N}-]{0,11}\p{N}`);
const KEYWORD_CODE_SECURITY = keywordCode(String.raw`[\p{L}\p{N}-]{0,11}\p{N}|[A-Z]{4,10}(?![\p{L}\p{N}])`);

/**
 * `text` with sign-in secrets masked. In a security email: every link becomes "[link removed]" and
 * every code-like token "••••••". In any email: a code right after a code word ("PIN 4821").
 */
export function redactSecrets(text: string, security: boolean): string {
	let s = text.replace(security ? KEYWORD_CODE_SECURITY : KEYWORD_CODE, MASK);
	if (!security) return s;
	s = s.replace(URL, LINK_REMOVED);
	s = s
		.split(/(\s+)/)
		.map((tok) => (HOST_PATH.test(tok) ? LINK_REMOVED : tok))
		.join("");
	for (const re of CODE_PATTERNS) s = s.replace(re, MASK);
	return s;
}

// --- Items and stored digests -------------------------------------------------------------------

/** The fields of a digest item that hold email or model text. */
interface Redactable {
	subject: string;
	from: string;
	snippet: string;
	summary: string;
	action: string;
	text?: string;
	security?: true;
	estimated?: { by: "history" | "rules"; reason: string; check?: true };
}

/**
 * The item with its secrets masked, flagged `security` when it's a security email. Applied when a
 * digest is read (getDigest), so a digest stored before this, or a stored item that slipped
 * through, is masked on the page, in the email, in the copy for an LLM and when carried over.
 */
export function redactItem<T extends Redactable>(it: T): T {
	const security = it.security === true || isSecurityEmail(it.subject, it.from, it.text ?? it.snippet);
	const r = (s: string) => redactSecrets(s, security);
	const out: T = { ...it, subject: r(it.subject), snippet: r(it.snippet), summary: r(it.summary), action: r(it.action) };
	if (it.text !== undefined) out.text = r(it.text);
	if (it.estimated) out.estimated = { ...it.estimated, reason: r(it.estimated.reason) };
	if (security) out.security = true;
	return out;
}

/** A message's subject and snippet masked, flagged when it's a security email (cache entries, items). */
export function redactMeta<T extends { subject: string; from: string; snippet: string; security?: true }>(m: T): T {
	const security = m.security === true || isSecurityEmail(m.subject, m.from, m.snippet);
	const out: T = { ...m, subject: redactSecrets(m.subject, security), snippet: redactSecrets(m.snippet, security) };
	if (security) out.security = true;
	return out;
}
