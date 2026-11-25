// E-mail addresses and domains the CRM knows, for linking the agency's mail
// (Gmail) to contacts, clubs and deals. Shared by the edit forms (what may be
// saved) and the server (what it asks Gmail for).
//
// A contact has one address (contactEmail). A club has one e-mail domain
// (emailDomain): any address at that domain or below it is the club's. A free
// mail domain (gmail.com, walla.co.il, …) is never a club's domain, because
// everyone writes from it; such an address only ever matches as one
// contact's own address.

/** Domains anyone can open a mailbox at, exactly. */
export const FREE_MAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'msn.com', 'ymail.com', 'rocketmail.com',
  'mail.com', 'email.com', 'zoho.com', 'protonmail.com', 'proton.me', 'pm.me', 'tutanota.com', 'fastmail.com', 'hushmail.com',
  'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 't-online.de', 'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'qq.com', '163.com', '126.com',
  'walla.co.il', 'walla.com', 'nana.co.il', 'nana10.co.il', 'bezeqint.net', 'netvision.net.il', '012.net.il', 'zahav.net.il',
  'smile.net.il', 'inter.net.il', 'barak.net.il', 'hotmail.co.il', 'orange.net.il', 'libero.it', 'virgilio.it', 'laposte.net',
  'orange.fr', 'free.fr', 'sfr.fr', 'wanadoo.fr', 'terra.com.br', 'uol.com.br', 'bol.com.br', 'seznam.cz', 'wp.pl', 'o2.pl', 'interia.pl', 'abv.bg',
] as const;

/** Providers that exist under many country endings: yahoo.co.uk, hotmail.fr, outlook.co.il, … */
const FREE_FAMILIES = new Set(['yahoo', 'hotmail', 'outlook', 'live', 'windowslive', 'yandex', 'gmx', 'aol', 'msn']);
/** The longest ending a family domain carries after its name (".com.br", ".co.uk"). */
const MAX_FAMILY_ENDING = 8;
/** A country ending has at least two letters and at most two parts (".fr", ".co.uk"). */
const MIN_ENDING_LENGTH = 2;
const MAX_ENDING_PARTS = 2;
/** A domain has at least two labels ("club.co.il" has three). */
const MIN_HOST_LABELS = 2;

/** The longest address and domain the mail standards allow, and the longest label of a domain. */
const MAX_EMAIL_LENGTH = 254;
const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

const FREE = new Set<string>(FREE_MAIL_DOMAINS);

const trimAt = (s: string): string => (s.startsWith('@') ? s.slice(1) : s);
const trimDot = (s: string): string => (s.endsWith('.') ? s.slice(0, -1) : s);

/** The domain and every parent of it that is still a domain: "a.b.co.il" → ["a.b.co.il", "b.co.il", "co.il"]. */
const tails = (domain: string): string[] => {
  const parts = domain.split('.');
  return parts.slice(0, -1).map((_, i) => parts.slice(i).join('.'));
};

/** "yahoo.co.uk" is a family domain; "yahoosports.com" and "mail.yahoo.example.com" are not. */
const isFamily = (tail: string): boolean => {
  const dot = tail.indexOf('.');
  const ending = tail.slice(dot + 1);
  return dot > 0 && FREE_FAMILIES.has(tail.slice(0, dot)) && ending.length >= MIN_ENDING_LENGTH && ending.length <= MAX_FAMILY_ENDING && ending.split('.').length <= MAX_ENDING_PARTS;
};

/** True for a domain anyone can have a mailbox at (and for any of its subdomains). */
export const isFreeMailDomain = (domain: unknown): boolean => {
  const d = trimDot(trimAt(String(domain || '').trim().toLowerCase()));
  return !!d && tails(d).some((tail) => FREE.has(tail) || isFamily(tail));
};

const LABEL_CHARS = new Set('abcdefghijklmnopqrstuvwxyz0123456789-');
const LOCAL_CHARS = new Set("abcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-");

/** One label of a host name: letters, digits and inner hyphens. "fc-porto" yes; "-porto", "" no. */
const isLabel = (label: string): boolean =>
  label.length > 0 && label.length <= MAX_LABEL_LENGTH && !label.startsWith('-') && !label.endsWith('-') && [...label].every((c) => LABEL_CHARS.has(c));

/** A host name of two labels or more: "club.co.il" yes; "localhost", "club..com" no. */
const isHost = (host: string): boolean => {
  const labels = host.split('.');
  return host.length <= MAX_DOMAIN_LENGTH && labels.length >= MIN_HOST_LABELS && labels.every(isLabel);
};

/** A plain lower-case address: "dana.levi@club.co.il" yes; "dana@", "dana levi@club.co.il" no. */
const isAddress = (e: string): boolean => {
  const at = e.lastIndexOf('@');
  const local = e.slice(0, at);
  return at > 0 && e.length <= MAX_EMAIL_LENGTH && [...local].every((c) => LOCAL_CHARS.has(c)) && isHost(e.slice(at + 1));
};

/** The address inside the last angle brackets of a header value: "Dana <dana@x.com>" → "dana@x.com". */
const insideAngles = (s: string): string => {
  const close = s.lastIndexOf('>');
  const open = s.lastIndexOf('<', close);
  return close === s.length - 1 && open >= 0 ? s.slice(open + 1, close) : s;
};

/** "Dana <Dana@Club.co.il>" / " dana@club.co.il " → "dana@club.co.il"; anything else → "". */
export const normalizeEmail = (raw: unknown): string => {
  const inner = insideAngles(String(raw || '').trim()).trim().toLowerCase();
  const e = inner.startsWith('mailto:') ? inner.slice('mailto:'.length) : inner;
  return isAddress(e) ? e : '';
};

/** The domain of an address ("dana@mail.club.co.il" → "mail.club.co.il"), or "". */
export const emailDomainOf = (email: unknown): string => {
  const e = normalizeEmail(email);
  return e ? e.slice(e.indexOf('@') + 1) : '';
};

/** "https://www.club.co.il:8080/he?x" → "club.co.il" (the host of a web address, without www). */
const hostOfUrl = (s: string): string => {
  const SEP = '://';
  const scheme = s.indexOf(SEP);
  const rest = scheme >= 0 ? s.slice(scheme + SEP.length) : s;
  const end = [...rest].findIndex((c) => c === '/' || c === '?' || c === '#' || c === ':');
  const host = end >= 0 ? rest.slice(0, end) : rest;
  return host.startsWith('www.') ? host.slice('www.'.length) : host;
};

/**
 * What a person types as a club's mail domain, made into a bare domain:
 * "@club.co.il", "https://www.club.co.il/he", "office@club.co.il" → "club.co.il".
 * "" when it is not a domain.
 */
export const normalizeMailDomain = (raw: unknown): string => {
  const s = String(raw || '').trim().toLowerCase();
  const d = trimDot(s.includes('@') ? s.slice(s.lastIndexOf('@') + 1) : hostOfUrl(s));
  return isHost(d) ? d : '';
};

/** Why a club's mail domain cannot be saved: 'invalid', 'free', or null when it can (an empty value can). */
export const clubDomainProblem = (raw: unknown): 'invalid' | 'free' | null => {
  if (!String(raw || '').trim()) return null;
  const d = normalizeMailDomain(raw);
  if (!d) return 'invalid';
  return isFreeMailDomain(d) ? 'free' : null;
};

/** Whether an address belongs to a club domain (the domain itself or a subdomain of it). */
export const addressInDomain = (email: unknown, domain: unknown): boolean => {
  const host = emailDomainOf(email);
  const d = normalizeMailDomain(domain);
  return !!host && !!d && (host === d || host.endsWith(`.${d}`));
};
