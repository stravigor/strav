import { StravError } from '@strav/kernel'

export class FlagError extends StravError {}

export class FeatureNotDefinedError extends FlagError {
  constructor(feature: string) {
    super(`Feature "${feature}" is not defined. Register it with flag.define().`)
  }
}

/**
 * Thrown when `flag.strictScopes` is enabled and a flag operation is
 * called without a scope (or with a null/undefined one). Catches the
 * common bug where middleware forgets to pass `ctx.get('user')` and
 * the lookup silently evaluates the global flag.
 */
export class MissingScopeError extends FlagError {
  constructor(feature: string) {
    super(
      `Feature "${feature}" was evaluated without a scope, but flag.strictScopes is enabled. ` +
        `Pass an explicit scope (e.g. flag.for(user).value('${feature}')) or call ` +
        `flag.activateForEveryone('${feature}') for genuinely global flags.`
    )
  }
}
