import type { ChallengeName, ChallengeType } from './types.ts'

const registry = new Map<string, ChallengeType>()

/**
 * Register a challenge type so `issueChallenge()` / `verifyChallenge()` can
 * dispatch to it. Built-ins (honeypot, pow, svg) self-register on first
 * import of `./challenges.ts` — call this only when adding custom types.
 *
 * @example
 * registerChallengeType({
 *   name: 'slider',
 *   issue: () => ({ props: { ... }, answer: '...' }),
 *   verify: (payload, response) => response === payload.ah ? { ok: true } : { ok: false, reason: 'answer_mismatch' },
 * })
 */
export function registerChallengeType(type: ChallengeType): void {
  registry.set(type.name, type)
}

/** Look up a registered challenge type. Returns `undefined` if not registered. */
export function getChallengeType(name: ChallengeName): ChallengeType | undefined {
  return registry.get(name)
}

/** All registered type names — used by validators and refresh route allow-listing. */
export function listChallengeTypes(): ChallengeName[] {
  return Array.from(registry.keys())
}
