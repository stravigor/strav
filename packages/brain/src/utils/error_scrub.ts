// Re-export the shared kernel helper so the same scrubber is used across
// every package that wraps upstream-provider errors. Keeping this thin
// re-export avoids a breaking import-path change for callers that
// already pulled `scrubProviderError` from `@strav/brain/utils/error_scrub`.
export { scrubProviderError } from '@strav/kernel'
