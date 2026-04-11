import { DatabaseProvider } from "@strav/database"
import { HttpProvider, SessionProvider } from "@strav/http"
import { ConfigProvider, EncryptionProvider, ServiceProvider } from "@strav/kernel"
import { ViewProvider } from '@strav/view'

export const providers: ServiceProvider[] = [
  new ConfigProvider(),
  new HttpProvider(),
  new DatabaseProvider(),
  new EncryptionProvider(),
  new SessionProvider(),
  new ViewProvider(),
]