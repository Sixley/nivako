import { compactSearchValue } from "./phoneNumber";
import type { Contact } from "./types";

export function searchContacts(contacts: Contact[], query: string): Contact[] {
  const needle = compactSearchValue(query);
  if (!needle) return contacts;

  return contacts.filter((contact) => {
    const values = [
      contact.displayName,
      contact.organization || "",
      contact.email || "",
      ...contact.phones.flatMap((phone) => [phone.raw, phone.normalized])
    ];

    return values.some((value) => compactSearchValue(value).includes(needle));
  });
}
