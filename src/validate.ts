// Lightweight request validation. The surface area is small; explicit checks
// give clearer error messages and avoid leaking parser internals on malformed
// input.

import type { AnalyzeRequest, Transaction, TransactionStatus, TransactionType } from "./types";

type Language = NonNullable<AnalyzeRequest["language"]>;
type Channel = NonNullable<AnalyzeRequest["channel"]>;
type UserType = NonNullable<AnalyzeRequest["user_type"]>;

// Allow-lists as Sets for O(1) lookup. The joined string is cached so error
// messages don't rebuild it on every miss.
const VALID_CHANNELS = new Set<Channel>([
  "in_app_chat",
  "call_center",
  "email",
  "merchant_portal",
  "field_agent",
]);
const VALID_USER_TYPES = new Set<UserType>(["customer", "merchant", "agent", "unknown"]);
const VALID_LANGUAGES = new Set<Language>(["en", "bn", "mixed"]);
const VALID_TXN_TYPES = new Set<TransactionType>([
  "transfer",
  "payment",
  "cash_in",
  "cash_out",
  "settlement",
  "refund",
]);
const VALID_TXN_STATUSES = new Set<TransactionStatus>([
  "completed",
  "failed",
  "pending",
  "reversed",
]);

// Pre-rendered error message suffixes (avoids re-joining the array per request).
const ALLOWED_CHANNELS = [...VALID_CHANNELS].join(", ");
const ALLOWED_USER_TYPES = [...VALID_USER_TYPES].join(", ");
const ALLOWED_LANGUAGES = [...VALID_LANGUAGES].join(", ");
const ALLOWED_TXN_TYPES = [...VALID_TXN_TYPES].join(", ");
const ALLOWED_TXN_STATUSES = [...VALID_TXN_STATUSES].join(", ");

export interface ValidationOk {
  ok: true;
  value: AnalyzeRequest;
}
export interface ValidationErr {
  ok: false;
  status: 400 | 422;
  error: string;
}
export type ValidationResult = ValidationOk | ValidationErr;

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Returns [ok, status, error] instead of throwing — avoids throw/catch stack
// trace allocations on the hot validation path. Most valid requests skip this
// branch entirely. Optional: `undefined` is treated as a valid absent value.
function checkEnum<T extends string>(
  field: string,
  raw: unknown,
  allowed: Set<T>,
  allowedList: string
): { ok: true; value: T | undefined } | { ok: false; status: 400; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string" || !allowed.has(raw as T)) {
    return { ok: false, status: 400, error: `Invalid '${field}'. Allowed: ${allowedList}.` };
  }
  return { ok: true, value: raw as T };
}

function err(status: 400 | 422, message: string): ValidationErr {
  return { ok: false, status, error: message };
}

export function validateAnalyzeRequest(body: unknown): ValidationResult {
  if (!isObj(body)) return err(400, "Request body must be a JSON object.");

  const ticket_id = body.ticket_id;
  const complaint = body.complaint;
  if (typeof ticket_id !== "string") return err(400, "Missing or invalid required field 'ticket_id'.");
  const trimmedTicket = ticket_id.trim();
  if (trimmedTicket.length === 0) return err(400, "Missing or invalid required field 'ticket_id'.");
  if (typeof complaint !== "string") return err(400, "Missing or invalid required field 'complaint'.");
  const trimmedComplaint = complaint.trim();
  if (trimmedComplaint.length === 0) return err(400, "Missing or invalid required field 'complaint'.");
  if (trimmedComplaint.length < 3) return err(422, "'complaint' is too short to be meaningful.");

  const languageRaw = checkEnum("language", body.language, VALID_LANGUAGES, ALLOWED_LANGUAGES);
  if (!languageRaw.ok) return languageRaw;
  const channelRaw = checkEnum("channel", body.channel, VALID_CHANNELS, ALLOWED_CHANNELS);
  if (!channelRaw.ok) return channelRaw;
  const userTypeRaw = checkEnum("user_type", body.user_type, VALID_USER_TYPES, ALLOWED_USER_TYPES);
  if (!userTypeRaw.ok) return userTypeRaw;

  const txResult = readTransactionHistory(body.transaction_history);
  if (!txResult.ok) return txResult;

  const campaign_context =
    typeof body.campaign_context === "string" ? body.campaign_context : undefined;
  const metadata = isObj(body.metadata) ? body.metadata : undefined;

  return {
    ok: true,
    value: {
      ticket_id: trimmedTicket,
      complaint,
      language: languageRaw.value,
      channel: channelRaw.value,
      user_type: userTypeRaw.value,
      campaign_context,
      transaction_history: txResult.value,
      metadata,
    },
  };
}

function readTransactionHistory(
  raw: unknown
): { ok: true; value: Transaction[] | undefined } | ValidationErr {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return err(400, "'transaction_history' must be an array.");
  const txns: Transaction[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!isObj(t)) return err(400, `transaction_history[${i}] must be an object.`);
    if (typeof t.transaction_id !== "string")
      return err(400, `transaction_history[${i}].transaction_id must be a string.`);
    if (typeof t.timestamp !== "string")
      return err(400, `transaction_history[${i}].timestamp must be an ISO 8601 string.`);
    if (typeof t.type !== "string" || !VALID_TXN_TYPES.has(t.type as TransactionType))
      return err(400, `transaction_history[${i}].type is invalid.`);
    if (typeof t.amount !== "number" || !Number.isFinite(t.amount))
      return err(400, `transaction_history[${i}].amount must be a number.`);

    let status: TransactionStatus;
    if (t.status === undefined) {
      status = "completed";
    } else {
      if (typeof t.status !== "string" || !VALID_TXN_STATUSES.has(t.status as TransactionStatus))
        return err(400, `Invalid 'transaction_history[${i}].status'. Allowed: ${ALLOWED_TXN_STATUSES}.`);
      status = t.status as TransactionStatus;
    }

    txns.push({
      transaction_id: t.transaction_id,
      timestamp: t.timestamp,
      type: t.type as TransactionType,
      amount: t.amount,
      counterparty: typeof t.counterparty === "string" ? t.counterparty : undefined,
      status,
    });
  }
  return { ok: true, value: txns };
}