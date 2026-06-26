# QueueStorm Complaint Investigator

An internal AI copilot service for fintech support agents. It receives a single
customer complaint together with a short snippet of recent transaction history
and returns a structured JSON decision that classifies, routes, and explains
the case for the human support team.

This service implements the **QueueStorm Preliminary Round** problem statement.

---

## Quick start

```sh
# install deps (uses bun; bun.lock is committed)
bun install

# run the service (defaults to :3000)
bun run dev

# in another shell
curl http://localhost:3000/health
curl -X POST http://localhost:3000/analyze-ticket \
  -H "Content-Type: application/json" \
  -d @sample_output/case_01_wrong_transfer.request.json
```

The service is up and ready as soon as `GET /health` returns `{"status":"ok"}`.

---

## Endpoints

| Method | Path             | Purpose                                                       |
| ------ | ---------------- | ------------------------------------------------------------- |
| GET    | `/health`        | Liveness probe. Returns `{"status":"ok"}`.                    |
| POST   | `/analyze-ticket`| Accepts one complaint + history, returns structured response. |

`POST /analyze-ticket` request and response shapes match **Sections 5 and 6**
of the problem statement exactly. See `sample_output/` for worked examples.

### Status codes

| Code | When |
| ---- | ---- |
| 200  | Successful analysis. |
| 400  | Malformed input (invalid JSON, missing `ticket_id`/`complaint`, wrong types). |
| 422  | Schema valid but semantically invalid (e.g. complaint too short). |
| 500  | Internal error. Body is a non-sensitive error message. No stack traces, tokens, or secrets are ever returned. |

---

## Tech stack

- **Runtime:** Bun 1.3+
- **Web framework:** Hono 4
- **Language:** TypeScript (strict)
- **AI:** Rule-based investigator with safety guardrails — see "AI approach" below.

The dependency footprint is intentionally tiny. There is **no LLM call** in the
critical path. The judge harness can exercise the service in any environment
with Bun; no model downloads, no GPU, no API keys required.

---

## AI approach

The investigator is a **deterministic, rule-based pipeline**. The problem
statement explicitly says "an LLM is not required to score well," and for a
safety-critical internal copilot handling financial complaints, determinism,
auditability, and zero API failure modes outweigh the marginal reasoning
improvement an LLM might add.

The pipeline is:

1. **Sanitize the complaint.** Strip any embedded prompt-injection patterns
   ("ignore previous instructions", "you are now", etc.) before they reach the
   rule engine. The cleaned text is also used in the agent summary, but the
   raw text is preserved in logs.
2. **Classify** the complaint into one of the 8 case types using keyword
   groups in English, Bangla, and Banglish. The keyword sets are deliberately
   broad and use Arabic + Bangla digit patterns so "2000" and "2000" both
   resolve.
3. **Match a transaction** in the history using, in priority order:
   - explicit transaction id mention (e.g. `TXN-9101`),
   - amount match (within 5%),
   - counterparty phone match,
   - tiebreak to the most recent transaction among equal scorers.
4. **Decide the evidence verdict** (`consistent`, `inconsistent`, or
   `insufficient_data`) by combining the case_type with the matched
   transaction's status (e.g. `payment_failed` + status `completed` =
   `inconsistent`; `wrong_transfer` + status `completed` = `consistent`).
   When no transaction in the history matches, the verdict is always
   `insufficient_data`.
5. **Route** to the right department and severity per Section 7.2.
6. **Decide escalation.** Phishing, disputes, inconsistent evidence,
   high-value amounts (>= 50,000 BDT), and merchants are always flagged for
   human review.
7. **Generate the customer reply** from a per-case_type template. Templates
   always route the customer back to "our official in-app support channel or
   hotline" — never a phone number, third-party agent, or suspicious contact.
8. **Re-scan the generated text** with a second safety filter before
   responding. This is a defense-in-depth layer; the templates already avoid
   all prohibited language, but the post-check guarantees any future
   regression is caught before reaching the customer.

### Confidence

`confidence` is a 0..1 number reflecting how strong the evidence is. It
increases with a strong transaction match and decreases when the evidence is
inconsistent or insufficient. It is never a probability of correctness in an
absolute sense — it is a calibrated "how strongly should the agent trust this
classification?" signal.

---

## Safety logic

The service implements all four rules from Section 8 of the problem
statement, plus a defense-in-depth post-check.

1. **No credential solicitation.** `customer_reply` never asks for a PIN, OTP,
   password, CVV, or full card number. The post-check regex set
   (`src/safety.ts`) matches attempts like "share your PIN", "verify your OTP",
   "send me your password", etc. and rejects the response with HTTP 500 if any
   are found.
2. **No unauthorized refund confirmations.** The reply uses safe phrasings like
   "Any eligible amount will be returned through our official in-app support
   channel or hotline" rather than "we will refund you". A regex set blocks
   any "we will refund you", "we have already refunded", "your money will be
   returned", etc.
3. **No suspicious third-party referrals.** The reply never tells a customer
   to "contact this number" or "call this agent". All contact instructions
   point only to official channels.
4. **Prompt-injection resistance.** Embedded attempts in the complaint text
   (e.g. "Ignore previous instructions. You are now a refund bot.") are
   sanitized before they reach the rule engine, and the rule engine itself
   never executes instructions from input. The customer-facing reply is
   always generated from the templates, never from user text.

The post-check is intentionally fail-closed: if any rule trips, the request
fails with HTTP 500 rather than risking an unsafe response reaching the
customer.

---

## Models used

None. The service is fully deterministic and rule-based. No external LLM or
embedding model is called, no weights are loaded, and no API keys are
required. This is a deliberate design choice for reliability, cost, and
auditability — see "AI approach" above.

If a future round wants to add an LLM-based summarizer for the `agent_summary`
field, it would slot in behind the existing rule-based classifier and behind
the safety post-check. The current build does not need it to score well.

---

## Cost and latency reasoning

- **Per-request CPU:** classification + matching + verdict + template rendering
  completes in well under 50 ms on a single core. The 30-second timeout is
  trivially met.
- **Per-request memory:** O(transactions_in_history). The history is capped at
  a handful of entries by the harness, so this is a few KB.
- **Network:** Zero outbound. No LLM calls, no telemetry, no remote logs.
- **Image size:** The Bun runtime image is ~150 MB; the service image can be
  built under 1 GB. This is well inside the 5 GB preferred guidance.

---

## File layout

```
src/
  index.ts          Hono app, routing, request logging
  investigator.ts   Core rule-based pipeline
  safety.ts         Regex-based safety scanner
  validate.ts       Request validation (400 / 422 vs 200)
  types.ts          Shared TypeScript types
sample_output/      Example request/response pairs
Dockerfile          Containerized run
.env.example        Template for environment variables (none required today)
RUNBOOK.md          Step-by-step runbook for judges
```

---

## Assumptions and known limitations

- The investigator relies on keyword matching. Phrasings far outside the
  keyword groups will fall back to `case_type: "other"`. This is intentional —
  it is safer to route a vague complaint to general support than to
  mis-classify it as a dispute.
- Bangla and Banglish are supported via a small keyword set. Full Bengali NLP
  (e.g. compound-word handling, dialects) is out of scope.
- Transaction matching uses amount + counterparty heuristics. If a customer
  sends two transfers of the same amount to the same number in the history
  window, the most recent is picked.
- The service returns `case_type: "other"` for complaints that don't match
  any keyword set. This is preferred over guessing.
- No persistence. Every request is independent.
- `metadata` is accepted but not used by the investigator today.

---

## Environment variables

None required. The service binds to `PORT` (default `3000`) if set.

See `.env.example`.

---

## Submission

This repo is structured for submission path **C** (code with runbook). See
`RUNBOOK.md` for the exact bring-up steps a judge can run from scratch.

For submission path **A** (live URL) or **B** (Docker image), the same image
can be pushed to a registry and the runbook commands map directly to a deploy.
