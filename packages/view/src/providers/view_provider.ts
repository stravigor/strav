import ServiceProvider from '@strav/kernel/core/service_provider'
import type Application from '@strav/kernel/core/application'
import Configuration from '@strav/kernel/config/configuration'
import Context from '@strav/http/http/context'
import ViewEngine from '../engine.ts'
import { AssetVersioner } from '../asset_versioner.ts'

export default class ViewProvider extends ServiceProvider {
  readonly name = 'view'
  override readonly dependencies = ['config']

  private assets: AssetVersioner | null = null

  override register(app: Application): void {
    app.singleton(ViewEngine)
  }

  override async boot(app: Application): Promise<void> {
    const engine = app.resolve(ViewEngine)
    Context.setViewEngine(engine)

    const config = app.resolve(Configuration)
    const assetPaths = config.get('view.assets', []) as string[]
    if (!assetPaths.length) return

    const publicDir = config.get('http.public', './public') as string
    this.assets = new AssetVersioner(publicDir)

    await Promise.all(assetPaths.map(path => this.assets!.add(path)))
    ViewEngine.setGlobal('asset', (path: string) => this.assets!.resolve(path))

    if (Bun.env.NODE_ENV !== 'production') {
      for (const path of assetPaths) {
        await this.assets.watch(path)
      }
    }
  }

  override shutdown(): void {
    this.assets?.close()
    this.assets = null
  }
}
