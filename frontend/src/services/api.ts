import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

export type PaymentStatus = 'Paid' | 'Pending' | 'Overdue' | 'Unknown' | 'Open' | 'Cleared' | 'Unverified' | 'Reversed' | 'Excluded'
export type DataMode = 'demo' | 'live' | 'unavailable'

export interface PaymentFilters {
  search?: string
  supplierId?: string
  supplierName?: string
  companyCode?: string
  paymentStatus?: PaymentStatus | ''
  invoiceStatus?: string
  dueDateFrom?: string
  dueDateTo?: string
  documentDateFrom?: string
  documentDateTo?: string
  postingDateFrom?: string
  postingDateTo?: string
  currency?: string
  minAmount?: string
  maxAmount?: string
}

export interface PaymentObligation {
  id: string
  supplierId: string | null
  supplierName: string | null
  companyCode: string | null
  invoiceReference?: string | null
  documentReference: string | null
  documentDate: string | null
  postingDate?: string | null
  dueDate: string | null
  amount: number | null
  grossAmount?: number | null
  invoiceAmount?: number | null
  currency: string | null
  paymentStatus: PaymentStatus | null
  invoiceProcessingStatus?: string | null
  statusReason?: string | null
  paymentDate?: string | null
  clearingDate: string | null
  paymentReference: string | null
  dataSource: 'demo' | 'live'
  dataMode?: DataMode
  limitations?: string[]
}

export interface PaymentListResponse {
  dataMode: DataMode
  records: PaymentObligation[]
  total: number
  top: number
  skip: number
  hasMore: boolean
  limitations: string[]
}

export interface MetricCurrencyAmount {
  currency: string
  amount: number
  count: number
}

export interface MetricResult {
  available: boolean
  byCurrency: MetricCurrencyAmount[]
  reason?: string
  totalCount?: number | null
}

export interface PaymentSummary {
  status?: 'available' | 'partially_available' | 'unavailable'
  reason?: string
  metricStatus?: Record<string, 'available' | 'unavailable'>
  metrics?: Record<string, MetricResult>
  sourceService?: string
  sourceEntity?: string
  reportingDate?: string
  outstandingAmountByCurrency: Record<string, number>
  totalOutstandingAmountByCurrency: Record<string, number>
  overdueAmountByCurrency: Record<string, number>
  upcomingObligationAmountByCurrency: Record<string, number>
  completedPaymentAmountByCurrency: Record<string, number>
  outstandingItemCount: number | null
  overdueItemCount: number | null
  suppliersWithOutstandingBalances?: number | null
  clearedAccountingItems?: number | null
  upcomingObligationCount: number | null
  completedPaymentCount: number | null
  upcomingDays: number
  upcomingPeriod: { from: string; through: string }
  invoiceCount: number
  invoiceGrossAmountByCurrency?: Record<string, number>
  totalInvoicedByCurrency?: Record<string, number>
  companyCodes?: string[]
  companyCodeCount?: number
  invoiceDocumentStatusSummary?: Record<string, number>
  totalInvoiced: number | null
  availableMetrics?: string[]
  unavailableMetrics?: Record<string, string>
  dataSource?: 'demo' | 'live'
  paidAmount: number | null
  outstandingAmount: number | null
  overdueCount: number | null
  currency: string | null
  limitations: string[]
}

export interface AccountingLineItem {
  id: string
  supplierId: string
  supplierName: string | null
  companyCode: string
  accountingDocument: string
  accountingDocumentItem: string
  fiscalYear: string
  accountingDocumentType: string | null
  debitCreditCode: string | null
  documentDate: string | null
  postingDate: string | null
  invoiceReference: string | null
  balanceAmount: string | null
  balanceCurrency: string | null
  currency?: string | null
  grossAmount?: string | null
  amount?: number | null
  dueDate: string | null
  clearingStatus: string | null
  clearingDate: string | null
  clearingDocument: string | null
  isCleared: boolean
  isClearingReversed: boolean
  openItemStatus: string
  statusReason?: string | null
  verifiedOpenAmount: string | null
  dataSource: 'live'
}

export interface AccountingLineItemResponse {
  dataMode: 'live'
  records: AccountingLineItem[]
  total: number
  top: number
  skip: number
  hasMore: boolean
  sourceService: string
  sourceEntity: string
}

export interface PaymentSummaryResponse {
  dataMode: DataMode
  summary: PaymentSummary
}

export interface HealthStatus {
  status: string
  application: { status: 'healthy' | string }
  dataMode: DataMode
  dependencies: {
    sap: {
      status: string
      configured: boolean
      paymentObligations: { status: string; reason?: string }
    }
    ollama: { status: string; configured: boolean }
  }
}

export type SapStatus =
  | 'not_configured'
  | 'connected'
  | 'authentication_failed'
  | 'authorization_failed'
  | 'unavailable'
  | 'other_error'
  | 'unknown'

export interface SapConnectionStatus {
  status: SapStatus
  message: string
  paymentDataStatus: {
    status: 'available' | 'empty' | 'unavailable'
    reason?: string
    recordCount?: number
    errorCategory?: string
  }
  lineItemsStatus?: {
    status: 'available' | 'empty' | 'unavailable'
    reason?: string
    recordCount?: number
    errorCategory?: string
  }
}

export interface PaymentAssistantResponse {
  dataMode: DataMode
  answer: string
  answerIsAuthoritative: false
  records: PaymentObligation[]
  matchedRecordCount: number
  limitations: string[]
}

function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError<{ error?: string }>(error)) {
    if (error.response?.data?.error) return error.response.data.error
    if (error.code === 'ECONNABORTED') return 'The backend request timed out. Please try again.'
    if (!error.response) return 'Could not reach the backend. Check that it is running and try again.'
    return `The backend request failed (HTTP ${error.response.status}).`
  }
  return error instanceof Error ? error.message : 'Unexpected API error.'
}

async function request<T>(operation: () => Promise<{ data: T }>): Promise<T> {
  try {
    const { data } = await operation()
    return data
  } catch (error) {
    throw new Error(getErrorMessage(error))
  }
}

function queryParams(filters: PaymentFilters, pagination?: { top: number; skip: number }) {
  return {
    ...Object.fromEntries(
      Object.entries(filters).filter(([, value]) => value !== undefined && value !== ''),
    ),
    ...(pagination ?? {}),
  }
}

export function getHealth(): Promise<HealthStatus> {
  return request(() => api.get<HealthStatus>('/health'))
}

export function getSapConnectionStatus(): Promise<SapConnectionStatus> {
  return request(() => api.get<SapConnectionStatus>('/sap/status'))
}

export function getPaymentObligations(
  filters: PaymentFilters = {},
  pagination = { top: 25, skip: 0 },
): Promise<PaymentListResponse> {
  return request(() =>
    api.get<PaymentListResponse>('/payments', { params: queryParams(filters, pagination), timeout: 30000 }),
  )
}

export function getPaymentSummary(filters: PaymentFilters = {}): Promise<PaymentSummaryResponse> {
  return request(() => api.get<PaymentSummaryResponse>('/payments/summary', {
    params: queryParams(filters),
    timeout: 60000,
  }))
}

export function getAccountingLineItems(
  filters: PaymentFilters = {},
  pagination = { top: 25, skip: 0 },
): Promise<AccountingLineItemResponse> {
  return request(() => api.get<AccountingLineItemResponse>('/payments/line-items', {
    params: queryParams(filters, pagination), timeout: 60000,
  }))
}

export function getPaymentDetails(id: string): Promise<{
  dataMode: DataMode
  record: PaymentObligation
}> {
  return request(() => api.get(`/payments/${encodeURIComponent(id)}`))
}

export function exportPaymentObligations(filters: PaymentFilters = {}): Promise<Blob> {
  return request(() => api.get('/payments/export', {
    params: queryParams(filters),
    responseType: 'blob',
  }))
}

export function askPaymentAssistant(
  prompt: string,
  filters: PaymentFilters = {},
): Promise<PaymentAssistantResponse> {
  return request(() =>
    api.post<PaymentAssistantResponse>('/ai/payments', { prompt, filters }, { timeout: 75000 }),
  )
}
