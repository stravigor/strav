import { HttpProvider } from "@strav/http"
import { ConfigProvider, EncryptionProvider, ServiceProvider } from "@strav/kernel"
import { ViewProvider, PagesProvider } from '@strav/view'

export const providers: ServiceProvider[] = [
  new ConfigProvider(),
  new HttpProvider(),
  new EncryptionProvider(),
  new ViewProvider(),
  new PagesProvider(),
]