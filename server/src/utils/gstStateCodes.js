/**
 * Phase 8A - the standard GST state/UT code list published by CBIC/GSTN
 * (the same two-digit prefix used in every Indian GSTIN). This is fixed,
 * publicly-published reference data, not a business/tax policy choice -
 * the same category of thing as an ISO country-code list - so it is kept
 * as a small in-code constant rather than a new DB reference table or an
 * external dependency, per the locked Phase 8A scope.
 *
 * Used for: validating an address/settings `state_code`, determining
 * intra-state (CGST+SGST) vs inter-state (IGST) in taxService.js, and
 * display (invoice PDF, admin UI).
 */
export const GST_STATE_CODES = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
];

const CODE_SET = new Set(GST_STATE_CODES.map((s) => s.code));
const NAME_BY_CODE = Object.fromEntries(GST_STATE_CODES.map((s) => [s.code, s.name]));

export function isValidGstStateCode(code) {
  return typeof code === "string" && CODE_SET.has(code);
}

export function getGstStateName(code) {
  return NAME_BY_CODE[code] || null;
}
