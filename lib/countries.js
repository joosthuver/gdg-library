// "Canada, Denmark" / "Canada and Denmark" / "canada" → ['canada', 'denmark'].
// Used for the "from N countries" count; case and spacing don't matter.
const countryList = (s) =>
  String(s || '').split(/\s*(?:,|;|\/|&|\band\b|\+)\s*/i).map((x) => x.trim().toLowerCase()).filter(Boolean);

export const countCountries = (values) => new Set(values.flatMap(countryList)).size;
