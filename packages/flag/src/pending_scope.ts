import type { FlagActor, Scopeable } from './types.ts'
import FlagManager from './flag_manager.ts'

/** Fluent scoped feature check — created by `FlagManager.for(scope)`. */
export default class PendingScopedFeature {
  constructor(private scope: Scopeable) {}

  value(feature: string): Promise<unknown> {
    return FlagManager.value(feature, this.scope)
  }

  active(feature: string): Promise<boolean> {
    return FlagManager.active(feature, this.scope)
  }

  inactive(feature: string): Promise<boolean> {
    return FlagManager.inactive(feature, this.scope)
  }

  when<A, I>(
    feature: string,
    onActive: (value: unknown) => A | Promise<A>,
    onInactive: () => I | Promise<I>
  ): Promise<A | I> {
    return FlagManager.when(feature, onActive, onInactive, this.scope)
  }

  activate(feature: string, value?: unknown, actor?: FlagActor | null): Promise<void> {
    return FlagManager.activate(feature, value, this.scope, actor)
  }

  deactivate(feature: string, actor?: FlagActor | null): Promise<void> {
    return FlagManager.deactivate(feature, this.scope, actor)
  }

  forget(feature: string): Promise<void> {
    return FlagManager.forget(feature, this.scope)
  }

  values(features: string[]): Promise<Map<string, unknown>> {
    return FlagManager.values(features, this.scope)
  }

  load(features: string[]): Promise<void> {
    return FlagManager.load(features, [this.scope])
  }
}
