import app from './app.js'
import { config, validateConfig } from './config.js'

validateConfig()

app.listen(config.port, config.host, () => {
  console.log(
    `Supplier Payments Management API listening on http://${config.host}:${config.port} (data mode: ${config.dataMode})`,
  )
})
