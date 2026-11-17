import { describe, expect, it } from "vitest";
import { bestOf3 } from "./helpers";
import { isSecurityEmail, LINK_REMOVED, MASK, redactItem, redactMeta, redactSecrets } from "../src/secrets";

describe("isSecurityEmail", () => {
	const yes: [string, string, string][] = [
		["G-482913 is your Google verification code", "Google <no-reply@accounts.google.com>", ""],
		["Reset your password", "Acme <no-reply@acme.example>", "Someone asked to reset the password for your account."],
		["Your Slack sign-in link", "Slack <no-reply@slack.com>", ""],
		["Sign in to Notion", "Notion <notify@notion.so>", "Here is your magic link. It expires in 10 minutes."],
		["Confirm your email address", "Shop <hello@shop.example>", ""],
		["New sign-in to your Google Account", "Google <no-reply@accounts.google.com>", ""],
		["Your 2FA code", "x <x@y.example>", ""],
		["Your one-time passcode", "Bank <alerts@bank.example>", ""],
		["Welcome", "Acme <hello@acme.example>", "Your verification code is 482913. It expires in 10 minutes."],
		["Код подтверждения", "Яндекс <id@yandex.ru>", "Ваш код: 734201"],
		["Восстановление пароля", "Госуслуги <no-reply@gosuslugi.ru>", ""],
		["Подтвердите почту", "Сервис <hello@service.example>", ""],
		["Одноразовый код для входа", "Банк <bank@bank.example>", ""],
		["Ihr Bestätigungscode", "Konto <konto@x.example>", ""],
		["Passwort zurücksetzen", "Konto <konto@x.example>", ""],
		["Votre code de vérification", "Compte <compte@x.example>", ""],
		["Réinitialisation de votre mot de passe", "Compte <compte@x.example>", ""],
		["Restablecer tu contraseña", "Cuenta <cuenta@x.example>", ""],
		["Código de verificación", "Cuenta <cuenta@x.example>", ""],
		// A security-only sender mentioning a code.
		["Your login", "Acme <security@acme.example>", "Use code 4821 to finish."],
		// Magic links and recovery mail without a code word in the subject.
		["Sign in to Notion", "Notion <notify@notion.so>", "Click the button below to sign in.\nhttps://www.notion.so/loginwithemail?token=abc"],
		["Sign in to Medium", "Medium <noreply@medium.com>", ""],
		["Change your password", "Acme <hello@acme.example>", ""],
		["Account update", "Acme <hello@acme.example>", "To set a new password, open https://acme.example/p/abc"],
		["Complete your request", "Acme <hello@acme.example>", "Choose a new password: https://acme.example/p/abc"],
		["Your Apple Account code", "Apple <noreply@apple.com>", "Your Apple Account code is: 482913"],
		["Your Steam account: Access from new web or mobile device", "Steam Support <noreply@steampowered.com>", "Here is the Steam Guard code you need to login to account x:\n\nFXKQP\n\nIf you did not make this login attempt"],
		["Welcome", "Acme <hello@acme.example>", "Your verification code is XKQPTZ"],
		["Войдите в Госуслуги", "Госуслуги <no-reply@gosuslugi.ru>", ""],
		["Аккаунт", "Сервис <hello@service.example>", "Нажмите на кнопку ниже, чтобы войти: https://service.example/l/abc"],
		["Смена пароля", "Сервис <hello@service.example>", ""],
	];
	for (const [subject, from, text] of yes) {
		it(`flags "${subject}"`, () => expect(isSecurityEmail(subject, from, text)).toBe(true));
	}

	const no: [string, string, string][] = [
		["Five tools we love", "The Weekly <news@weekly.example>", "Why you should use a password manager, and how to pick one. Plus: turn on two-factor authentication."],
		["Your order 123456 has shipped", "Shop <orders@shop.example>", "Track it at https://shop.example/t/123456. Total €1,240.00."],
		["Code review for PR 41", "Anna <anna@client.example>", "Can you look at the code before Friday?"],
		["Re: Lisbon offsite", "Tom <tom@lisbon.example>", "The venue's door code changes daily, so I'll send it on the day."],
		["Manage your email preferences", "News <news@x.example>", "Confirm your email preferences at any time."],
		["Счёт за октябрь", "Бухгалтерия <buh@x.example>", "Оплатите счёт до 7 ноября. Пароль от Wi-Fi в офисе прежний."],
		["Security tips for small teams", "Blog <blog@x.example>", "Strong passwords and 2FA keep accounts safe."],
		// Review findings: none of these is a security email.
		["Re: PR 4821", "Tom <tom@x.example>", "I think your code is fine, merge it."],
		["Доставка", "Магазин <shop@x.example>", "Подтвердите адрес доставки до 7 ноября, заказ 123456"],
		["Transfer", "Bank <bank@x.example>", "Please confirm account details for the transfer of €5,000."],
		["OTP Bank statement", "OTP Bank <info@otpbank.example>", "Your statement for October is attached."],
		["New issue out", "Journal <authors@journal.example>", "Issue 41 is out: https://journal.example/41"],
		["Офис", "Офис <office@x.example>", "Новый вход в офис со двора, код домофона прежний."],
		["Your access code to the event", "Events <events@x.example>", "See you there."],
		["Re: your code review", "Tom <tom@x.example>", "Looks good."],
		["Tips", "Blog <blog@x.example>", "Change your password every year and set a new password for each site."],
	];
	for (const [subject, from, text] of no) {
		it(`doesn't flag "${subject}"`, () => expect(isSecurityEmail(subject, from, text)).toBe(false));
	}
});

describe("redactSecrets", () => {
	it("in a security email, masks every code-like token and removes every link", () => {
		const text =
			"Your code is 482913. Or 482 913, 482-913, G-482913, ABCD-EFGH, X7K9P2.\nКод: 734201\nReset: https://acme.example/reset?t=abc or www.acme.example/r or acme.example/reset/abc";
		expect(redactSecrets(text, true)).toBe(
			`Your code is ${MASK}. Or ${MASK}, ${MASK}, ${MASK}, ${MASK}, ${MASK}.\nКод: ${MASK}\nReset: ${LINK_REMOVED} or ${LINK_REMOVED} or ${LINK_REMOVED}`,
		);
		// Dates, times, amounts and years stay readable.
		expect(redactSecrets("Requested on 20.10.2026 at 10:00 from London. €1,240.00. © 2026 Acme", true)).toBe(
			"Requested on 20.10.2026 at 10:00 from London. €1,240.00. © 2026 Acme",
		);
	});

	it("in any email, masks a code right after a code word, within a few words and never across a sentence", () => {
		const cases: [string, string][] = [
			["The door code is 4821, see you at 12:30.", `The door code is ${MASK}, see you at 12:30.`],
			["PIN 1234", `PIN ${MASK}`],
			["Your OTP: 998877", `Your OTP: ${MASK}`],
			["Ваш код — 734 201", `Ваш код — ${MASK}`],
			["Temporary password: hunter2", `Temporary password: ${MASK}`],
			["Code 482.913 or 482 913", `Code ${MASK} or 482 913`],
			["Code:\n482913", `Code:\n${MASK}`],
		];
		for (const [input, out] of cases) expect(redactSecrets(input, false)).toBe(out);
		// No code word, or one in another sentence: left alone.
		for (const keep of [
			"Order 123456 shipped on 20.10.2026; €1,240.00 paid. Invoice 2026-118.",
			"Use a password manager. Order 123456 is on its way.",
			"Call +44 20 7946 0958 or visit https://shop.example/a/123456",
			"The code is ready; release 2.4.1 ships at 10:00.",
			"We changed the code, 3 times.",
			// Review findings: dates, error and sort codes, tickets and promos stay readable.
			"The code freeze is on 2026-11-03.",
			"Your guest password expires on 2026-11-03.",
			"Sort code 20-00-00, account 12345678.",
			"Error code 500 again.",
			"Ticket code ABC-1234 for row 5.",
			"Use promo code SAVE20 at checkout.",
			"Code: 2026-11-03 is the deadline.",
			"The code for Acme is X7K9P2.",
		]) {
			expect(redactSecrets(keep, false)).toBe(keep);
		}
	});

	it("in a security email, also masks all-letter codes, codes on their own line, lower-case dashed and split digits, and whole long links", () => {
		const cases: [string, string][] = [
			["Your verification code is XKQPTZ", `Your verification code is ${MASK}`],
			["Steam Guard code:\n\nFXKQP\n\nThanks", `Steam Guard code:\n\n${MASK}\n\nThanks`],
			["Use ab12-cd34 now", `Use ${MASK} now`],
			["4\t8\t2\t9\t1\t3", MASK],
			["Code 482.913 here", `Code ${MASK} here`],
			["or 4 8 2 9 1 3.", `or ${MASK}.`],
			[`Go https://a.example/${"a".repeat(3_000)}SECRETTOKEN end`, `Go ${LINK_REMOVED} end`],
			["Requested on 2026-11-03 and 03.11.2026, 3/11/26.", "Requested on 2026-11-03 and 03.11.2026, 3/11/26."],
		];
		for (const [input, out] of cases) expect(redactSecrets(input, true)).toBe(out);
	});

	it("masks cache meta: subject and snippet, flagged", () => {
		const m = redactMeta({ threadId: "t", from: "Acme <no-reply@acme.example>", subject: "482913 is your Acme verification code", date: null, snippet: "Use 482913" });
		expect(m).toMatchObject({ subject: `${MASK} is your Acme verification code`, snippet: `Use ${MASK}`, security: true });
	});

	// Linear: one hostile email can't make masking slow.
	const HOSTILE = ["1", "1 ", "4\t", "482.", "12-", "a-1", "code ", "code: a1 ", "code 12 ", "error code 1 ", "код ", "код: а1 ", "pin pin pin 1 ", "your ", "your code ", "sign in to ", "click the button below to ", "AAAA-", "A1", "http://", "www.", "a.a.", "a.b/", "code is the ", "2026 ", "G-1"];
	for (const unit of HOSTILE) {
		it(`stays fast on 40 KB of ${JSON.stringify(unit)}`, () => {
			const text = unit.repeat(Math.ceil(40_000 / unit.length));
			// Best of three: a quadratic pattern is slow every time; a busy test machine only sometimes.
			expect(bestOf3(() => {
				redactSecrets(text, true);
				redactSecrets(text, false);
				isSecurityEmail(text, text, text);
			})).toBeLessThan(50);
		});
	}
});

describe("isSecurityEmail on hostile input", () => {
	// Quadratic stems were seconds per call on a 40 KB subject; the subject, sender and text are capped and
	// every quantifier is bounded. Checked in the subject, the sender and the text.
	for (const stem of ["сброс", "смен", "ссылк", "одноразов", "подтверждени", "réinitialis", "your ", "sign in to ", "otp "]) {
		it(`stays fast on 40 KB of ${JSON.stringify(stem)}`, () => {
			const big = stem.repeat(Math.ceil(40_000 / stem.length));
			expect(bestOf3(() => {
				isSecurityEmail(big, "", "");
				isSecurityEmail("", big, "");
				isSecurityEmail("", "", big);
				isSecurityEmail(big, big, big);
			})).toBeLessThan(50);
			expect(bestOf3(() => redactItem({ subject: big, from: big, snippet: big, summary: big, action: "", text: big }))).toBeLessThan(100);
		});
	}
});

describe("redactItem (when a stored digest is read)", () => {
	it("masks an older item's raw code and link, and flags it", () => {
		const it0 = {
			subject: "482913 is your Acme verification code",
			from: "Acme <no-reply@acme.example>",
			snippet: "482913 is your code",
			summary: "Acme sent code 482913",
			action: "",
			text: "Your code is 482913. Or reset at https://acme.example/reset?t=abc",
			estimated: { by: "history" as const, reason: "Estimated: like ‘482913 is your code’" },
		};
		const out = redactItem<typeof it0 & { security?: true }>(it0);
		expect(JSON.stringify(out)).not.toMatch(/482913|acme\.example\/reset/);
		expect(out.security).toBe(true);
		expect(out.subject).toBe(`${MASK} is your Acme verification code`);
	});
});
