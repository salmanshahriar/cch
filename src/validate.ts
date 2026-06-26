// Lightweight request validation. The surface area is small; explicit checks
// give clearer error messages and avoid leaking parser internals on malformed
// input.

import type { AnalyzeRequest, Transaction, TransactionStatus, TransactionType } from "./types";

type Language = NonNullable<AnalyzeRequest["language"]>;
type Channel = NonNullable<AnalyzeRequest["channel"]>;
type UserType = NonNullable<AnalyzeRequest["user_type"]>;

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

function readEnum<T extends string>(
  field: string,
  raw: unknown,
  allowed: Set<T>
): T {
  if (typeof raw !== "string" || !allowed.has(raw as T)) {
    throw new ValidationError(400, `Invalid '${field}'. Allowed: ${[...allowed].join(", ")}.`);
  }
  return raw as T;
}

function readOptionalEnum<T extends string>(
  field: string,
  raw: unknown,
  allowed: Set<T>
): T | undefined {
  if (raw === undefined) return undefined;
  return readEnum(field, raw, allowed);
}

class ValidationError extends Error {
  constructor(public status: 400 | 422, message: string) {
    super(message);
  }
}

export function validateAnalyzeRequest(body: unknown): ValidationResult {
  try {
    if (!isObj(body)) throw new ValidationError(400, "Request body must be a JSON object.");
    const { ticket_id, complaint } = body;

    if (typeof ticket_id !== "string" || ticket_id.trim().length === 0)
      throw new ValidationError(400, "Missing or invalid required field 'ticket_id'.");
    if (typeof complaint !== "string" || complaint.trim().length === 0)
      throw new ValidationError(400, "Missing or invalid required field 'complaint'.");
    if (complaint.trim().length < 3)
      throw new ValidationError(422, "'complaint' is too short to be meaningful.");

    const language = readOptionalEnum("language", body.language, VALID_LANGUAGES);
    const channel = readOptionalEnum("channel", body.channel, VALID_CHANNELS);
    const user_type = readOptionalEnum("user_type", body.user_type, VALID_USER_TYPES);

    const transaction_history = readTransactionHistory(body.transaction_history);

    const campaign_context =
      typeof body.campaign_context === "string" ? body.campaign_context : undefined;
    const metadata = isObj(body.metadata) ? body.metadata : undefined;

    const out: AnalyzeRequest = {
      ticket_id: ticket_id.trim(),
      complaint,
      language,
      channel,
      user_type,
      campaign_context,
      transaction_history,
      metadata,
    };
    return { ok: true, value: out };
  } catch (e) {
    if (e instanceof ValidationError) return { ok: false, status: e.status, error: e.message };
    throw e;
  }
}

function readTransactionHistory(raw: unknown): Transaction[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw))
    throw new ValidationError(400, "'transaction_history' must be an array.");
  const txns: Transaction[] = [];
  raw.forEach((t, i) => {
    if (!isObj(t))
      throw new ValidationError(400, `transaction_history[${i}] must be an object.`);
    if (typeof t.transaction_id !== "string")
      throw new ValidationError(400, `transaction_history[${i}].transaction_id must be a string.`);
    if (typeof t.timestamp !== "string")
      throw new ValidationError(400, `transaction_history[${i}].timestamp must be an ISO 8601 string.`);
    if (typeof t.type !== "string" || !VALID_TXN_TYPES.has(t.type as TransactionType))
      throw new ValidationError(400, `transaction_history[${i}].type is invalid.`);
    if (typeof t.amount !== "number" || !Number.isFinite(t.amount))
      throw new ValidationError(400, `transaction_history[${i}].amount must be a number.`);
    const status =
      t.status === undefined
        ? "completed" as TransactionStatus
        : readEnum(`transaction_history[${i}].status`, t.status, VALID_TXN_STATUSES);
    txns.push({
      transaction_id: t.transaction_id,
      timestamp: t.timestamp,
      type: t.type as TransactionType,
      amount: t.amount,
      counterparty: typeof t.counterparty === "string" ? t.counterparty : undefined,
      status,
    });
  });
  return txns;
}