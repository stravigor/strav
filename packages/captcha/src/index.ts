// Middleware
export { captcha } from './middleware.ts'

// Issue / verify primitives
export { issueChallenge, verifyChallenge } from './challenges.ts'
export { honeypotChallenge, powChallenge, svgChallenge } from './challenges.ts'

// Registry — for custom challenge types
export { registerChallengeType, getChallengeType, listChallengeTypes } from './registry.ts'

// Validation rule
export { captchaRule } from './validation_rule.ts'

// Refresh route
export { mountCaptchaRoutes } from './route.ts'

// View helper / @captcha directive support
export {
  installCaptchaHelpers,
  configureCaptchaHelper,
  captchaHelper,
} from './view_helper.ts'

// Token utilities (exposed so consumers can build custom flows)
export { sealToken, unsealToken, hashAnswer, safeEqual, consumeReplay } from './token.ts'

// SVG renderer (exposed for users who want to render outside the directive)
export { renderSvg } from './challenges/svg.ts'

// PoW utilities (count leading zero bits — useful for testing)
export { countLeadingZeroBits } from './challenges/pow.ts'

// Types
export { DEFAULTS } from './types.ts'
export type {
  ChallengeName,
  ChallengeType,
  CaptchaTokenPayload,
  CaptchaOptions,
  IssueOptions,
  IssuedChallenge,
  VerifyResult,
  FailureReason,
} from './types.ts'
