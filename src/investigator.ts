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

// ---------------------------------------------------------------------------
// Constants & precompiled patterns
// ---------------------------------------------------------------------------

// Amounts >= this are treated as high-value and escalated + severity bumped.
const HIGH_VALUE_THRESHOLD = 50_000;

const BANGLA_DIGITS = "০১২৩৪৫৬৭৮৯";
const BANGLA_TO_ARABIC: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (let i = 0; i < 10; i++) m[BANGLA_DIGITS[i]] = String(i);
  return m;
})();

// Precompiled regex objects (avoid re-creating inside hot functions).
const RE_QUOTES = /[\u2018\u2019\u201c\u201d]/g;
const RE_WS = /\s+/g;
const RE_AMOUNT = /(?:^|\s)([0-9০-৯]{1,3}(?:[,.][0-9০-৯]{3})+|[0-9০-৯]{2,7})(?=\s|$|[^\d])/g;
const RE_PHONE = /\+?88?0?1[3-9]\d{8}|\+?\d{8,15}/g;
const RE_TXN_ID = /\b(TXN[-_ ]?\d+|[A-Z]{2,5}[-_ ]?\d{4,})\b/g;
const RE_NORMALIZE_PHONE = /^\+?88/;
const RE_ID_NORMALIZE = /[\s_]/g;
const RE_INJECT_IGNORE = /\b(ignore|disregard|forget)\b[\s\S]{0,80}\b(instructions?|rules?|previous|system)\b/gi;
const RE_INJECT_PERSONA = /\b(you are now|act as|new persona|system prompt)\b[\s\S]{0,80}/gi;
const RE_AGENT_BONUS = /\bagent\b/;
const RE_MERCHANT_BONUS = /\bmerchant\b/;
const RE_DEDUCT_BONUS = /\b(?:deducted but|failed but|tk katse|কেটে গেছে|কেটে নিয়েছে)\b/;

// 5% amount tolerance for matching.
const AMOUNT_TOLERANCE = 0.05;

// ---------------------------------------------------------------------------
// Keyword groups — combined into one alternation regex per category, built
// once at module load. Alternation is longest-keyword-first so e.g. "asked for
// my otp" wins over "asked for otp".
// ---------------------------------------------------------------------------

// ASCII-only `\b` boundaries are very fast in V8 but don't cross into Bangla.
// Since Bangla keywords are multi-character strings that don't collide with
// ASCII substrings, we run the ASCII regex (fast path) plus a cheap substring
// scan for any Bangla keyword.
const RE_ASCII = {
  wrongTransfer:
    /\b(?:wrongly sent|sent by mistake|mistakenly sent|sent to wrong|transferred to wrong|wrong transfer|mistaken transfer|wrong number|wrong recipient|wrong person|wrong account|send korchi|pathay diyechi bhul|krlam bhul|bhul number|vul number|vul nambar)\b/,
  paymentFailed:
    /\b(?:payment failed|transaction failed|payment unsuccessful|failed but deducted|deducted but not received|money deducted|balance deducted|amount deducted|failed but charged|not received but deducted|deducted but failed|tk katse|taka deducted)\b/,
  refundRequest:
    /\b(?:want my money back|give my money back|return my money|please refund|refund korte|refund korun|want refund|please return|money back|refund)\b/,
  duplicatePayment:
    /\b(?:double charged|charged twice|double payment|deducted twice|two times|duplicate|twice)\b/,
  merchantSettlement:
    /\b(?:merchant settlement|settlement delay|not received from merchant|merchant pending|settlement pending|merchant payout|settlement not received|merchant didn't get|merchant balance|merchant payment not received|settlement hasn't arrived|settlement has not arrived|settlement still pending|merchant fund|settle my|settle the|not settled)\b/,
  agentCashIn:
    /\b(?:deposit through agent|agent deposit|agent didn't deposit|deposited via agent|agent cash in|via an agent|through an agent|agent didn't give|agent did not give|agent not reflected|agent did not credit|via agent|by agent|agent didn't update|cash-in|cash in)\b/,
  phishing:
    /\b(?:someone called|got a call|received a call|otp asked|asked for otp|asked for pin|asked for password|share otp|share pin|share password|suspicious call|suspicious sms|suspicious message|fraud call|fraud sms|fake sms|fraud message|pretending to be|scam call|someone is asking|someone asked|someone wants my|they asked for my otp|they asked for my pin|asked for my otp|asked for my pin|asked for my password|phishing)\b/,
} as const;

// Bangla substring lists — flat arrays scanned with indexOf (very fast).
const BANGLA: Record<keyof typeof RE_ASCII, readonly string[]> = {
  wrongTransfer: ["ভুল নম্বরে", "ভুল রিসিভার"],
  paymentFailed: ["কেটে নিয়েছে", "কেটে গেছে", "টাকা কেটে গেছে"],
  refundRequest: ["ফেরত দিন", "ফেরত চাই", "টাকা ফেরত"],
  duplicatePayment: ["কেটেছে দুইবার", "দুইবার"],
  merchantSettlement: [],
  agentCashIn: ["এজেন্ট দিয়ে", "জমা হয়নি", "এজেন্ট", "টাকা জমা"],
  phishing: ["কল করেছে", "ওটিপি চেয়েছে", "পিন চেয়েছে", "সন্দেহজনক"],
};

function anyBangla(text: string, list: readonly string[]): boolean {
  for (let i = 0; i < list.length; i++) if (text.indexOf(list[i]) !== -1) return true;
  return false;
}

function matchesCategory(norm: string, category: keyof typeof RE_ASCII): boolean {
  return RE_ASCII[category].test(norm) || anyBangla(norm, BANGLA[category]);
}

// Frozen verdict tables — single hash lookup beats switch statements.
const PAYMENT_FAILED_VERDICT: Record<Transaction["status"], EvidenceVerdict> = {
  failed: "consistent",
  completed: "inconsistent",
  reversed: "inconsistent",
  pending: "insufficient_data",
};
const WRONG_TRANSFER_VERDICT: Record<Transaction["status"], EvidenceVerdict> = {
  completed: "consistent",
  reversed: "consistent",
  failed: "inconsistent",
  pending: "insufficient_data",
};

interface Routing { department: Department; severity: Severity; }
const DEFAULT_ROUTING: Record<CaseType, Routing> = {
  wrong_transfer: { department: "dispute_resolution", severity: "high" },
  payment_failed: { department: "payments_ops", severity: "high" },
  refund_request: { department: "dispute_resolution", severity: "medium" },
  duplicate_payment: { department: "payments_ops", severity: "high" },
  merchant_settlement_delay: { department: "merchant_operations", severity: "medium" },
  agent_cash_in_issue: { department: "agent_operations", severity: "high" },
  phishing_or_social_engineering: { department: "fraud_risk", severity: "critical" },
  other: { department: "customer_support", severity: "low" },
};

// Constant strings reused by every reply builder — avoids repeated allocation.
const SAFE_OFFICIAL = "our official in-app support channel or hotline";
const SNIPPET_MAX = 120;
const SNIPPET_KEEP = 117;
const ELLIPSIS = "...";

// Pre-computed reason-code constants.
const REASON_EXPLICIT = "explicit_transaction_id_match";
const REASON_SCORE_OK = "score_at_or_above_threshold";
const REASON_TIEBREAK = "tiebreak_recent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(RE_QUOTES, "'")
    .replace(RE_WS, " ")
    .trim();
}

function sanitizeComplaint(text: string): string {
  // Drop the most common prompt-injection patterns so they can't bias the rule
  // engine. The customer_reply template is never derived from user text anyway,
  // so this is belt-and-braces on the classification side.
  return text.replace(RE_INJECT_IGNORE, " ").replace(RE_INJECT_PERSONA, " ");
}

function normalizePhone(s: string): string {
  return s.replace(RE_NORMALIZE_PHONE, "");
}

// Digit-by-digit conversion (faster than regex-replace + Number() + toArabic).
// BANGLA_TO_ARABIC maps to strings, so we coerce via +d to keep n numeric.
function extractAmounts(text: string, out: number[]): void {
  RE_AMOUNT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_AMOUNT.exec(text)) !== null) {
    const raw = m[1];
    let n = 0;
    let hasDigit = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === ",") continue;
      // ASCII 0-9 -> charcode - 48 (already a number); Bangla -> map value (string).
      const d = ch >= "0" && ch <= "9" ? ch.charCodeAt(0) - 48 : BANGLA_TO_ARABIC[ch];
      if (d !== undefined) {
        n = n * 10 + (+d);
        hasDigit = true;
      }
    }
    if (hasDigit && n >= 10 && n <= 10_000_000) out.push(n);
  }
}

function extractPhones(text: string, sink: string[]): void {
  // Inline set-based dedupe so we don't allocate a Set+spread every call.
  RE_PHONE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_PHONE.exec(text)) !== null) {
    const norm = normalizePhone(m[0]);
    if (sink.indexOf(norm) === -1) sink.push(norm);
  }
}

function extractTransactionIds(text: string, sink: string[]): void {
  RE_TXN_ID.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_TXN_ID.exec(text)) !== null) {
    const id = m[1].replace(RE_ID_NORMALIZE, "-");
    if (sink.indexOf(id) === -1) sink.push(id);
  }
}

// ---------------------------------------------------------------------------
// Classification & matching
// ---------------------------------------------------------------------------

interface Classification {
  caseType: CaseType;
  scores: Record<CaseType, number>;
}

// Reusable zeroed score object — avoids per-call allocation.
function emptyScores(): Record<CaseType, number> {
  return {
    wrong_transfer: 0,
    payment_failed: 0,
    refund_request: 0,
    duplicate_payment: 0,
    merchant_settlement_delay: 0,
    agent_cash_in_issue: 0,
    phishing_or_social_engineering: 0,
    other: 0,
  };
}

function classify(norm: string, hasCashIn: boolean, hasSettlement: boolean): Classification {
  const scores = emptyScores();

  if (matchesCategory(norm, "wrongTransfer")) scores.wrong_transfer += 3;
  if (matchesCategory(norm, "paymentFailed")) scores.payment_failed += 3;
  if (matchesCategory(norm, "refundRequest")) scores.refund_request += 3;
  if (matchesCategory(norm, "duplicatePayment")) scores.duplicate_payment += 3;
  if (matchesCategory(norm, "merchantSettlement")) scores.merchant_settlement_delay += 3;
  if (matchesCategory(norm, "agentCashIn")) scores.agent_cash_in_issue += 3;
  if (matchesCategory(norm, "phishing")) scores.phishing_or_social_engineering += 3;

  if (RE_DEDUCT_BONUS.test(norm)) scores.payment_failed += 1;

  // wrong_transfer + refund language: it's a recovery dispute, not a fresh refund.
  if (scores.wrong_transfer > 0 && scores.refund_request > 0) {
    scores.refund_request -= 1;
  }

  // Transaction-type signal: cash_in + "agent" complaint -> agent_cash_in_issue;
  // settlement + "merchant" -> merchant_settlement_delay. Soft signal, doesn't
  // override stronger keyword classifications.
  if (hasCashIn && RE_AGENT_BONUS.test(norm) && scores.agent_cash_in_issue < 3) {
    scores.agent_cash_in_issue += 2;
  }
  if (hasSettlement && RE_MERCHANT_BONUS.test(norm) && scores.merchant_settlement_delay < 3) {
    scores.merchant_settlement_delay += 2;
  }

  let top: CaseType = "other";
  let topScore = 0;
  for (const k in scores) {
    const v = scores[k as CaseType];
    if (v > topScore) {
      topScore = v;
      top = k as CaseType;
    }
  }
  return { caseType: top, scores };
}

interface MatchResult {
  transaction: Transaction | null;
  score: number;
  reasons: string[];
  similarAmountCount: number;
}

// Frozen empty match used by the phishing shortcut — identical to what HEAD
// produced inline.
const EMPTY_MATCH: MatchResult = {
  transaction: null,
  score: 0,
  reasons: [],
  similarAmountCount: 0,
};

function emptyHistoryMatch(): MatchResult {
  return { transaction: null, score: 0, reasons: ["empty_history"], similarAmountCount: 0 };
}

interface ScoredTxn {
  transaction: Transaction;
  score: number;
  reasons: string[];
}

function matchTransaction(
  txnIds: string[],
  amounts: number[],
  phones: string[],
  history: Transaction[]
): MatchResult {
  const historyLen = history.length;
  if (historyLen === 0) return emptyHistoryMatch();

  // Explicit transaction-id reference wins outright. Build a lowercase set
  // from the request-side ids so the txn-side compare is O(1).
  const txnIdSet = new Set<string>();
  for (let i = 0; i < txnIds.length; i++) txnIdSet.add(txnIds[i].toLowerCase());

  for (let i = 0; i < historyLen; i++) {
    const t = history[i];
    const id = t.transaction_id;
    const idNorm = id.indexOf(" ") >= 0 || id.indexOf("_") >= 0
      ? id.replace(RE_ID_NORMALIZE, "-").toLowerCase()
      : id.toLowerCase();
    if (txnIdSet.has(idNorm)) {
      return {
        transaction: t,
        score: 1,
        reasons: [REASON_EXPLICIT],
        similarAmountCount: 0,
      };
    }
  }

  // Single pass: score every txn, then pick the best (with recent-tiebreak).
  const scored: ScoredTxn[] = new Array(historyLen);
  for (let i = 0; i < historyLen; i++) {
    const t = history[i];
    let score = 0;
    const reasons: string[] = [];

    if (amounts.length > 0 && typeof t.amount === "number") {
      const tAmt = t.amount;
      for (let k = 0; k < amounts.length; k++) {
        const a = amounts[k];
        const diff = a > tAmt ? a - tAmt : tAmt - a;
        if (diff / (tAmt > 1 ? tAmt : 1) <= AMOUNT_TOLERANCE) {
          score += 2;
          reasons.push("amount_match:" + a + "~" + tAmt);
          break;
        }
      }
    }

    if (phones.length > 0 && t.counterparty) {
      const cp = normalizePhone(t.counterparty);
      for (let k = 0; k < phones.length; k++) {
        const p = phones[k];
        if (p === cp || cp.endsWith(p) || p.endsWith(cp)) {
          score += 2;
          reasons.push("counterparty_phone_match:" + cp);
          break;
        }
      }
    }

    if (score >= 2) reasons.push(REASON_SCORE_OK);
    scored[i] = { transaction: t, score, reasons };
  }

  let best = scored[0];
  for (let i = 1; i < historyLen; i++) if (scored[i].score > best.score) best = scored[i];

  if (best.score > 0) {
    // Tie: keep the most recent. Build a tied list to preserve HEAD order.
    let tiedHead: ScoredTxn | null = null;
    let tiedTail: ScoredTxn[] | null = null;
    for (let i = 0; i < historyLen; i++) {
      if (scored[i].score === best.score) {
        if (tiedHead === null) tiedHead = scored[i];
        else {
          if (tiedTail === null) tiedTail = [tiedHead, scored[i]];
          else tiedTail.push(scored[i]);
        }
      }
    }
    const tiedList = tiedTail ?? (tiedHead ? [tiedHead] : null);
    if (tiedList && tiedList.length > 1) {
      tiedList.sort((a, b) => b.transaction.timestamp.localeCompare(a.transaction.timestamp));
      const winner = tiedList[0];
      best = {
        transaction: winner.transaction,
        score: winner.score,
        reasons: winner.reasons.concat([REASON_TIEBREAK]),
      };
    }
  }

  // Amount-grouping pass: how many txns share the matched amount?
  let similarAmountCount = 0;
  if (best.transaction) {
    const winAmt = best.transaction.amount;
    for (let i = 0; i < historyLen; i++) {
      if (history[i].amount === winAmt) similarAmountCount++;
    }
  }

  return {
    transaction: best.transaction,
    score: best.score,
    reasons: best.reasons,
    similarAmountCount,
  };
}

function decideEvidenceVerdict(
  caseType: CaseType,
  match: MatchResult,
  hasHistory: boolean
): EvidenceVerdict {
  if (!hasHistory || !match.transaction) return "insufficient_data";

  const t = match.transaction;

  // Phishing is about a contact attempt, not a transaction in history.
  if (caseType === "phishing_or_social_engineering") return "insufficient_data";

  switch (caseType) {
    case "payment_failed":
      return PAYMENT_FAILED_VERDICT[t.status];
    case "wrong_transfer":
      return WRONG_TRANSFER_VERDICT[t.status];
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

const DISPUTE_CASE_TYPES: ReadonlySet<CaseType> = new Set<CaseType>([
  "wrong_transfer",
  "duplicate_payment",
  "payment_failed",
  "agent_cash_in_issue",
]);

function shouldEscalate(
  caseType: CaseType,
  verdict: EvidenceVerdict,
  amount: number | undefined,
  userType: string | undefined
): { escalate: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (caseType === "phishing_or_social_engineering") reasons.push("phishing_case_always_escalated");
  if (verdict === "insufficient_data") reasons.push("insufficient_evidence");
  if (verdict === "inconsistent") reasons.push("evidence_contradicts_complaint");
  if (typeof amount === "number" && amount >= HIGH_VALUE_THRESHOLD) reasons.push("high_value_threshold");
  if (userType === "merchant") reasons.push("merchant_user_type");
  if (DISPUTE_CASE_TYPES.has(caseType)) reasons.push("dispute_classification");
  if (caseType === "refund_request" && verdict !== "insufficient_data") reasons.push("refund_requires_review");
  return { escalate: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Output builders
// ---------------------------------------------------------------------------

function buildAgentSummary(
  req: AnalyzeRequest,
  classification: Classification,
  match: MatchResult
): string {
  const idPart = match.transaction
    ? "Transaction " + match.transaction.transaction_id
    : "no matching transaction in the recent history";
  const c = req.complaint;
  const snippet = c.length > SNIPPET_MAX ? c.slice(0, SNIPPET_KEEP) + ELLIPSIS : c;
  return `Customer reports: "${snippet}" Classified as ${classification.caseType}. Evidence cross-checked against ${idPart}.`;
}

// Lookup tables avoid re-entering the same template strings per call.
const NEXT_ACTION_PHISHING = "Open a fraud-risk ticket, flag the customer account with a phishing advisory, and provide only the official in-app support channel as the contact path.";
const NEXT_ACTION_INSUFFICIENT = "Pull additional transaction history from the core ledger and confirm details with the customer via the official in-app chat before any further action.";
const NEXT_ACTION_INCONSISTENT = "Verify the customer's claim against the matched transaction and escalate to a human dispute specialist before any resolution step.";
const NEXT_ACTION_BY_CASE: Record<CaseType, string> = {
  phishing_or_social_engineering: NEXT_ACTION_PHISHING,
  wrong_transfer: "Verify the matched transaction with the customer, attempt recipient contact through official channels, and queue a dispute for human review.",
  payment_failed: "Trace the matched transaction through the payments ledger, confirm the deduction status, and if eligible route for an official-channel resolution.",
  duplicate_payment: "Confirm the duplicate via ledger query and route to payments operations for official-channel resolution of any eligible duplicate amount.",
  refund_request: "Verify the matched transaction, evaluate eligibility, and queue for an official-channel resolution by a human reviewer.",
  merchant_settlement_delay: "Check the merchant settlement pipeline for the matched transaction and notify merchant operations.",
  agent_cash_in_issue: "Reconcile the matched cash-in against the agent ledger and escalate to agent operations.",
  other: "Review the customer note and route to the appropriate team based on the matched evidence.",
};

function buildNextAction(caseType: CaseType, verdict: EvidenceVerdict): string {
  if (caseType === "phishing_or_social_engineering") return NEXT_ACTION_PHISHING;
  if (verdict === "insufficient_data") return NEXT_ACTION_INSUFFICIENT;
  if (verdict === "inconsistent") return NEXT_ACTION_INCONSISTENT;
  return NEXT_ACTION_BY_CASE[caseType];
}

const REPLY_PHISHING =
  "Thank you for flagging this. Please do not share any PIN, OTP, password, or card details with anyone who contacts you. " +
  "Our team will review the activity on your account and follow up through " +
  SAFE_OFFICIAL + ". If you have already shared credentials, please change your password immediately through the app.";

const REPLY_INCONSISTENT_HEAD = (idRef: string) =>
  `Thank you for contacting us about your concern${idRef}. ` +
  "Based on the records we can see, the transaction in question does not match the details you described. " +
  "We will have a specialist verify the records and reach out to you through " +
  SAFE_OFFICIAL + " within one business day.";

const REPLY_INSUFFICIENT_HEAD = (idRef: string) =>
  `Thank you for reaching out${idRef}. ` +
  "To help us investigate accurately, please share any additional details (time, reference, recipient phone) through " +
  SAFE_OFFICIAL + ". Our team will review the case and respond shortly.";

const REPLY_BY_CASE: Record<CaseType, (idRef: string) => string> = {
  phishing_or_social_engineering: () => REPLY_PHISHING,
  wrong_transfer: (idRef) =>
    `Thank you for letting us know about the transfer${idRef}. ` +
    "We have logged the concern and our dispute team will review the case. " +
    "Any eligible amount will be processed through " + SAFE_OFFICIAL + " in line with our recovery policy.",
  payment_failed: (idRef) =>
    `Thank you for reporting the payment issue${idRef}. ` +
    "We have noted the failed transaction and our payments team will verify the deduction status. " +
    "Any eligible amount will be processed through " + SAFE_OFFICIAL + ".",
  duplicate_payment: (idRef) =>
    `Thank you for flagging the duplicate charge${idRef}. ` +
    "Our payments team will verify the records. " +
    "Any eligible duplicate amount will be processed through " + SAFE_OFFICIAL + ".",
  refund_request: (idRef) =>
    `Thank you for your refund request${idRef}. ` +
    "Our team will review the case against our eligibility policy. " +
    "Any eligible amount will be returned through " + SAFE_OFFICIAL + ".",
  merchant_settlement_delay: (idRef) =>
    `Thank you for reporting the settlement delay${idRef}. ` +
    "Our merchant operations team will look into the settlement status and update you through " +
    SAFE_OFFICIAL + ".",
  agent_cash_in_issue: (idRef) =>
    `Thank you for reporting the cash-in issue${idRef}. ` +
    "Our agent operations team will reconcile the deposit against the ledger and follow up through " +
    SAFE_OFFICIAL + ".",
  other: (idRef) =>
    `Thank you for contacting us${idRef}. ` +
    "We have logged your concern and a support agent will reach out through " +
    SAFE_OFFICIAL + " shortly.",
};

function buildCustomerReply(caseType: CaseType, match: MatchResult, verdict: EvidenceVerdict): string {
  const idRef = match.transaction ? ` (reference ${match.transaction.transaction_id})` : "";
  if (caseType === "phishing_or_social_engineering") return REPLY_PHISHING;
  if (verdict === "inconsistent") return REPLY_INCONSISTENT_HEAD(idRef);
  if (verdict === "insufficient_data") return REPLY_INSUFFICIENT_HEAD(idRef);
  return REPLY_BY_CASE[caseType](idRef);
}

function computeConfidence(match: MatchResult, verdict: EvidenceVerdict): number {
  let c = 0.7;
  if (match.score >= 2) c += 0.15;
  if (match.reasons.indexOf(REASON_EXPLICIT) !== -1) c += 0.1;
  if (verdict === "insufficient_data") c -= 0.2;
  else if (verdict === "inconsistent") c -= 0.1;
  // Match HEAD's clamping behavior exactly (then format to 2dp).
  if (c < 0.1) c = 0.1;
  else if (c > 0.99) c = 0.99;
  return Number(c.toFixed(2));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function investigate(req: AnalyzeRequest): AnalyzeResponse {
  const norm = normalize(sanitizeComplaint(req.complaint));
  const history = req.transaction_history ?? [];
  const hasHistory = history.length > 0;

  // Compute one-shot flags from history without allocating intermediate arrays.
  let hasCashIn = false;
  let hasSettlement = false;
  for (let i = 0; i < history.length; i++) {
    const t = history[i];
    if (t.type === "cash_in") hasCashIn = true;
    else if (t.type === "settlement") hasSettlement = true;
    if (hasCashIn && hasSettlement) break;
  }

  const classification = classify(norm, hasCashIn, hasSettlement);

  // Phishing overrides the txn-match logic: the operative issue is the contact
  // attempt, not a transaction in the history.
  const isPhishing = classification.caseType === "phishing_or_social_engineering";
  let match: MatchResult;

  if (isPhishing) {
    match = EMPTY_MATCH;
  } else {
    // Extract once per request — reused here. Sink arrays avoid intermediate
    // Sets/spreads.
    const amounts: number[] = [];
    const phones: string[] = [];
    const txnIds: string[] = [];
    extractAmounts(req.complaint, amounts);
    extractPhones(req.complaint, phones);
    extractTransactionIds(req.complaint, txnIds);
    match = matchTransaction(txnIds, amounts, phones, history);
  }

  const relevantTxnId = isPhishing ? null : match.transaction?.transaction_id ?? null;
  const verdict: EvidenceVerdict = isPhishing
    ? "insufficient_data"
    : decideEvidenceVerdict(classification.caseType, match, hasHistory);

  const routing = DEFAULT_ROUTING[classification.caseType];
  const matchedAmount = match.transaction?.amount;
  const esc = shouldEscalate(classification.caseType, verdict, matchedAmount, req.user_type);

  // Bump severity for high-value inconsistent evidence; promote low -> medium
  // for any escalated case so the agent sees a meaningful priority.
  let severity: Severity = routing.severity;
  if (verdict === "inconsistent" && typeof matchedAmount === "number" && matchedAmount >= HIGH_VALUE_THRESHOLD) {
    severity = "critical";
  } else if (esc.escalate && severity === "low") {
    severity = "medium";
  }

  // Build reason codes with bounded allocation: pre-size the array.
  const matchReasons = match.reasons;
  const escReasons = esc.reasons;
  const totalReasons = 2 + matchReasons.length + escReasons.length;
  const reasonCodes: string[] = new Array(totalReasons);
  reasonCodes[0] = "case:" + classification.caseType;
  reasonCodes[1] = "verdict:" + verdict;
  for (let i = 0; i < matchReasons.length; i++) reasonCodes[2 + i] = "match:" + matchReasons[i];
  for (let i = 0; i < escReasons.length; i++) reasonCodes[2 + matchReasons.length + i] = "escalate:" + escReasons[i];

  return {
    ticket_id: req.ticket_id,
    relevant_transaction_id: relevantTxnId,
    evidence_verdict: verdict,
    case_type: classification.caseType,
    severity,
    department: routing.department,
    agent_summary: buildAgentSummary(req, classification, match),
    recommended_next_action: buildNextAction(classification.caseType, verdict),
    customer_reply: buildCustomerReply(classification.caseType, match, verdict),
    human_review_required: esc.escalate,
    confidence: computeConfidence(match, verdict),
    reason_codes: reasonCodes,
  };
}