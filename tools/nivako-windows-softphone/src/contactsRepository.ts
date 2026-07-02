import { fetchCardDavContactsFromLocalApi } from "./carddav";
import { isTauriRuntime, syncCardDavNative } from "./nativeBridge";
import type { Contact, Settings } from "./types";

export async function syncCardDavContacts(settings: Settings, password?: string): Promise<Contact[]> {
  if (isTauriRuntime()) {
    return syncCardDavNative(settings, password);
  }

  return fetchCardDavContactsFromLocalApi();
}
