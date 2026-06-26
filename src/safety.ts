// Safety guardrails. These run over any user-influenced text (customer_reply,
// recommended_next_action) to ensure no credential solicitation, no
// unauthorized refund confirmations, and no referral to suspicious third
// parties.
//
// Implementation note: instead of looping over N patterns per category, we
// merge each category into one precompiled alternation regex. One .test()
// per category replaces N tests + intermediate array allocations.

type SafetyIssueKind =
  | "credential_request"
  | "unauthorized_confirmation"
  | "suspicious_referral";

// Combined alternation regex per category.
const RE_CREDENTIAL_REQUEST = /\bshare (?:your|the) (?:pin|otp|password|cvv|full card|card number)\b|\bsend (?:your|the) (?:pin|otp|password|cvv|full card|card number)\b|\bprovide (?:your|the) (?:pin|otp|password|cvv|full card|card number)\b|\bgive (?:me|us) (?:your|the) (?:pin|otp|password|cvv|full card|card number)\b|\b(?:pin|otp|password|cvv|full card|card number) (?:share|send|provide|give)\b|\btell me (?:your|the) (?:pin|otp|password|cvv)\b|\bverify (?:your|the) (?:pin|otp|password|cvv|full card|card number)\b|\bconfirm (?:your|the) (?:pin|otp|password|cvv|full card|card number)\b|\b(?:enter|type) (?:your|the) (?:pin|otp|password|cvv)\b/i;

const RE_UNAUTHORIZED_CONFIRMATION = /\bwe (?:will|shall|have) refund(?:ed)? you\b|\bwe (?:will|shall|have) (?:reverse|reversed) (?:the )?(?:transaction|payment|transfer|charge)\b|\bwe (?:will|shall|have) (?:unblock|unblocked) (?:your )?(?:account|card|wallet)\b|\byour money (?:will|has) (?:been |is )?(?:returned|refunded|sent back|credited back)\b|\bwe have (?:already )?(?:refunded|reversed|credited|returned)\b|\bguarantee(?:d)? (?:a )?refund\b/i;

const RE_SUSPICIOUS_REFERRAL = /\bcontact (?:this|the) (?:number|person|guy|agent|broker)\b|\bcall (?:this|the) (?:number|person|guy|agent|broker)\b|\b(?:whatsapp|telegram|viber|imo) (?:this|the) (?:number|person|agent)\b|\breach (?:out )?to (?:this|the) (?:number|person|agent)\b/i;

export interface SafetyIssue {
  kind: SafetyIssueKind;
  pattern: string;
}

export interface SafetyCheckResult {
  clean: boolean;
  issues: SafetyIssue[];
}

// Each category still reports one entry (under the combined pattern name).
// Earlier versions enumerated every individual sub-pattern; the public shape
// stays the same — `{kind, pattern}` — just with the merged source string.
export function checkSafety(text: string): SafetyCheckResult {
  if (!RE_CREDENTIAL_REQUEST.test(text)
      && !RE_UNAUTHORIZED_CONFIRMATION.test(text)
      && !RE_SUSPICIOUS_REFERRAL.test(text)) {
    return { clean: true, issues: [] };
  }
  const issues: SafetyIssue[] = [];
  if (RE_CREDENTIAL_REQUEST.test(text))
    issues.push({ kind: "credential_request", pattern: "credential_request_combined" });
  if (RE_UNAUTHORIZED_CONFIRMATION.test(text))
    issues.push({ kind: "unauthorized_confirmation", pattern: "unauthorized_confirmation_combined" });
  if (RE_SUSPICIOUS_REFERRAL.test(text))
    issues.push({ kind: "suspicious_referral", pattern: "suspicious_referral_combined" });
  return { clean: false, issues };
}