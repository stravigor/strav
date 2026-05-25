// Adapters are wired in by the individual implementation files. This
// barrel re-exports them so consumers can `import { WordPressPublisher,
// MetaPublisher, GoogleBusinessProfilePublisher, LineBroadcastPublisher }
// from '@strav/publish/publishers'` without knowing the file layout.
export { WordPressPublisher } from './wordpress.ts'
export type { WordPressPublisherConfig } from './wordpress.ts'

export { LineBroadcastPublisher } from './line_broadcast.ts'

export {
  FacebookPagePublisher,
  InstagramPublisher,
  MetaPublisher,
} from './meta.ts'
export type { MetaPublisherConfig } from './meta.ts'

export { GoogleBusinessProfilePublisher } from './google_business.ts'
export type { GoogleBusinessProfilePublisherConfig } from './google_business.ts'
