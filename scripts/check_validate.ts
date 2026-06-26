// Edge-case parity for validation: invalid inputs should produce equivalent
// error responses.
import { validateAnalyzeRequest } from "../src/validate";

const cases: { name: string; input: unknown }[] = [
  { name: "non-object", input: "string" },
  { name: "null", input: null },
  { name: "missing ticket_id", input: { complaint: "hello" } },
  { name: "empty ticket_id", input: { ticket_id: "  ", complaint: "hello" } },
  { name: "missing complaint", input: { ticket_id: "T-1" } },
  { name: "short complaint", input: { ticket_id: "T-1", complaint: "hi" } },
  { name: "bad language", input: { ticket_id: "T-1", complaint: "hello world", language: "fr" } },
  { name: "bad channel", input: { ticket_id: "T-1", complaint: "hello world", channel: "twitter" } },
  { name: "bad user_type", input: { ticket_id: "T-1", complaint: "hello world", user_type: "admin" } },
  { name: "bad txn type", input: { ticket_id: "T-1", complaint: "hello world", transaction_history: [{ transaction_id: "x", timestamp: "2026-01-01", type: "weird", amount: 1 }] } },
  { name: "bad txn status", input: { ticket_id: "T-1", complaint: "hello world", transaction_history: [{ transaction_id: "x", timestamp: "2026-01-01", type: "transfer", amount: 1, status: "weird" }] } },
  { name: "txn not array", input: { ticket_id: "T-1", complaint: "hello world", transaction_history: "not an array" } },
  { name: "txn not object", input: { ticket_id: "T-1", complaint: "hello world", transaction_history: ["not an object"] } },
];

for (const c of cases) {
  const r = validateAnalyzeRequest(c.input);
  console.log(c.name.padEnd(20), "ok=" + r.ok, "status=" + (r.ok ? "-" : r.status), "error=" + (r.ok ? "-" : r.error));
}