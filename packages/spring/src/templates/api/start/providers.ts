import { DatabaseProvider } from "@strav/database"
import { HttpProvider } from "@strav/http"
import { ConfigProvider, EncryptionProvider, ServiceProvider } from "@strav/kernel"

export const providers: ServiceProvider[] = [
  new ConfigProvider(),
  new HttpProvider(),
  new DatabaseProvider(),
  new EncryptionProvider(),
]