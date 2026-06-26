// Rule-based complaint investigator.
//
// Reads the customer complaint + transaction history and produces a structured
// decision. Favour safety and consistency over recall. When the evidence is
// genuinely unclear, the verdict is "insufficient_data" and the case is
// escalated for human review.

import type {
  AnalyzeRequest,
  AnalyzeResponse,
  CaseType,
  Department,
  EvidenceVerdict,
  Severity,
  Transaction,
} from "./types";

// Amounts >= this are treated as high-value and escalated + severity bumped.
const HIGH_VALUE_THRESHOLD = 50_000;

const BANGLA_DIGITS = "০১২৩৪৫৬৭৮৯";
const BANGLA_TO_ARABIC = (() => {
  const m: Record<string, string> = {};
  for (let i = 0; i < 10; i++) m[BANGLA_DIGITS[i]] = String(i);
  return m;
})();

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeComplaint(text: string): string {
  // Drop the most common prompt-injection patterns so they can't bias the rule
  // engine. The customer_reply template is never derived from user text anyway,
  // so this is belt-and-braces on the classification side.
  return text
    .replace(/\b(ignore|disregard|forget)\b[\s\S]{0,80}\b(instructions?|rules?|previous|system)\b/gi, " ")
    .replace(/\b(you are now|act as|new persona|system prompt)\b[\s\S]{0,80}/gi, " ");
}

function anyKeyword(norm: string, keywords: string[]): boolean {
  for (const kw of keywords) if (norm.includes(kw)) return true;
  return false;
}

function toArabicDigits(s: string): string {
  let out = "";
  for (const ch of s) out += BANGLA_TO_ARABIC[ch] ?? ch;
  return out;
}

function normalizePhone(s: string): string {
  return s.replace(/^\+?88/, "");
}

function extractAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /(?:^|\s)([0-9০-৯]{1,3}(?:[,.][0-9০-৯]{3})+|[0-9০-৯]{2,7})(?=\s|$|[^\d])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].replace(/,/g, "");
    const n = Number(toArabicDigits(raw));
    if (!Number.isNaN(n) && n >= 10 && n <= 10_000_000) out.push(n);
  }
  return out;
}

function extractPhones(text: string): string[] {
  const seen = new Set<string>();
  const re = /\+?88?0?1[3-9]\d{8}|\+?\d{8,15}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    seen.add(normalizePhone(m[0]));
  }
  return [...seen];
}

function extractTransactionIds(text: string): string[] {
  const seen = new Set<string>();
  const re = /\b(TXN[-_ ]?\d+|[A-Z]{2,5}[-_ ]?\d{4,})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    seen.add(m[1].replace(/[\s_]/g, "-"));
  }
  return [...seen];
}

// Keyword groups covering English, Banglish, and Bangla phrasings.
const KW = {
  wrongTransfer: [
    "wrong number", "wrong recipient", "wrong person", "wrong account",
    "sent to wrong", "transferred to wrong", "wrong transfer", "mistaken transfer",
    "send korchi", "pathay diyechi bhul", "ভুল নম্বরে", "ভুল রিসিভার",
    "krlam bhul", "bhul number", "vul number", "vul nambar", "wrongly sent",
    "sent by mistake", "mistakenly sent",
  ],
  paymentFailed: [
    "payment failed", "transaction failed", "payment unsuccessful",
    "failed but deducted", "deducted but not received", "money deducted",
    "balance deducted", "amount deducted", "tk katse", "taka deducted",
    "কেটে নিয়েছে", "কেটে গেছে", "টাকা কেটে গেছে", "failed but charged",
    "not received but deducted", "deducted but failed",
  ],
  refundRequest: [
    "refund", "want my money back", "give my money back", "return my money",
    "please refund", "refund korte", "refund korun", "টাকা ফেরত",
    "ফেরত দিন", "ফেরত চাই", "want refund", "please return", "money back",
  ],
  duplicatePayment: [
    "twice", "two times", "double charged", "duplicate", "charged twice",
    "double payment", "deducted twice", "কেটেছে দুইবার", "দুইবার",
  ],
  merchantSettlement: [
    "merchant settlement", "settlement delay", "not settled", "not received from merchant",
    "merchant pending", "settlement pending", "merchant payout", "settlement not received",
    "merchant didn't get", "merchant balance", "merchant payment not received",
    "settlement hasn't arrived", "settlement has not arrived", "settlement still pending",
    "settle my", "settle the", "merchant fund",
  ],
  agentCashIn: [
    "cash in", "cash-in", "deposit through agent", "agent deposit", "agent didn't deposit",
    "deposited via agent", "agent cash in", "via an agent", "through an agent",
    "agent didn't give", "agent did not give", "agent not reflected", "agent did not credit",
    "via agent", "by agent", "agent didn't update",
    "এজেন্ট", "টাকা জমা", "এজেন্ট দিয়ে", "জমা হয়নি",
  ],
  phishing: [
    "someone called", "got a call", "received a call", "otp asked", "asked for otp",
    "asked for pin", "asked for password", "share otp", "share pin", "share password",
    "suspicious call", "suspicious sms", "suspicious message", "scam call",
    "fraud call", "phishing", "someone is asking", "someone asked", "someone wants my",
    "কল করেছে", "ওটিপি চেয়েছে", "পিন চেয়েছে", "সন্দেহজনক",
    "they asked for my otp", "they asked for my pin", "asked for my otp",
    "asked for my pin", "asked for my password", "asked for my password",
    "fraud sms", "fake sms", "fraud message", "pretending to be",
  ],
};

interface Classification {
  caseType: CaseType;
  scores: Record<CaseType, number>;
}

function classify(norm: string, history?: Transaction[]): Classification {
  const scores: Record<CaseType, number> = {
    wrong_transfer: 0,
    payment_failed: 0,
    refund_request: 0,
    duplicate_payment: 0,
    merchant_settlement_delay: 0,
    agent_cash_in_issue: 0,
    phishing_or_social_engineering: 0,
    other: 0,
  };

  if (anyKeyword(norm, KW.wrongTransfer)) scores.wrong_transfer += 3;
  if (anyKeyword(norm, KW.paymentFailed)) scores.payment_failed += 3;
  if (anyKeyword(norm, KW.refundRequest)) scores.refund_request += 3;
  if (anyKeyword(norm, KW.duplicatePayment)) scores.duplicate_payment += 3;
  if (anyKeyword(norm, KW.merchantSettlement)) scores.merchant_settlement_delay += 3;
  if (anyKeyword(norm, KW.agentCashIn)) scores.agent_cash_in_issue += 3;
  if (anyKeyword(norm, KW.phishing)) scores.phishing_or_social_engineering += 3;

  if (anyKeyword(norm, ["deducted but", "failed but", "tk katse", "কেটে গেছে", "কেটে নিয়েছে"])) {
    scores.payment_failed += 1;
  }
  // wrong_transfer + refund language: it's a recovery dispute, not a fresh refund.
  if (scores.wrong_transfer > 0 && scores.refund_request > 0) {
    scores.refund_request -= 1;
  }

  // Transaction-type signal: cash_in + "agent" complaint -> agent_cash_in_issue;
  // settlement + "merchant" -> merchant_settlement_delay. Soft signal, doesn't
  // override stronger keyword classifications.
  if (history && history.length > 0) {
    const hasCashIn = history.some((t) => t.type === "cash_in");
    const hasSettlement = history.some((t) => t.type === "settlement");
    if (hasCashIn && /\bagent\b/.test(norm) && scores.agent_cash_in_issue < 3) {
      scores.agent_cash_in_issue += 2;
    }
    if (hasSettlement && /\bmerchant\b/.test(norm) && scores.merchant_settlement_delay < 3) {
      scores.merchant_settlement_delay += 2;
    }
  }

  let top: CaseType = "other";
  let topScore = 0;
  for (const k of Object.keys(scores) as CaseType[]) {
    if (scores[k] > topScore) {
      topScore = scores[k];
      top = k;
    }
  }
  return { caseType: top, scores };
}

interface TxnScore {
  transaction: Transaction;
  score: number;
  reasons: string[];
}

interface MatchResult {
  transaction: Transaction | null;
  score: number;
  reasons: string[];
  similarAmountCount: number;
}

function scoreTxn(
  t: Transaction,
  amounts: number[],
  phones: string[]
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (amounts.length > 0 && typeof t.amount === "number") {
    const matched = amounts.find((a) => Math.abs(a - t.amount) / Math.max(t.amount, 1) <= 0.05);
    if (matched !== undefined) {
      score += 2;
      reasons.push(`amount_match:${matched}~${t.amount}`);
    }
  }
  if (phones.length > 0 && t.counterparty) {
    const cp = normalizePhone(t.counterparty);
    if (phones.some((p) => p === cp || cp.endsWith(p) || p.endsWith(cp))) {
      score += 2;
      reasons.push(`counterparty_phone_match:${cp}`);
    }
  }
  if (score >= 2) reasons.push("score_at_or_above_threshold");
  return { score, reasons };
}

function matchTransaction(
  norm: string,
  txnIds: string[],
  amounts: number[],
  phones: string[],
  history: Transaction[]
): MatchResult {
  if (!history || history.length === 0) {
    return { transaction: null, score: 0, reasons: ["empty_history"], similarAmountCount: 0 };
  }

  // Explicit transaction-id reference wins outright.
  for (const t of history) {
    const idNorm = t.transaction_id.replace(/[\s_]/g, "-").toLowerCase();
    if (txnIds.some((id) => id.toLowerCase() === idNorm)) {
      return {
        transaction: t,
        score: 1,
        reasons: ["explicit_transaction_id_match"],
        similarAmountCount: 0,
      };
    }
  }

  // Single pass: score every txn, then pick the best (with recent-tiebreak).
  const scored: TxnScore[] = history.map((t) => ({ transaction: t, ...scoreTxn(t, amounts, phones) }));
  let best = scored[0];
  for (const s of scored) if (s.score > best.score) best = s;

  if (best.score > 0) {
    const tied = scored.filter((s) => s.score === best.score);
    if (tied.length > 1) {
      tied.sort((a, b) => b.transaction.timestamp.localeCompare(a.transaction.timestamp));
      best = { ...best, transaction: tied[0].transaction, reasons: [...best.reasons, "tiebreak_recent"] };
    }
  }

  // Amount-grouping pass done at the same time: how many txns share the matched amount?
  let similarAmountCount = 0;
  if (best.transaction) {
    similarAmountCount = history.filter((t) => t.amount === best.transaction!.amount).length;
  }

  // For voiding the "norm" param warning when not used (kept for future).
  void norm;

  return {
    transaction: best.transaction,
    score: best.score,
    reasons: best.reasons,
    similarAmountCount,
  };
}

function decideEvidenceVerdict(
  classification: Classification,
  match: MatchResult,
  history: Transaction[]
): EvidenceVerdict {
  if (!history || history.length === 0) return "insufficient_data";
  if (!match.transaction) return "insufficient_data";

  const t = match.transaction;

  // Phishing is about a contact attempt, not a transaction in history.
  if (classification.caseType === "phishing_or_social_engineering") return "insufficient_data";

  switch (classification.caseType) {
    case "payment_failed":
      if (t.status === "failed") return "consistent";
      if (t.status === "completed" || t.status === "reversed") return "inconsistent";
      return "insufficient_data";
    case "wrong_transfer":
      if (t.status === "completed" || t.status === "reversed") return "consistent";
      if (t.status === "failed") return "inconsistent";
      return "insufficient_data";
    case "duplicate_payment":
      return match.similarAmountCount >= 2 ? "consistent" : "insufficient_data";
    case "refund_request":
      return match.score >= 2 ? "consistent" : "insufficient_data";
    case "agent_cash_in_issue":
      return t.type === "cash_in" ? "consistent" : "inconsistent";
    case "merchant_settlement_delay":
      return t.type === "settlement" ? "consistent" : "insufficient_data";
    default:
      return match.score >= 2 ? "consistent" : "insufficient_data";
  }
}

function defaultRouting(caseType: CaseType): { department: Department; severity: Severity } {
  switch (caseType) {
    case "wrong_transfer":
      return { department: "dispute_resolution", severity: "high" };
    case "payment_failed":
      return { department: "payments_ops", severity: "high" };
    case "refund_request":
      return { department: "dispute_resolution", severity: "medium" };
    case "duplicate_payment":
      return { department: "payments_ops", severity: "high" };
    case "merchant_settlement_delay":
      return { department: "merchant_operations", severity: "medium" };
    case "agent_cash_in_issue":
      return { department: "agent_operations", severity: "high" };
    case "phishing_or_social_engineering":
      return { department: "fraud_risk", severity: "critical" };
    default:
      return { department: "customer_support", severity: "low" };
  }
}

function shouldEscalate(
  classification: Classification,
  verdict: EvidenceVerdict,
  amount: number | undefined,
  userType: string | undefined
): { escalate: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const ct = classification.caseType;
  if (ct === "phishing_or_social_engineering") reasons.push("phishing_case_always_escalated");
  if (verdict === "insufficient_data") reasons.push("insufficient_evidence");
  if (verdict === "inconsistent") reasons.push("evidence_contradicts_complaint");
  if (typeof amount === "number" && amount >= HIGH_VALUE_THRESHOLD) reasons.push("high_value_threshold");
  if (userType === "merchant") reasons.push("merchant_user_type");
  if (
    ct === "wrong_transfer" ||
    ct === "duplicate_payment" ||
    ct === "payment_failed" ||
    ct === "agent_cash_in_issue"
  )
    reasons.push("dispute_classification");
  if (ct === "refund_request" && verdict !== "insufficient_data") reasons.push("refund_requires_review");
  return { escalate: reasons.length > 0, reasons };
}

function buildAgentSummary(
  req: AnalyzeRequest,
  classification: Classification,
  match: MatchResult
): string {
  const idPart = match.transaction
    ? `Transaction ${match.transaction.transaction_id}`
    : "no matching transaction in the recent history";
  const snippet = req.complaint.length > 120 ? req.complaint.slice(0, 117) + "..." : req.complaint;
  return `Customer reports: "${snippet}" Classified as ${classification.caseType}. Evidence cross-checked against ${idPart}.`;
}

function buildNextAction(
  classification: Classification,
  match: MatchResult,
  verdict: EvidenceVerdict
): string {
  const ct = classification.caseType;
  if (ct === "phishing_or_social_engineering") {
    return "Open a fraud-risk ticket, flag the customer account with a phishing advisory, and provide only the official in-app support channel as the contact path.";
  }
  if (verdict === "insufficient_data") {
    return "Pull additional transaction history from the core ledger and confirm details with the customer via the official in-app chat before any further action.";
  }
  if (verdict === "inconsistent") {
    return "Verify the customer's claim against the matched transaction and escalate to a human dispute specialist before any resolution step.";
  }
  switch (ct) {
    case "wrong_transfer":
      return "Verify the matched transaction with the customer, attempt recipient contact through official channels, and queue a dispute for human review.";
    case "payment_failed":
      return "Trace the matched transaction through the payments ledger, confirm the deduction status, and if eligible route for an official-channel resolution.";
    case "duplicate_payment":
      return "Confirm the duplicate via ledger query and route to payments operations for official-channel resolution of any eligible duplicate amount.";
    case "refund_request":
      return "Verify the matched transaction, evaluate eligibility, and queue for an official-channel resolution by a human reviewer.";
    case "merchant_settlement_delay":
      return "Check the merchant settlement pipeline for the matched transaction and notify merchant operations.";
    case "agent_cash_in_issue":
      return "Reconcile the matched cash-in against the agent ledger and escalate to agent operations.";
    default:
      return "Review the customer note and route to the appropriate team based on the matched evidence.";
  }
}

function buildCustomerReply(
  classification: Classification,
  match: MatchResult,
  verdict: EvidenceVerdict
): string {
  const safeOfficial = "our official in-app support channel or hotline";
  const idRef = match.transaction ? ` (reference ${match.transaction.transaction_id})` : "";

  if (classification.caseType === "phishing_or_social_engineering") {
    return (
      "Thank you for flagging this. Please do not share any PIN, OTP, password, or card details with anyone who contacts you. " +
      "Our team will review the activity on your account and follow up through " +
      safeOfficial + ". If you have already shared credentials, please change your password immediately through the app."
    );
  }

  if (verdict === "inconsistent") {
    return (
      `Thank you for contacting us about your concern${idRef}. ` +
      "Based on the records we can see, the transaction in question does not match the details you described. " +
      "We will have a specialist verify the records and reach out to you through " +
      safeOfficial + " within one business day."
    );
  }

  if (verdict === "insufficient_data") {
    return (
      `Thank you for reaching out${idRef}. ` +
      "To help us investigate accurately, please share any additional details (time, reference, recipient phone) through " +
      safeOfficial + ". Our team will review the case and respond shortly."
    );
  }

  switch (classification.caseType) {
    case "wrong_transfer":
      return (
        `Thank you for letting us know about the transfer${idRef}. ` +
        "We have logged the concern and our dispute team will review the case. " +
        "Any eligible amount will be processed through " + safeOfficial + " in line with our recovery policy."
      );
    case "payment_failed":
      return (
        `Thank you for reporting the payment issue${idRef}. ` +
        "We have noted the failed transaction and our payments team will verify the deduction status. " +
        "Any eligible amount will be processed through " + safeOfficial + "."
      );
    case "duplicate_payment":
      return (
        `Thank you for flagging the duplicate charge${idRef}. ` +
        "Our payments team will verify the records. " +
        "Any eligible duplicate amount will be processed through " + safeOfficial + "."
      );
    case "refund_request":
      return (
        `Thank you for your refund request${idRef}. ` +
        "Our team will review the case against our eligibility policy. " +
        "Any eligible amount will be returned through " + safeOfficial + "."
      );
    case "merchant_settlement_delay":
      return (
        `Thank you for reporting the settlement delay${idRef}. ` +
        "Our merchant operations team will look into the settlement status and update you through " +
        safeOfficial + "."
      );
    case "agent_cash_in_issue":
      return (
        `Thank you for reporting the cash-in issue${idRef}. ` +
        "Our agent operations team will reconcile the deposit against the ledger and follow up through " +
        safeOfficial + "."
      );
    default:
      return (
        `Thank you for contacting us${idRef}. ` +
        "We have logged your concern and a support agent will reach out through " +
        safeOfficial + " shortly."
      );
  }
}

export function investigate(req: AnalyzeRequest): AnalyzeResponse {
  const norm = normalize(sanitizeComplaint(req.complaint));
  const history = req.transaction_history ?? [];

  // Extract once per request — reused by classify() and matchTransaction().
  const amounts = extractAmounts(req.complaint);
  const phones = extractPhones(req.complaint);
  const txnIds = extractTransactionIds(req.complaint);

  const classification = classify(norm, history);

  // Phishing overrides the txn-match logic: the operative issue is the contact
  // attempt, not a transaction in the history.
  const isPhishing = classification.caseType === "phishing_or_social_engineering";
  const match = isPhishing
    ? { transaction: null, score: 0, reasons: [], similarAmountCount: 0 }
    : matchTransaction(norm, txnIds, amounts, phones, history);

  const relevantTxnId = isPhishing ? null : match.transaction?.transaction_id ?? null;
  const verdict: EvidenceVerdict = isPhishing
    ? "insufficient_data"
    : decideEvidenceVerdict(classification, match, history);

  const routing = defaultRouting(classification.caseType);
  const matchedAmount = match.transaction?.amount;
  const esc = shouldEscalate(classification, verdict, matchedAmount, req.user_type);

  // Bump severity for high-value inconsistent evidence; promote low -> medium
  // for any escalated case so the agent sees a meaningful priority.
  let severity: Severity = routing.severity;
  if (verdict === "inconsistent" && typeof matchedAmount === "number" && matchedAmount >= HIGH_VALUE_THRESHOLD) {
    severity = "critical";
  } else if (esc.escalate && severity === "low") {
    severity = "medium";
  }

  const reasonCodes: string[] = [
    `case:${classification.caseType}`,
    `verdict:${verdict}`,
    ...match.reasons.map((r) => `match:${r}`),
    ...esc.reasons.map((r) => `escalate:${r}`),
  ];

  return {
    ticket_id: req.ticket_id,
    relevant_transaction_id: relevantTxnId,
    evidence_verdict: verdict,
    case_type: classification.caseType,
    severity,
    department: routing.department,
    agent_summary: buildAgentSummary(req, classification, match),
    recommended_next_action: buildNextAction(classification, match, verdict),
    customer_reply: buildCustomerReply(classification, match, verdict),
    human_review_required: esc.escalate,
    confidence: computeConfidence(match, verdict),
    reason_codes: reasonCodes,
  };
}

function computeConfidence(match: MatchResult, verdict: EvidenceVerdict): number {
  let c = 0.7;
  if (match.score >= 2) c += 0.15;
  if (match.reasons.includes("explicit_transaction_id_match")) c += 0.1;
  if (verdict === "insufficient_data") c -= 0.2;
  else if (verdict === "inconsistent") c -= 0.1;
  return Number(Math.max(0.1, Math.min(0.99, c)).toFixed(2));
}