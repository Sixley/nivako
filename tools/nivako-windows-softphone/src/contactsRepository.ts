import { fetchCardDavContactsFromLocalApi } from "./carddav";
import { isTauriRuntime, syncCardDavNative } from "./nativeBridge";
import type { Contact, Settings } from "./types";

export async function syncCardDavContacts(settings: Settings): Promise<Contact[]> {
  if (isTauriRuntime()) {
    return syncCardDavNative(settings);
  }

  return fetchCardDavContactsFromLocalApi();
}
