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

# 3. Run the service
bun run dev
# -> investigator listening on :3000
```

The service binds to `PORT` if set, otherwise `3000`.

## Option B — Run via Docker

```sh
# 1. Build the image
docker build -t queuestorm-investigator:latest .

# 2. Run it
docker run --rm -p 3000:3000 queuestorm-investigator:latest
```

The Dockerfile is a multi-stage build that produces a slim image based on
the official Bun runtime.

## Smoke tests

```sh
# Health check
curl -s http://localhost:3000/health
# -> {"status":"ok"}

# Analyze a wrong-transfer ticket (uses a sample in this repo)
curl -s -X POST http://localhost:3000/analyze-ticket \
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

The service needs **no configuration**. Set `PORT` to override the default 3000:

```sh
PORT=8080 bun run dev
```

## Troubleshooting

- **Port already in use** — set `PORT=<other-port>` before running.
- **`/health` returns 200 but `/analyze-ticket` errors** — check the request body
  matches Section 5 of the problem statement. Missing `ticket_id` or
  `complaint` returns 400 with a non-sensitive error message.
- **Bun is missing** — `curl -fsSL https://bun.sh/install | bash` then reopen
  your shell, or use the Docker path.
