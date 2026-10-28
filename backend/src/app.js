import express from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import apiRouter, { healthHandler } from './routes/api.js'
import { getPaymentDataMode } from './services/supplierPaymentsService.js'
import { IntegrationError } from './services/sapService.js'

const app = express()

app.disable('x-powered-by')
app.use(helmet())
app.use(express.json({ limit: '10kb' }))
app.use(
  '/api',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }),
)
app.get('/health', healthHandler)
app.use('/api', apiRouter)

app.use((_request, response) => {
  response.status(404).json({ error: 'Not found.' })
})

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    response.status(400).json({ error: 'Request body must contain valid JSON.' })
    return
  }
  if (error?.type === 'entity.too.large') {
    response.status(413).json({ error: 'Request body exceeds the 10 KB limit.' })
    return
  }
  if (error instanceof IntegrationError) {
    response.status(error.statusCode).json({
      error: error.message,
      dataMode: getPaymentDataMode() === 'demo' ? 'demo' : 'unavailable',
    })
    return
  }
  console.error('Unhandled API error:', error instanceof Error ? error.message : 'Unknown error')
  response.status(500).json({ error: 'An unexpected server error occurred.' })
})

export default app
