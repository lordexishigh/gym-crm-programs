/**
 * Bulk member import from CSV (market gap: adoption).
 *
 * A gym switching from an incumbent CRM arrives with a spreadsheet export, not
 * an empty roster. This module turns that export into validated `MemberInput`
 * records so staff can preview exactly what will happen BEFORE anything is
 * written.
 *
 * Everything here is PURE — no DB, no env, no `pg`. That is deliberate on two
 * counts:
 *   1. the import wizard is a client component, so it can parse the picked file
 *      in the browser and render an instant preview with zero round-trips; and
 *   2. the Server Action re-parses the same text with the same code path before
 *      inserting, so the preview can never disagree with what is persisted and
 *      a hand-crafted POST gets exactly the same validation.
 *
 * Row validation delegates to `validateMemberInput` (lib/members) — the import
 * accepts precisely what the single-member form accepts, no parallel rulebook.
 */

import { validateMemberInput, type MemberInput } from "@/lib/members";

/**
 * Hard ceilings, enforced before parsing so a huge file can't lock the tab.
 *
 * The byte cap sits deliberately BELOW Next.js's 1 MB Server Action body limit:
 * the confirm step posts the raw CSV text back, and exceeding that limit would
 * surface as an opaque request failure instead of the actionable "split it into
 * smaller files" message below. A 1000-row member export is ~150 KB, so this is
 * generous headroom, not a real constraint.
 */
export const IMPORT_MAX_ROWS = 1000;
export const IMPORT_MAX_BYTES = 900_000;

// ---------------------------------------------------------------------------
// CSV reader (RFC 4180-ish, deliberately forgiving of real spreadsheet exports).

/** One physical record plus the 1-based source line it started on. */
export type CsvRow = { line: number; cells: string[] };

const DELIMITERS = [",", ";", "\t"] as const;
export type CsvDelimiter = (typeof DELIMITERS)[number];

/**
 * Guess the delimiter from the header line. Excel on a European locale (which
 * includes Cyprus) exports `;`-separated files, and "Save as tab-delimited" is
 * a common escape hatch — silently mis-parsing those as one giant column is the
 * single most likely way an import "just doesn't work".
 */
export function sniffDelimiter(text: string): CsvDelimiter {
  const firstLine = stripBom(text).split(/\r?\n/, 1)[0] ?? "";
  let best: CsvDelimiter = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    // Count only outside quotes so `"Doe, Jane";x` doesn't vote for a comma.
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse CSV text into rows of raw cell strings.
 *
 * Handles quoted fields, `""` escapes, embedded newlines and CRLF, and tracks
 * the starting source line of every record so an error message can point the
 * user at the right row in their spreadsheet (a quoted newline makes record
 * index and line number diverge). Fully-empty records are dropped — trailing
 * blank lines are the norm in exported files.
 *
 * A `"` is only treated as a quote when it opens a field; `He said "hi"` in an
 * unquoted cell is kept verbatim instead of derailing the rest of the file.
 */
export function parseCsvRows(text: string, delimiter?: CsvDelimiter): CsvRow[] {
  const src = stripBom(text);
  const delim = delimiter ?? sniffDelimiter(text);

  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let started = false;

  const pushField = () => {
    cells.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (cells.some((c) => c.trim() !== "")) {
      rows.push({ line: rowLine, cells: cells.map((c) => c.trim()) });
    }
    cells = [];
    started = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (!started) {
      rowLine = line;
      started = true;
    }

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (ch === delim) {
      pushField();
      continue;
    }
    if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      pushRow();
      line++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      line++;
      continue;
    }
    field += ch;
  }

  // Flush a final record with no trailing newline.
  if (started || field !== "" || cells.length > 0) pushRow();

  return rows;
}

// ---------------------------------------------------------------------------
// Header mapping.

/** The member fields an import can populate — the `MemberInput` keys. */
export type ImportColumn = keyof MemberInput;

/**
 * Accepted header spellings per column, normalised (lowercased, non-alphanumerics
 * stripped) so `"Full Name"`, `full_name` and `FULLNAME` all land on the same
 * key. Aliases cover what the common incumbents actually export.
 */
const COLUMN_ALIASES: Record<ImportColumn, string[]> = {
  fullName: ["fullname", "name", "membername", "clientname", "client", "displayname"],
  email: ["email", "emailaddress", "mail", "contactemail"],
  phone: ["phone", "phonenumber", "mobile", "mobilenumber", "telephone", "tel", "contactnumber"],
  status: ["status", "memberstatus", "recordstatus"],
  membershipStatus: ["membershipstatus", "membership", "subscriptionstatus", "planstatus"],
  notes: ["notes", "note", "comments", "remarks"],
  photoUrl: ["photourl", "photo", "photolink", "avatar", "avatarurl", "imageurl"],
  emergencyContactName: [
    "emergencycontactname",
    "emergencycontact",
    "emergencyname",
    "nextofkin",
    "nextofkinname",
  ],
  emergencyContactPhone: [
    "emergencycontactphone",
    "emergencyphone",
    "emergencycontactnumber",
    "nextofkinphone",
  ],
};

/** Human labels for the preview's "columns we recognised" summary. */
export const COLUMN_LABELS: Record<ImportColumn, string> = {
  fullName: "Full name",
  email: "Email",
  phone: "Phone",
  status: "Status",
  membershipStatus: "Membership status",
  notes: "Notes",
  photoUrl: "Photo URL",
  emergencyContactName: "Emergency contact name",
  emergencyContactPhone: "Emergency contact phone",
};

function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Fold the status columns onto our vocabulary before validating.
 *
 * Exports write `Active`, `ACTIVE`, `Archived`, `Paused` — all of which mean
 * something we support but none of which match the CHECK constraint verbatim.
 * Rejecting an entire row over letter case would make the feature useless on
 * real data. Anything NOT in these tables is passed through untouched so
 * `validateMemberInput` still reports it as an invalid value rather than this
 * layer guessing.
 */
const STATUS_SYNONYMS: Record<string, string> = {
  active: "active",
  enabled: "active",
  current: "active",
  inactive: "inactive",
  disabled: "inactive",
  archived: "inactive",
  former: "inactive",
};

const MEMBERSHIP_SYNONYMS: Record<string, string> = {
  active: "active",
  current: "active",
  expired: "expired",
  lapsed: "expired",
  frozen: "frozen",
  paused: "frozen",
  suspended: "frozen",
  onhold: "frozen",
  cancelled: "cancelled",
  canceled: "cancelled",
  terminated: "cancelled",
};

function normaliseStatusCell(
  value: string | undefined,
  synonyms: Record<string, string>,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  // Blank means "not specified" — let validateMemberInput apply its default.
  if (trimmed === "") return undefined;
  const key = trimmed.toLowerCase().replace(/[^a-z]+/g, "");
  return synonyms[key] ?? trimmed;
}

const ALIAS_LOOKUP: Map<string, ImportColumn> = new Map(
  (Object.keys(COLUMN_ALIASES) as ImportColumn[]).flatMap((key) =>
    COLUMN_ALIASES[key].map((alias) => [alias, key] as const),
  ),
);

export type MappedColumn = { column: ImportColumn; header: string; index: number };

/**
 * Map header cells onto member fields. The first header that claims a column
 * wins; later duplicates are reported as ignored rather than silently
 * overwriting (two "Phone" columns is a real export quirk, and picking the
 * wrong one would be invisible).
 */
export function mapHeaders(headers: string[]): {
  mapped: MappedColumn[];
  ignored: string[];
} {
  const mapped: MappedColumn[] = [];
  const ignored: string[] = [];
  const claimed = new Set<ImportColumn>();

  headers.forEach((header, index) => {
    const key = ALIAS_LOOKUP.get(normaliseHeader(header));
    if (key && !claimed.has(key)) {
      claimed.add(key);
      mapped.push({ column: key, header: header.trim(), index });
    } else if (header.trim() !== "") {
      ignored.push(header.trim());
    }
  });

  return { mapped, ignored };
}

// ---------------------------------------------------------------------------
// Preview.

/** A row that validated cleanly and is ready to insert. */
export type ImportRow = { line: number; input: MemberInput };

/** A row that will NOT be imported, with the reason shown to staff. */
export type ImportIssue = { line: number; label: string; message: string };

export type ImportPreview =
  | { ok: false; error: string }
  | {
      ok: true;
      delimiter: CsvDelimiter;
      mapped: MappedColumn[];
      ignored: string[];
      rows: ImportRow[];
      issues: ImportIssue[];
    };

/**
 * Parse + validate a whole CSV file into an importable preview.
 *
 * Fatal problems (empty file, oversized file, no header row, no recognisable
 * name column) return `ok: false` with a message a gym owner can act on. Per-row
 * problems never abort the import: the bad rows are listed as issues and the
 * good rows still go in, because "fix one typo, re-upload all 600 rows" is how
 * imports get abandoned.
 *
 * Duplicate emails inside the file are rejected on the second occurrence so one
 * upload can't create two records for the same person. Rows without an email
 * can't be de-duplicated and are all kept.
 */
export function parseMemberCsv(text: string): ImportPreview {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, error: "That file is empty — export your members and try again." };
  }
  // Byte length, not code units: a UTF-8 file of Greek names is ~2 bytes/char.
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > IMPORT_MAX_BYTES) {
    return {
      ok: false,
      error: `That file is too large (${Math.round(bytes / 1000)} KB). The limit is ${IMPORT_MAX_BYTES / 1000} KB — split it into smaller files.`,
    };
  }

  const delimiter = sniffDelimiter(text);
  const records = parseCsvRows(text, delimiter);
  if (records.length === 0) {
    return { ok: false, error: "That file has no rows." };
  }

  const [header, ...dataRows] = records;
  const { mapped, ignored } = mapHeaders(header.cells);

  const nameColumn = mapped.find((m) => m.column === "fullName");
  if (!nameColumn) {
    return {
      ok: false,
      error:
        "No name column found. The first row must be a header row containing a " +
        '"Full name" column (also accepted: "Name", "Member name"). Found: ' +
        (header.cells.filter((c) => c !== "").join(", ") || "nothing") +
        ".",
    };
  }

  if (dataRows.length === 0) {
    return { ok: false, error: "That file has a header row but no members below it." };
  }
  if (dataRows.length > IMPORT_MAX_ROWS) {
    return {
      ok: false,
      error: `That file has ${dataRows.length} rows; the limit is ${IMPORT_MAX_ROWS} per import. Split it into smaller files.`,
    };
  }

  const rows: ImportRow[] = [];
  const issues: ImportIssue[] = [];
  /** email -> the line that first claimed it, for the duplicate message. */
  const seenEmails = new Map<string, number>();

  for (const record of dataRows) {
    const raw: Partial<Record<ImportColumn, string>> = {};
    for (const m of mapped) {
      raw[m.column] = record.cells[m.index] ?? "";
    }
    // Shown in the issue list so staff can find the row without counting lines.
    const label = raw.fullName?.trim() || raw.email?.trim() || "(blank row)";

    const parsed = validateMemberInput({
      ...raw,
      status: normaliseStatusCell(raw.status, STATUS_SYNONYMS),
      membershipStatus: normaliseStatusCell(raw.membershipStatus, MEMBERSHIP_SYNONYMS),
    });
    if (!parsed.ok) {
      issues.push({ line: record.line, label, message: parsed.error });
      continue;
    }

    const email = parsed.value.email;
    if (email) {
      const firstLine = seenEmails.get(email);
      if (firstLine !== undefined) {
        issues.push({
          line: record.line,
          label,
          message: `Duplicate email — the same address is already on line ${firstLine} of this file.`,
        });
        continue;
      }
      seenEmails.set(email, record.line);
    }

    rows.push({ line: record.line, input: parsed.value });
  }

  return { ok: true, delimiter, mapped, ignored, rows, issues };
}

/**
 * A ready-to-fill template, offered as a download on the import screen so staff
 * have a known-good shape to paste their data into. Column order matches the
 * order fields appear on the single-member form.
 */
export const SAMPLE_CSV = [
  "full_name,email,phone,status,membership_status,photo_url,emergency_contact_name,emergency_contact_phone,notes",
  'Jane Athlete,jane@example.com,+357 99 123456,active,active,,Maria Athlete,+357 99 654321,"Knee rehab — no deep squats"',
  "Andreas Pavlou,andreas@example.com,+357 96 445566,active,expired,,,,",
  "Elena Georgiou,,+357 97 112233,inactive,cancelled,,Nikos Georgiou,+357 97 998877,Moved abroad",
].join("\n");
