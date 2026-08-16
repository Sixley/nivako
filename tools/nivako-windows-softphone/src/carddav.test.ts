import { describe, expect, it } from "vitest";
import { parseVCard, serializeVCard } from "./carddav";
import { normalizePhoneNumber } from "./phoneNumber";
import { searchContacts } from "./search";

describe("phone normalization", () => {
  it("normalizes German national numbers", () => {
    expect(normalizePhoneNumber("030 123-456")).toBe("+4930123456");
  });

  it("keeps international numbers", () => {
    expect(normalizePhoneNumber("+49 30 123456")).toBe("+4930123456");
  });
});

describe("vCard parsing", () => {
  it("extracts names, organization and phone numbers", () => {
    const contact = parseVCard(`BEGIN:VCARD
VERSION:3.0
FN:Kontakt Eins
ORG:Beispielfirma
TEL;TYPE=CELL:+49 30 123456
EMAIL:test@example.test
END:VCARD`, "/contact/test.vcf");

    expect(contact.displayName).toBe("Kontakt Eins");
    expect(contact.organization).toBe("Beispielfirma");
    expect(contact.phones[0].label).toBe("mobile");
    expect(contact.phones[0].normalized).toBe("+4930123456");
  });

  it("extracts embedded contact photos", () => {
    const contact = parseVCard(`BEGIN:VCARD
VERSION:3.0
FN:Kontakt mit Bild
PHOTO;ENCODING=b;TYPE=PNG:aGVsbG8=
TEL:+491234
END:VCARD`);
    expect(contact.photoUrl).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("preserves multiple typed phone numbers and primary status", () => {
    const contact = parseVCard(`BEGIN:VCARD
VERSION:3.0
FN:Mehrere Nummern
TEL;TYPE=WORK,VOICE:+495021123
TEL;TYPE=HOME,CELL,PREF:+491701234
TEL;TYPE=FAX:+495021999
END:VCARD`);
    expect(contact.phones.map(({ label, primary }) => [label, Boolean(primary)])).toEqual([
      ["work", false], ["homeMobile", true], ["fax", false]
    ]);
    const roundTrip = parseVCard(serializeVCard(contact));
    expect(roundTrip.phones.map((phone) => phone.label)).toEqual(["work", "homeMobile", "fax"]);
  });
});

describe("contact search", () => {
  it("finds contacts by normalized number fragments", () => {
    const contact = parseVCard(`BEGIN:VCARD
VERSION:3.0
FN:Kontakt Zwei
ORG:Beispielfirma
TEL;TYPE=WORK:030 123456
END:VCARD`);

    expect(searchContacts([contact], "4930").length).toBe(1);
  });
});
