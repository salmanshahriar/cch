# Runbook — QueueStorm Complaint Investigator

A judge (or anyone else) should be able to copy-paste this runbook end-to-end
and bring the service up locally with no extra steps.

## Prerequisites

- **Bun 1.3+** — https://bun.sh (`curl -fsSL https://bun.sh/install | bash`)
- Alternatively, **Node 20+** + **Docker** (see the Docker section below).

## Option A — Run locally with Bun (fastest)

```sh
# 1. Clone the repo
git clone <repo-url>
cd cch

# 2. Install dependencies
bun install

# 3. Set the port (the service refuses to start without PORT set)
echo "PORT=8000" > .env

# 4. Run the service
bun run dev
# -> investigator listening on :8000
```

`PORT` is read from the environment. The service has **no built-in default**
for the port — it will fail loudly at startup if `PORT` is missing or invalid,
so a misconfigured deploy cannot silently bind to a different port.

You can override `PORT` at the shell level too:

```sh
PORT=9000 bun run dev
```

## Option B — Run via Docker

```sh
# 1. Build the image
docker build -t queuestorm-investigator:latest .

# 2. Run it (PORT must be supplied — there is no default)
docker run --rm -e PORT=8000 -p 8000:8000 queuestorm-investigator:latest
```

The Dockerfile is a multi-stage build that produces a slim image based on
the official Bun runtime.

## Smoke tests

```sh
# Health check
curl -s http://localhost:8000/health
# -> {"status":"ok"}

# Analyze a wrong-transfer ticket (uses a sample in this repo)
curl -s -X POST http://localhost:8000/analyze-ticket \
  -H "Content-Type: application/json" \
  -d @sample_output/case_01_wrong_transfer.request.json | python3 -m json.tool
```

Expected HTTP 200 with a body matching the schema in `sample_output/case_01_wrong_transfer.response.json`.

## Sample cases shipped with this repo

| File                                                | Demonstrates                                              |
| --------------------------------------------------- | --------------------------------------------------------- |
| `case_01_wrong_transfer`                            | Canonical example from the problem statement.             |
| `case_02_payment_failed_consistent`                 | Payment failed + amount matches + status `failed`.        |
| `case_03_payment_failed_inconsistent`               | Payment failed + status `completed` -> verdict `inconsistent`. |
| `case_04_phishing`                                  | Phishing case -> `critical`, no txn id, human review.     |
| `case_05_duplicate_payment`                         | Two same-amount payments -> `duplicate_payment`.          |
| `case_06_merchant_settlement_delay`                 | Merchant user + pending settlement.                       |
| `case_07_agent_cash_in_issue`                       | Agent cash-in complaint, txn type `cash_in`.              |
| `case_08_prompt_injection`                          | Adversarial complaint with embedded instructions.         |
| `case_09_bangla_complaint`                          | Bangla script complaint.                                  |
| `case_10_empty_history`                             | `insufficient_data` verdict path.                         |

Each file has both `.request.json` and `.response.json`.

## Configuration

The only required environment variable is `PORT`. Copy `.env.example` to
`.env` and edit, or pass `PORT=...` on the command line. The service will
exit with an error message at startup if `PORT` is missing, empty, or not
a valid integer in the range 1..65535.

## Troubleshooting

- **"Missing required env var 'PORT'"** — create `.env` with `PORT=8000` (or
  pass `PORT=...` on the command line). The service refuses to guess a default.
- **Port already in use** — change `PORT` to a free port and restart.
- **`/health` returns 200 but `/analyze-ticket` errors** — check the request body
  matches Section 5 of the problem statement. Missing `ticket_id` or
  `complaint` returns 400 with a non-sensitive error message.
- **Bun is missing** — `curl -fsSL https://bun.sh/install | bash` then reopen
  your shell, or use the Docker path.
