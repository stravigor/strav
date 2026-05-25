/**
 * Package-specific errors.
 *
 * Distinct from kernel's ExternalServiceError so callers can branch on
 * gateway-shape vs. transport failures. Each subclass keeps the gateway
 * name so logging surfaces "[omise]" / "[stripe]" prefixes consistently
 * across the codebase.
 */

export class PaymentError extends Error {
  readonly gateway: string
  readonly status?: number
  readonly code?: string
  readonly raw?: unknown

  constructor(
    gateway: string,
    message: string,
    opts?: { status?: number; code?: string; raw?: unknown }
  ) {
    super(`[${gateway}] ${message}`)
    this.name = 'PaymentError'
    this.gateway = gateway
    this.status = opts?.status
    this.code = opts?.code
    this.raw = opts?.raw
  }
}

export class WebhookVerificationError extends Error {
  readonly gateway: string

  constructor(gateway: string, reason: string) {
    super(`[${gateway}] webhook verification failed: ${reason}`)
    this.name = 'WebhookVerificationError'
    this.gateway = gateway
  }
}

export class GatewayNotRegisteredError extends Error {
  constructor(name: string) {
    super(
      `No gateway registered as "${name}". Register one via PaymentManager.register(new OmiseGateway(...)) at boot.`
    )
    this.name = 'GatewayNotRegisteredError'
  }
}
