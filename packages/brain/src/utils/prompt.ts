/**
 * Heuristic detector for prompt-injection markers in untrusted strings
 * destined for the system prompt. The interpolation in
 * `agent.instructions` does naïve `replaceAll` of `{{key}}` placeholders
 * with string values — any user-controlled value flowing through is a
 * prompt-injection vector against the LLM.
 *
 * We can't fully solve this at the template layer (the proper fix is to
 * pass values as structured user-role messages, not interpolate them
 * into the system role). What we can do is detect the easy cases and
 * warn the developer that a value looks suspicious. Detection here is
 * deliberately loose — false positives are cheap, missed cases let
 * exploits through silently.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:[\w\s]{0,30}\s+)?(?:instructions?|prompts?|messages?)/i,
  /disregard\s+(?:[\w\s]{0,30}\s+)?(?:instructions?|prompts?|messages?)/i,
  /(?:^|\n)\s*system\s*[:>]/i,
  /(?:^|\n)\s*assistant\s*[:>]/i,
  /\bsystem\s*:\s*\S/i,
  /you\s+are\s+now\s+(?:a|an|the)/i,
  /act\s+as\s+(?:a|an|the)\s+(?:different|new)/i,
  /\[INST\]|\[\/INST\]/i,
  /<\|im_(?:start|end)\|>/i,
  /<\|system\|>|<\|user\|>|<\|assistant\|>/i,
  /###\s*(?:system|instruction|new\s+instruction)/i,
]

/** Return true if the string contains a known prompt-injection marker. */
export function looksLikePromptInjection(value: string): boolean {
  if (!value || typeof value !== 'string') return false
  return INJECTION_PATTERNS.some(re => re.test(value))
}

/**
 * Substitute `{{key}}` placeholders in a system-prompt template with
 * values from `context`. Emits a `console.warn` when a value matches
 * `looksLikePromptInjection()` so developers notice when untrusted
 * input is reaching the system prompt.
 *
 * The replacement still happens — the warning is informational. Callers
 * who need hard rejection should validate context themselves before
 * calling. The framework cannot decide whether a given context value is
 * trusted; only the application can.
 */
export function interpolateInstructions(
  template: string,
  context: Record<string, unknown>
): string {
  let out = template
  for (const [key, rawValue] of Object.entries(context)) {
    const stringValue = String(rawValue)
    if (looksLikePromptInjection(stringValue)) {
      console.warn(
        `[brain] Possible prompt-injection in agent context.${key} — ` +
          `the value contains markers commonly used to override system ` +
          `instructions. Treat untrusted user input as user-role messages, ` +
          `not as interpolated system-prompt context. ` +
          `See packages/brain/CLAUDE.md ("Prompt-injection threat model").`
      )
    }
    out = out.replaceAll(`{{${key}}}`, stringValue)
  }
  return out
}
