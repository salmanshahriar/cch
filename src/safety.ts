// Safety guardrails. These run over any user-influenced text (customer_reply,
// recommended_next_action) to ensure no credential solicitation, no
// unauthorized refund confirmations, and no referral to suspicious third
// parties.

type SafetyIssueKind =
  | "credential_request"
  | "unauthorized_confirmation"
  | "suspicious_referral";

const CREDENTIAL_REQUEST_PATTERNS: RegExp[] = [
  /\bshare (?:your|the) (?:pin|otp|password|cvv|full card|card number)\b/i,
  /\bsend (?:your|the) (?:pin|otp|password|cvv|full card|card number)\b/i,
  /\bprovide (?:your|the) (?:pin|otp|password|cvv|full card|card number)\b/i,
  /\bgive (?:me|us) (?:your|the) (?:pin|otp|password|cvv|full card|card number)\b/i,
  /\b(?:pin|otp|password|cvv|full card|card number) (?:share|send|provide|give)\b/i,
  /\btell me (?:your|the) (?:pin|otp|password|cvv)\b/i,
  /\bverify (?:your|the) (?:pin|otp|password|cvv|full card|card number)\b/i,
  /\bconfirm (?:your|the) (?:pin|otp|password|cvv|full card|card number)\b/i,
  /\b(?:enter|type) (?:your|the) (?:pin|otp|password|cvv)\b/i,
];

const UNAUTHORIZED_CONFIRMATION_PATTERNS: RegExp[] = [
  /\bwe (?:will|shall|have) refund(?:ed)? you\b/i,
  /\bwe (?:will|shall|have) (?:reverse|reversed) (?:the )?(?:transaction|payment|transfer|charge)\b/i,
  /\bwe (?:will|shall|have) (?:unblock|unblocked) (?:your )?(?:account|card|wallet)\b/i,
  /\byour money (?:will|has) (?:been |is )?(?:returned|refunded|sent back|credited back)\b/i,
  /\bwe have (?:already )?(?:refunded|reversed|credited|returned)\b/i,
  /\bguarantee(?:d)? (?:a )?refund\b/i,
];

const SUSPICIOUS_REFERRAL_PATTERNS: RegExp[] = [
  /\bcontact (?:this|the) (?:number|person|guy|agent|broker)\b/i,
  /\bcall (?:this|the) (?:number|person|guy|agent|broker)\b/i,
  /\b(?:whatsapp|telegram|viber|imo) (?:this|the) (?:number|person|guy|agent)\b/i,
  /\breach (?:out )?to (?:this|the) (?:number|person|agent)\b/i,
];

export interface SafetyCheckResult {
  clean: boolean;
  issues: { kind: SafetyIssueKind; pattern: string }[];
}

function scan(text: string, kind: SafetyIssueKind, patterns: RegExp[]): { kind: SafetyIssueKind; pattern: string }[] {
  const hits: { kind: SafetyIssueKind; pattern: string }[] = [];
  for (const p of patterns) {
    if (p.test(text)) hits.push({ kind, pattern: p.source });
  }
  return hits;
}

export function checkSafety(text: string): SafetyCheckResult {
  const issues = [
    ...scan(text, "credential_request", CREDENTIAL_REQUEST_PATTERNS),
    ...scan(text, "unauthorized_confirmation", UNAUTHORIZED_CONFIRMATION_PATTERNS),
    ...scan(text, "suspicious_referral", SUSPICIOUS_REFERRAL_PATTERNS),
  ];
  return { clean: issues.length === 0, issues };
}