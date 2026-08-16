import { normalizePhoneNumber } from "./phoneNumber";
import type { Contact, ContactPhone, PhoneLabel } from "./types";

export interface CardDavConfig {
  url: string;
  username: string;
  password: string;
}

export interface CardDavResource {
  href: string;
  etag?: string;
  vcard: string;
}

function unfoldVCard(input: string): string[] {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").reduce<string[]>((lines, line) => {
    if (/^[ \t]/.test(line) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.trim()) {
      lines.push(line);
    }
    return lines;
  }, []);
}

function decodeVCardValue(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}

function getPropertyName(line: string): string {
  return line.slice(0, line.indexOf(":")).split(";")[0].toUpperCase();
}

function getPropertyValue(line: string): string {
  const index = line.indexOf(":");
  return index === -1 ? "" : decodeVCardValue(line.slice(index + 1));
}

function phoneLabelFromLine(line: string): PhoneLabel {
  const lower = line.toLowerCase();
  if (lower.includes("fax")) return "fax";
  if (lower.includes("cell") && lower.includes("work")) return "workMobile";
  if (lower.includes("cell") && lower.includes("home")) return "homeMobile";
  if (lower.includes("cell") || lower.includes("mobile")) return "mobile";
  if (lower.includes("home")) return "home";
  if (lower.includes("work")) return "work";
  if (lower.includes("main")) return "main";
  return "other";
}

function escapeVCardValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function phoneTypes(phone: ContactPhone): string {
  const types: Record<PhoneLabel, string> = {
    work: "WORK,VOICE", workMobile: "WORK,CELL", mobile: "CELL", home: "HOME,VOICE",
    homeMobile: "HOME,CELL", fax: "FAX", main: "MAIN,VOICE", other: "VOICE"
  };
  return `${types[phone.label]}${phone.primary ? ",PREF" : ""}`;
}

export function serializeVCard(contact: Contact): string {
  const uid = contact.id.replace(/^.*\//, "").replace(/\.vcf$/i, "") || crypto.randomUUID();
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `UID:${escapeVCardValue(uid)}`, `FN:${escapeVCardValue(contact.displayName)}`, `N:${escapeVCardValue(contact.displayName)};;;;`];
  if (contact.organization) lines.push(`ORG:${escapeVCardValue(contact.organization)}`);
  if (contact.email) lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardValue(contact.email)}`);
  contact.phones.filter((phone) => phone.raw.trim()).forEach((phone) => lines.push(`TEL;TYPE=${phoneTypes(phone)}:${escapeVCardValue(phone.raw.trim())}`));
  lines.push("REV:" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"), "END:VCARD");
  return `${lines.join("\r\n")}\r\n`;
}

export function parseVCard(vcard: string, href: string = crypto.randomUUID(), etag?: string): Contact {
  const lines = unfoldVCard(vcard);
  const phones: ContactPhone[] = [];
  let displayName = "";
  let firstName = "";
  let lastName = "";
  let organization = "";
  let email = "";
  let photoUrl = "";

  for (const line of lines) {
    const property = getPropertyName(line);
    const value = getPropertyValue(line);

    if (property === "FN") displayName = value;
    if (property === "N") {
      const [last, first] = value.split(";");
      firstName = firstName || first || "";
      lastName = lastName || last || "";
    }
    if (property === "ORG") organization = value.split(";").filter(Boolean).join(" / ");
    if (property === "EMAIL" && !email) email = value;
    if (property === "PHOTO" && !photoUrl) {
      if (/^https?:\/\//i.test(value) || value.startsWith("data:image/")) photoUrl = value;
      else if (/^[A-Za-z0-9+/=\s]+$/.test(value)) {
        const mime = /TYPE=(PNG)/i.test(line) ? "image/png" : "image/jpeg";
        photoUrl = `data:${mime};base64,${value.replace(/\s/g, "")}`;
      }
    }
    if (property === "TEL") {
      phones.push({
        label: phoneLabelFromLine(line),
        raw: value,
        normalized: normalizePhoneNumber(value),
        primary: /(?:TYPE=|[,;])PREF(?:[,;:]|$)/i.test(line)
      });
    }
  }

  const fallbackName = [firstName, lastName].filter(Boolean).join(" ").trim();

  return {
    id: href,
    displayName: displayName || fallbackName || organization || "Unbekannter Kontakt",
    organization: organization || undefined,
    email: email || undefined,
    photoUrl: photoUrl || undefined,
    phones,
    source: "carddav",
    etag
  };
}

export function parseCardDavMultistatus(xml: string): CardDavResource[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");
  const responses = Array.from(doc.getElementsByTagNameNS("*", "response"));

  return responses.flatMap((response) => {
    const href = response.getElementsByTagNameNS("*", "href")[0]?.textContent?.trim() || "";
    const etag = response.getElementsByTagNameNS("*", "getetag")[0]?.textContent?.trim();
    const vcard = response.getElementsByTagNameNS("*", "address-data")[0]?.textContent || "";

    if (!href || !vcard.includes("BEGIN:VCARD")) return [];
    return [{ href, etag, vcard }];
  });
}

export async function fetchCardDavContacts(config: CardDavConfig): Promise<Contact[]> {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag />
    <card:address-data />
  </d:prop>
</card:addressbook-query>`;

  const response = await fetch(config.url, {
    method: "REPORT",
    headers: {
      Authorization: `Basic ${btoa(`${config.username}:${config.password}`)}`,
      "Content-Type": "application/xml; charset=utf-8",
      Depth: "1"
    },
    body
  });

  if (!response.ok && response.status !== 207) {
    throw new Error(`CardDAV sync failed: HTTP ${response.status}`);
  }

  const xml = await response.text();
  return parseCardDavMultistatus(xml).map((resource) => parseVCard(resource.vcard, resource.href, resource.etag));
}

export async function fetchCardDavContactsFromLocalApi(): Promise<Contact[]> {
  const response = await fetch("/api/carddav/contacts");
  const payload = await response.json() as { ok: boolean; xml?: string; message?: string };
  if (!response.ok || !payload.ok || !payload.xml) {
    throw new Error(payload.message || `CardDAV API failed: HTTP ${response.status}`);
  }

  return parseCardDavMultistatus(payload.xml).map((resource) => parseVCard(resource.vcard, resource.href, resource.etag));
}

export function parseManyVCards(input: string): Contact[] {
  const matches = input.match(/BEGIN:VCARD[\s\S]*?END:VCARD/g) || [];
  return matches.map((vcard, index) => parseVCard(vcard, `import-${index}-${crypto.randomUUID()}`));
}
