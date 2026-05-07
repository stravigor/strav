import { EncryptionManager } from '@strav/kernel'

// All tests need the encryption keys ready before sealing/unsealing.
// `useKey()` is the test-friendly init path that bypasses the DI container.
EncryptionManager.useKey('test-app-key-for-captcha-package-tests-only-not-secret')
