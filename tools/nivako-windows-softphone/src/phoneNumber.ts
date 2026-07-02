export function normalizePhoneNumber(raw: string, defaultCountryCode = "49"): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  let value = trimmed.replace(/[^\d+]/g, "");

  if (value.startsWith("00")) {
    value = `+${value.slice(2)}`;
  }

  if (value.startsWith("+")) {
    return `+${value.slice(1).replace(/\D/g, "")}`;
  }

  if (value.startsWith("0")) {
    return `+${defaultCountryCode}${value.slice(1)}`;
  }

  return `+${defaultCountryCode}${value}`;
}

export function compactSearchValue(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\da-z+]/g, "");
}
