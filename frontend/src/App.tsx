import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Alert,
  AppBar,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  InputAdornment,
  MenuItem,
  Paper,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material'
import type { ReactNode } from 'react'
import AccountBalanceWalletOutlinedIcon from '@mui/icons-material/AccountBalanceWalletOutlined'
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined'
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined'
import PaidOutlinedIcon from '@mui/icons-material/PaidOutlined'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined'
import {
  askPaymentAssistant,
  exportPaymentObligations,
  getHealth,
  getPaymentDetails,
  getPaymentObligations,
  getPaymentSummary,
  getSapConnectionStatus,
  type HealthStatus,
  type PaymentAssistantResponse,
  type PaymentFilters,
  type PaymentObligation,
  type PaymentStatus,
  type PaymentSummary,
  type SapConnectionStatus,
} from './services/api'
import './App.css'

type Page = 'dashboard' | 'search' | 'assistant'
type SortKey = 'supplierId' | 'companyCode' | 'supplierName' | 'documentReference' | 'documentDate' | 'postingDate' | 'amount' | 'currency' | 'dueDate' | 'paymentStatus' | 'invoiceProcessingStatus'
type SortDirection = 'asc' | 'desc'

const PAGE_SIZE = 25
const initialFilters: PaymentFilters = {}
const suggestions = [
  'How many live supplier invoices were retrieved?',
  'Summarize invoice gross amount by currency.',
  'List invoices for a supplier ID.',
  'Summarize invoices by company code.',
  'Explain invoice document statuses.',
  'What payment information is not included in this SAP source?',
]

interface AssistantMessage {
  role: 'user' | 'assistant'
  text: string
  result?: PaymentAssistantResponse
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

function formatAmount(amount: number | null | undefined, currency: string | null | undefined) {
  if (amount === null || amount === undefined || !currency) return '—'
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`
  }
}

function formatCurrencyTotals(totals: Record<string, number> | undefined) {
  const entries = Object.entries(totals ?? {}).filter(([, amount]) => Number.isFinite(amount))
  if (!entries.length) return '—'
  return entries.map(([currency, amount]) => formatAmount(amount, currency)).join(' · ')
}

function displayValue(value: string | null | undefined) {
  return value?.trim() || 'Unavailable'
}

function liveValue(value: string | null | undefined) {
  return value?.trim() || '—'
}

function liveAmount(amount: number | null | undefined, currency: string | null | undefined) {
  if (amount === null || amount === undefined || !currency) return '—'
  return formatAmount(amount, currency)
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'Unavailable'
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime())) return 'Unavailable'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function formatLiveDate(value: string | null | undefined) {
  if (!value) return '—'
  const formatted = formatDate(value)
  return formatted === 'Unavailable' ? '—' : formatted
}

function uniqueRecords(records: PaymentObligation[]) {
  const ids = new Set<string>()
  return records.filter((record) => {
    if (!record.id || ids.has(record.id)) return false
    ids.add(record.id)
    return true
  })
}

function ConnectionStatus({
  health,
  sap,
  healthError,
}: {
  health: HealthStatus | null
  sap: SapConnectionStatus | null
  healthError: string
}) {
  const backendAvailable = health?.application.status === 'healthy'
  const demoMode = health?.dataMode === 'demo'
  const sapConnected = sap?.status === 'connected'
  const invoiceDataStatus = sap?.paymentDataStatus.status
  const sapLabel = sapConnected
    ? invoiceDataStatus === 'available'
      ? 'SAP invoice data verified'
      : invoiceDataStatus === 'empty'
        ? 'SAP invoice service returned no records'
        : 'SAP connected · invoice data unavailable'
    : sap?.status === 'authentication_failed'
      ? 'SAP authentication failed'
      : sap?.status === 'authorization_failed'
        ? 'SAP access denied'
        : sap?.status === 'unavailable'
          ? 'SAP unavailable'
          : sap?.status === 'other_error'
            ? 'SAP check error'
            : sap?.status === 'not_configured'
              ? 'SAP not configured'
                : sap?.status === 'unknown'
                  ? 'SAP connection unverified'
                  : 'SAP unverified'

  return (
    <Box className="connection-status" aria-label="Service connection status">
      <Chip
        size="small"
        icon={backendAvailable ? <CheckCircleOutlineRoundedIcon /> : <CloudOutlinedIcon />}
        label={backendAvailable ? 'Backend available' : healthError ? 'Backend unavailable' : 'Checking backend'}
        color={backendAvailable ? 'success' : healthError ? 'error' : 'default'}
        variant="outlined"
      />
      <Chip
        size="small"
        icon={sapConnected ? <CheckCircleOutlineRoundedIcon /> : <CloudOutlinedIcon />}
        label={sapLabel}
        color={sapConnected ? 'success' : sap?.status === 'unavailable' || sap?.status === 'authentication_failed' || sap?.status === 'authorization_failed' ? 'error' : 'default'}
        variant="outlined"
      />
      {demoMode && <Chip size="small" label="Demo sample data" className="data-mode-chip" />}
      {health?.dataMode === 'live' && (
        <Chip
          size="small"
          label={invoiceDataStatus === 'available'
            ? 'Live SAP invoices'
            : invoiceDataStatus === 'empty'
              ? 'No matching SAP invoices'
              : 'Live invoice data unavailable'}
          color={invoiceDataStatus === 'available' ? 'success' : 'warning'}
          variant="outlined"
        />
      )}
    </Box>
  )
}

function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [healthError, setHealthError] = useState('')
  const [sapStatus, setSapStatus] = useState<SapConnectionStatus | null>(null)
  const [sapError, setSapError] = useState('')
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [draftFilters, setDraftFilters] = useState<PaymentFilters>(initialFilters)
  const [appliedFilters, setAppliedFilters] = useState<PaymentFilters>(initialFilters)
  const [records, setRecords] = useState<PaymentObligation[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<PaymentSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [dataError, setDataError] = useState('')
  const [pageIndex, setPageIndex] = useState(0)
  const [sortKey, setSortKey] = useState<SortKey>('documentDate')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [selectedRecord, setSelectedRecord] = useState<PaymentObligation | null>(null)
  const [detailError, setDetailError] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [exportError, setExportError] = useState('')
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [asking, setAsking] = useState(false)
  const [assistantError, setAssistantError] = useState('')

  const loadStatus = useCallback(async () => {
    setCheckingStatus(true)
    const [healthResult, sapResult] = await Promise.allSettled([
      getHealth(),
      getSapConnectionStatus(),
    ])
    if (healthResult.status === 'fulfilled') {
      setHealth(healthResult.value)
      setHealthError('')
    } else {
      setHealth(null)
      setHealthError(errorMessage(healthResult.reason))
    }
    if (sapResult.status === 'fulfilled') {
      setSapStatus(sapResult.value)
      setSapError('')
    } else {
      setSapStatus(null)
      setSapError(errorMessage(sapResult.reason))
    }
    setCheckingStatus(false)
  }, [])

  useEffect(() => {
    const initialStatusTimer = window.setTimeout(() => void loadStatus(), 0)
    const timer = window.setInterval(() => void loadStatus(), 60000)
    return () => {
      window.clearTimeout(initialStatusTimer)
      window.clearInterval(timer)
    }
  }, [loadStatus])

  const loadPayments = useCallback(async () => {
    setLoading(true)
    setDataError('')
    try {
      const [list, totals] = await Promise.all([
        getPaymentObligations(appliedFilters, {
          top: PAGE_SIZE,
          skip: pageIndex * PAGE_SIZE,
        }),
        getPaymentSummary(appliedFilters),
      ])
      setRecords(uniqueRecords(list.records))
      setTotal(list.total)
      setSummary(totals.summary)
    } catch (error) {
      setRecords([])
      setTotal(0)
      setSummary(null)
      setDataError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [appliedFilters, pageIndex])

  useEffect(() => {
    if (page !== 'dashboard' && page !== 'search') return
    const timer = window.setTimeout(() => void loadPayments(), 0)
    return () => window.clearTimeout(timer)
  }, [page, loadPayments])

  const sortedRecords = useMemo(() => {
    const valueFor = (record: PaymentObligation, key: SortKey) => {
      const value = record[key]
      return typeof value === 'number' ? value : String(value ?? '').toLocaleLowerCase()
    }
    return [...records].sort((left, right) => {
      const leftValue = valueFor(left, sortKey)
      const rightValue = valueFor(right, sortKey)
      const comparison = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
      return sortDirection === 'asc' ? comparison : -comparison
    })
  }, [records, sortDirection, sortKey])

  const updateDraft = (key: keyof PaymentFilters, value: string) => {
    setDraftFilters((current) => ({ ...current, [key]: value }))
  }

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPageIndex(0)
    setAppliedFilters({ ...draftFilters })
  }

  const clearFilters = () => {
    setDraftFilters({})
    setAppliedFilters({})
    setPageIndex(0)
  }

  const showDetails = async (record: PaymentObligation) => {
    setSelectedRecord(record)
    setDetailError('')
    setDetailLoading(true)
    try {
      const result = await getPaymentDetails(record.id)
      setSelectedRecord(result.record)
    } catch (error) {
      setDetailError(errorMessage(error))
    } finally {
      setDetailLoading(false)
    }
  }

  const downloadCsv = async () => {
    setExportError('')
    try {
      const blob = await exportPaymentObligations(appliedFilters)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = health?.dataMode === 'live' ? 'supplier-invoices.csv' : 'payment-obligations.csv'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      setExportError(errorMessage(error))
    }
  }

  const submitQuestion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const prompt = question.trim()
    if (!prompt || asking) return
    setQuestion('')
    setAssistantError('')
    setMessages((current) => [...current, { role: 'user', text: prompt }])
    setAsking(true)
    try {
      const result = await askPaymentAssistant(prompt, appliedFilters)
      setMessages((current) => [...current, {
        role: 'assistant',
        text: result.answer,
        result,
      }])
    } catch (error) {
      setAssistantError(errorMessage(error))
    } finally {
      setAsking(false)
    }
  }

  const choosePage = (next: Page) => setPage(next)

  return (
    <Box className="app-shell payments-shell">
      <AppBar position="sticky" elevation={0} className="topbar">
        <Toolbar className="topbar-content">
          <Box className="brand">
            <Avatar className="brand-mark"><AccountBalanceWalletOutlinedIcon /></Avatar>
            <Box>
              <Typography className="brand-title">Supplier Payments</Typography>
              <Typography className="brand-caption">FINANCE OPERATIONS</Typography>
            </Box>
          </Box>
          <Box className="topbar-right">
            <ConnectionStatus health={health} sap={sapStatus} healthError={healthError} />
            <Button
              className="refresh-status-button"
              aria-label="Refresh backend and SAP status"
              title="Refresh connection status"
              onClick={() => {
                setCheckingStatus(true)
                void loadStatus()
              }}
              disabled={checkingStatus}
            >
              {checkingStatus ? <CircularProgress size={18} /> : <RefreshRoundedIcon fontSize="small" />}
            </Button>
          </Box>
        </Toolbar>
      </AppBar>

      <Box component="main" className="main-content payments-content">
        {healthError && <Alert severity="error" className="demo-banner">{healthError}</Alert>}
        {health?.dataMode === 'demo' && (
          <Alert severity="warning" className="demo-banner">
            <strong>DEMO MODE</strong> — These are fictional sample obligations, not verified SAP accounting or clearing records.
          </Alert>
        )}
        {sapError && !healthError && (
          <Alert severity="warning" className="demo-banner">
            SAP status could not be verified. {sapError}
          </Alert>
        )}
        {sapStatus?.status === 'connected' && (
          <Alert
            severity={sapStatus.paymentDataStatus.status === 'unavailable' ? 'warning' : 'info'}
            className="demo-banner"
          >
            {health?.dataMode === 'demo'
              ? 'The configured SAP OData service is reachable, but the dashboard is using fictional demo records.'
              : sapStatus.paymentDataStatus.reason ??
                'The SAP service was verified, but invoice data availability could not be confirmed.'}
          </Alert>
        )}

        <Box className="page-heading payments-heading">
          <Box>
            <Typography className="eyebrow">ACCOUNTS PAYABLE · OVERVIEW</Typography>
            <Typography variant="h1" className="page-title">Supplier Payments Management</Typography>
            <Typography className="page-subtitle">
              {health?.dataMode === 'live'
                ? 'Review read-only supplier invoice records retrieved from SAP.'
                : 'Review supplier payment obligations with explicit data-source status.'}
            </Typography>
          </Box>
          <Chip
            icon={<ReceiptLongOutlinedIcon />}
            label={health?.dataMode === 'live' ? 'Read-only SAP invoices' : 'Read-only obligations'}
            className="system-chip"
            variant="outlined"
          />
        </Box>

        <Paper className="payments-panel page-navigation" elevation={0}>
          <Box className="page-nav-list" role="navigation" aria-label="Main navigation">
            <Button aria-current={page === 'dashboard' ? 'page' : undefined} onClick={() => choosePage('dashboard')}>
              Dashboard
            </Button>
            <Button aria-current={page === 'search' ? 'page' : undefined} onClick={() => choosePage('search')}>
              Search Payments
            </Button>
            <Button aria-current={page === 'assistant' ? 'page' : undefined} onClick={() => choosePage('assistant')}>
              <AutoAwesomeOutlinedIcon fontSize="small" /> AI Payment Assistant
            </Button>
          </Box>
        </Paper>

        {page !== 'assistant' && (
          <FilterPanel
            filters={draftFilters}
            onChange={updateDraft}
            onApply={applyFilters}
            onClear={clearFilters}
            searchPage={page === 'search'}
            liveMode={health?.dataMode === 'live'}
          />
        )}

        {page === 'dashboard' && (
          <DashboardPage
            summary={summary}
            dataMode={health?.dataMode}
            records={sortedRecords}
            total={total}
            loading={loading}
            error={dataError}
            exportError={exportError}
            pageIndex={pageIndex}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onRefresh={() => void loadPayments()}
            onExport={() => void downloadCsv()}
            onSort={(key) => {
              setSortDirection(sortKey === key && sortDirection === 'asc' ? 'desc' : 'asc')
              setSortKey(key)
            }}
            onPageChange={setPageIndex}
            onDetails={showDetails}
          />
        )}

        {page === 'search' && (
          <SearchPage
            records={sortedRecords}
            dataMode={health?.dataMode}
            total={total}
            loading={loading}
            error={dataError}
            pageIndex={pageIndex}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={(key) => {
              setSortDirection(sortKey === key && sortDirection === 'asc' ? 'desc' : 'asc')
              setSortKey(key)
            }}
            onPageChange={setPageIndex}
            onDetails={showDetails}
          />
        )}

        {page === 'assistant' && (
          <AssistantPage
            question={question}
            messages={messages}
            asking={asking}
            error={assistantError}
            dataMode={health?.dataMode}
            onQuestionChange={setQuestion}
            onSubmit={submitQuestion}
            onSuggestion={setQuestion}
            onDetails={showDetails}
          />
        )}

        <Box component="footer" className="page-footer payments-footer">
          <Typography>Supplier Payments Management</Typography>
          <Typography>{health?.dataMode === 'live' ? 'Live supplier invoice data · read-only SAP integration' : 'Read-only supplier payment application'}</Typography>
        </Box>
      </Box>

      <RecordDetails
        record={selectedRecord}
        loading={detailLoading}
        error={detailError}
        onClose={() => setSelectedRecord(null)}
      />
    </Box>
  )
}

function FilterPanel({
  filters,
  onChange,
  onApply,
  onClear,
  searchPage = false,
  liveMode = false,
}: {
  filters: PaymentFilters
  onChange: (key: keyof PaymentFilters, value: string) => void
  onApply: (event: FormEvent<HTMLFormElement>) => void
  onClear: () => void
  searchPage?: boolean
  liveMode?: boolean
}) {
  return (
    <Paper component="form" onSubmit={onApply} className="payments-panel filter-panel" elevation={0}>
      {searchPage && (
        <Typography className="section-description search-help">
          {liveMode
            ? 'Search verified supplier identifiers, SAP invoice numbers, invoice references, and available payment references.'
            : 'Search supplier, document number, invoice reference, or payment reference.'}
        </Typography>
      )}
      <Box className="payment-filters connected-filter-grid">
        <TextField
          label={searchPage
            ? liveMode ? 'Search SAP invoices' : 'Search payments'
            : liveMode ? 'Supplier ID or invoice reference' : 'Supplier ID or name'}
          value={filters.search ?? ''}
          onChange={(event) => onChange('search', event.target.value)}
          placeholder={liveMode
            ? 'Search supplier ID, SAP invoice number, invoice reference, or payment reference...'
            : searchPage
              ? 'Search by supplier, document number, invoice reference, or payment reference...'
              : 'Supplier ID, supplier name, or reference'}
          aria-label={searchPage
            ? liveMode ? 'Search SAP invoices' : 'Search payments'
            : liveMode ? 'Supplier ID or invoice reference' : 'Supplier ID or name'}
          size="small"
          className="payment-search"
          slotProps={{
            input: {
              startAdornment: <InputAdornment position="start"><SearchRoundedIcon color="action" /></InputAdornment>,
            },
          }}
        />
        <TextField
          label="Supplier ID"
          value={filters.supplierId ?? ''}
          onChange={(event) => onChange('supplierId', event.target.value)}
          size="small"
          className="payment-filter"
          slotProps={{ htmlInput: { maxLength: 40 } }}
        />
        <TextField
          label="Company code"
          value={filters.companyCode ?? ''}
          onChange={(event) => onChange('companyCode', event.target.value)}
          size="small"
          className="payment-filter"
          slotProps={{ htmlInput: { maxLength: 10 } }}
        />
        {!liveMode && (
          <>
            <TextField
              select
              label="Payment status"
              value={filters.paymentStatus ?? ''}
              onChange={(event) => onChange('paymentStatus', event.target.value)}
              size="small"
              className="payment-filter"
            >
              <MenuItem value="">All statuses</MenuItem>
              <MenuItem value="Pending">Pending</MenuItem>
              <MenuItem value="Overdue">Overdue</MenuItem>
              <MenuItem value="Paid">Paid</MenuItem>
              <MenuItem value="Unknown">Unknown</MenuItem>
            </TextField>
            <TextField
              label="Due from"
              type="date"
              value={filters.dueDateFrom ?? ''}
              onChange={(event) => onChange('dueDateFrom', event.target.value)}
              size="small"
              className="payment-filter"
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Due to"
              type="date"
              value={filters.dueDateTo ?? ''}
              onChange={(event) => onChange('dueDateTo', event.target.value)}
              size="small"
              className="payment-filter"
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </>
        )}
        {liveMode && (
          <TextField
            label="Invoice document status"
            value={filters.invoiceStatus ?? ''}
            onChange={(event) => onChange('invoiceStatus', event.target.value)}
            size="small"
            className="payment-filter"
            placeholder="Actual SAP status code"
            slotProps={{ htmlInput: { maxLength: 20 } }}
          />
        )}
        {liveMode && (
          <>
            <TextField
              label="Document date from"
              type="date"
              value={filters.documentDateFrom ?? ''}
              onChange={(event) => onChange('documentDateFrom', event.target.value)}
              size="small"
              className="payment-filter"
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Document date to"
              type="date"
              value={filters.documentDateTo ?? ''}
              onChange={(event) => onChange('documentDateTo', event.target.value)}
              size="small"
              className="payment-filter"
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Posting date from"
              type="date"
              value={filters.postingDateFrom ?? ''}
              onChange={(event) => onChange('postingDateFrom', event.target.value)}
              size="small"
              className="payment-filter"
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Posting date to"
              type="date"
              value={filters.postingDateTo ?? ''}
              onChange={(event) => onChange('postingDateTo', event.target.value)}
              size="small"
              className="payment-filter"
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </>
        )}
        <TextField
          label="Currency"
          value={filters.currency ?? ''}
          onChange={(event) => onChange('currency', event.target.value.toUpperCase())}
          size="small"
          className="payment-filter"
          slotProps={{ htmlInput: { maxLength: 3 } }}
        />
        <TextField
          label="Minimum amount"
          type="number"
          value={filters.minAmount ?? ''}
          onChange={(event) => onChange('minAmount', event.target.value)}
          size="small"
          className="payment-filter"
          slotProps={{ htmlInput: { min: 0, max: 999999999999, step: '0.01' } }}
        />
        <TextField
          label="Maximum amount"
          type="number"
          value={filters.maxAmount ?? ''}
          onChange={(event) => onChange('maxAmount', event.target.value)}
          size="small"
          className="payment-filter"
          slotProps={{ htmlInput: { min: 0, max: 999999999999, step: '0.01' } }}
        />
      </Box>
      <Box className="filter-actions">
        <Button type="submit" variant="contained" disableElevation>Apply Filters</Button>
        <Button type="button" onClick={onClear}>Clear Filters</Button>
      </Box>
    </Paper>
  )
}

function DashboardPage({
  summary,
  dataMode,
  records,
  total,
  loading,
  error,
  exportError,
  pageIndex,
  sortKey,
  sortDirection,
  onRefresh,
  onExport,
  onSort,
  onPageChange,
  onDetails,
}: {
  summary: PaymentSummary | null
  dataMode?: string
  records: PaymentObligation[]
  total: number
  loading: boolean
  error: string
  exportError: string
  pageIndex: number
  sortKey: SortKey
  sortDirection: SortDirection
  onRefresh: () => void
  onExport: () => void
  onSort: (key: SortKey) => void
  onPageChange: (page: number) => void
  onDetails: (record: PaymentObligation) => void
}) {
  const summaryAvailable = summary?.status !== 'unavailable'
  const liveInvoiceSummary = dataMode === 'live' && summary?.dataSource === 'live'
  const invoiceGrossByCurrency = summary?.invoiceGrossAmountByCurrency ?? summary?.totalInvoicedByCurrency
  const statusEntries = Object.entries(summary?.invoiceDocumentStatusSummary ?? {})
    .sort((left, right) => right[1] - left[1])
  return (
    <>
      <Box className="payment-summary" aria-label="Live invoice summary">
        <SummaryCard
          label="Supplier invoices"
          value={loading ? 'Loading…' : String(summary?.invoiceCount ?? total)}
          icon={<ReceiptLongOutlinedIcon />}
          tone="blue"
          detail="Matching live SAP records"
        />
        <SummaryCard
          label="Total invoice gross amount"
          value={loading ? 'Loading…' : liveInvoiceSummary
            ? formatCurrencyTotals(invoiceGrossByCurrency)
            : summaryAvailable
              ? formatCurrencyTotals(summary?.totalOutstandingAmountByCurrency ?? summary?.outstandingAmountByCurrency)
              : 'No verified totals'}
          icon={<AccountBalanceWalletOutlinedIcon />}
          tone="indigo"
          detail="Grouped by currency · not outstanding balance"
        />
        <SummaryCard
          label="Company codes"
          value={loading ? 'Loading…' : liveInvoiceSummary
            ? String(summary?.companyCodeCount ?? summary?.companyCodes?.length ?? 0)
            : '0'}
          icon={<CloudOutlinedIcon />}
          tone="green"
          detail={liveInvoiceSummary && summary?.companyCodes?.length
            ? summary.companyCodes.join(' · ')
            : 'Verified from live invoice records'}
        />
        <SummaryCard
          label="Invoice document status"
          value={loading ? 'Loading…' : statusEntries.length
            ? `${statusEntries.length} status${statusEntries.length === 1 ? '' : 'es'}`
            : 'Not provided'}
          icon={<PaidOutlinedIcon />}
          tone="amber"
          detail={statusEntries.length
            ? statusEntries.slice(0, 4).map(([status, count]) => `${status}: ${count}`).join(' · ')
            : 'SupplierInvoiceStatus was not returned'}
        />
      </Box>
      <PaymentRecords
        title={dataMode === 'live' ? 'Supplier invoices' : 'Payment obligations'}
        dataMode={dataMode}
        description={dataMode === 'live'
          ? 'Live SAP invoice records use the applied filters. Settlement status and due dates are not part of the current source.'
          : 'Records and summary use the same applied filters.'}
        records={records}
        total={total}
        loading={loading}
        error={error}
        pageIndex={pageIndex}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onRefresh={onRefresh}
        onExport={onExport}
        exportError={exportError}
        onSort={onSort}
        onPageChange={onPageChange}
        onDetails={onDetails}
      />
      {liveInvoiceSummary && (
        <Alert severity="info" className="data-coverage-note">
          Connected to live SAP supplier invoice data. Payment settlement analytics depend on the availability of verified accounting and clearing information.
        </Alert>
      )}
      {!liveInvoiceSummary && summary?.limitations.map((limitation) => (
        <Typography key={limitation} className="limitation-note">{limitation}</Typography>
      ))}
    </>
  )
}

function SearchPage({
  records,
  dataMode,
  total,
  loading,
  error,
  pageIndex,
  sortKey,
  sortDirection,
  onSort,
  onPageChange,
  onDetails,
}: {
  records: PaymentObligation[]
  dataMode?: string
  total: number
  loading: boolean
  error: string
  pageIndex: number
  sortKey: SortKey
  sortDirection: SortDirection
  onSort: (key: SortKey) => void
  onPageChange: (page: number) => void
  onDetails: (record: PaymentObligation) => void
}) {
  return (
    <PaymentRecords
      title={dataMode === 'live' ? 'Search SAP supplier invoices' : 'Search payment obligations'}
      dataMode={dataMode}
      description={dataMode === 'live'
        ? 'Search supplier IDs and verified invoice or document reference fields.'
        : 'Search supplier IDs and names, document references, invoice references, and payment references.'}
      records={records}
      total={total}
      loading={loading}
      error={error}
      pageIndex={pageIndex}
      sortKey={sortKey}
      sortDirection={sortDirection}
      onSort={onSort}
      onPageChange={onPageChange}
      onDetails={onDetails}
    />
  )
}

function PaymentRecords({
  title,
  description,
  dataMode,
  records,
  total,
  loading,
  error,
  pageIndex,
  sortKey,
  sortDirection,
  onRefresh,
  onExport,
  exportError,
  onSort,
  onPageChange,
  onDetails,
}: {
  title: string
  description: string
  dataMode?: string
  records: PaymentObligation[]
  total: number
  loading: boolean
  error: string
  pageIndex: number
  sortKey: SortKey
  sortDirection: SortDirection
  onRefresh?: () => void
  onExport?: () => void
  exportError?: string
  onSort: (key: SortKey) => void
  onPageChange: (page: number) => void
  onDetails: (record: PaymentObligation) => void
}) {
  const columns: Array<{ key: SortKey; label: string }> = dataMode === 'live'
    ? [
        { key: 'supplierId', label: 'Supplier ID' },
        { key: 'companyCode', label: 'Company code' },
        { key: 'documentReference', label: 'Invoice / document reference' },
        { key: 'documentDate', label: 'Document date' },
        { key: 'postingDate', label: 'Posting date' },
        { key: 'amount', label: 'Gross amount' },
        { key: 'currency', label: 'Currency' },
        { key: 'invoiceProcessingStatus', label: 'Invoice document status' },
      ]
    : [
        { key: 'supplierName', label: 'Supplier' },
        { key: 'documentReference', label: 'Document reference' },
        { key: 'amount', label: 'Amount' },
        { key: 'currency', label: 'Currency' },
        { key: 'dueDate', label: 'Due date' },
        { key: 'paymentStatus', label: 'Payment status' },
      ]

  return (
    <Paper className="payments-panel records-panel" elevation={0}>
      <Box className="payment-panel-heading">
        <Box>
          <Typography variant="h2">{title}</Typography>
          <Typography className="section-description">{description}</Typography>
        </Box>
        <Box className="record-actions">
          <Typography className="payment-result-count">{loading ? 'Loading…' : `${total} records`}</Typography>
          {onRefresh && <Button aria-label="Refresh payment records" onClick={onRefresh}><RefreshRoundedIcon fontSize="small" /></Button>}
          {onExport && (
            <Button startIcon={<DownloadOutlinedIcon />} onClick={onExport} disabled={loading || Boolean(error)}>
              Export CSV
            </Button>
          )}
        </Box>
      </Box>
      {error && <Alert severity="error" className="inline-alert">{error}</Alert>}
      {exportError && <Alert severity="error" className="inline-alert">{exportError}</Alert>}
      <Box className="table-frame payment-table-frame" aria-busy={loading}>
        <Box className="table-scroll">
          <table className="partner-table payments-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key} aria-sort={sortKey === column.key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" className="sort-button" onClick={() => onSort(column.key)}>
                      {column.label}{sortKey === column.key ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
                    </button>
                  </th>
                ))}
                <th>Data source</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  {dataMode === 'live' ? (
                    <>
                      <td><Typography className="supplier-id">{liveValue(record.supplierId)}</Typography></td>
                      <td>{liveValue(record.companyCode)}</td>
                      <td>{liveValue(record.documentReference ?? record.invoiceReference)}</td>
                      <td>{formatLiveDate(record.documentDate)}</td>
                      <td>{formatLiveDate(record.postingDate)}</td>
                      <td className="amount-cell">{liveAmount(record.amount ?? record.invoiceAmount, record.currency)}</td>
                      <td>{liveValue(record.currency)}</td>
                      <td><Chip size="small" label={liveValue(record.invoiceProcessingStatus)} variant="outlined" /></td>
                    </>
                  ) : (
                    <>
                      <td>
                        <Typography className="supplier-name">{displayValue(record.supplierName)}</Typography>
                        <Typography className="supplier-id">{displayValue(record.supplierId)}</Typography>
                      </td>
                      <td>{displayValue(record.documentReference ?? record.invoiceReference)}</td>
                      <td className="amount-cell">{formatAmount(record.amount ?? record.invoiceAmount, record.currency)}</td>
                      <td>{displayValue(record.currency)}</td>
                      <td>{formatDate(record.dueDate)}</td>
                      <td><StatusChip status={record.paymentStatus} /></td>
                    </>
                  )}
                  <td><Chip size="small" label={record.dataSource === 'demo' ? 'Demo' : 'Live'} className={record.dataSource === 'demo' ? 'data-mode-chip' : ''} /></td>
                  <td>
                    <Button
                      className="details-button"
                      aria-label={`View details for ${displayValue(record.documentReference ?? record.invoiceReference)}`}
                      onClick={() => onDetails(record)}
                      startIcon={<VisibilityOutlinedIcon />}
                    >
                      Details
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <LoadState label={dataMode === 'live' ? 'Loading live SAP invoices…' : 'Loading payment obligations…'} />}
          {!loading && !error && records.length === 0 && (
            <EmptyState
              title={dataMode === 'live' ? 'No live supplier invoices found' : 'No payment obligations found'}
              text="Try adjusting your search or filters."
            />
          )}
          {!loading && error && records.length === 0 && (
            <EmptyState title="Live data could not be loaded" text="Check the backend and SAP connection, then retry." />
          )}
        </Box>
        {total > PAGE_SIZE && (
          <Box className="pagination-bar">
            <Button size="small" disabled={pageIndex === 0 || loading} onClick={() => onPageChange(pageIndex - 1)}>Previous</Button>
            <Typography className="result-count">
              Page {pageIndex + 1} · {total} matching records
            </Typography>
            <Button size="small" disabled={(pageIndex + 1) * PAGE_SIZE >= total || loading} onClick={() => onPageChange(pageIndex + 1)}>Next</Button>
          </Box>
        )}
      </Box>
    </Paper>
  )
}

function SummaryCard({
  label,
  value,
  icon,
  tone,
  detail,
}: {
  label: string
  value: string
  icon: ReactNode
  tone: string
  detail?: string
}) {
  return (
    <Paper className="summary-card" elevation={0}>
      <Box className={`summary-icon summary-icon-${tone}`}>{icon}</Box>
      <Typography className="summary-label">{label}</Typography>
      <Typography className="summary-value">{value}</Typography>
      {detail && <Typography className="summary-detail">{detail}</Typography>}
    </Paper>
  )
}

function StatusChip({ status }: { status: PaymentStatus | null }) {
  if (status === null) {
    return <Chip className="payment-status" label="Unavailable" size="small" variant="outlined" />
  }
  const normalized = status
  const color = normalized === 'Paid' ? 'success' : normalized === 'Overdue' ? 'error' : 'warning'
  return <Chip className={`payment-status status-${normalized.toLowerCase()}`} label={normalized} color={color} size="small" />
}

function LoadState({ label }: { label: string }) {
  return (
    <Box className="payment-state" role="status">
      <CircularProgress size={24} />
      <Typography>{label}</Typography>
    </Box>
  )
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <Box className="payment-state">
      <Avatar className="empty-icon"><SearchRoundedIcon /></Avatar>
      <Typography className="empty-title">{title}</Typography>
      <Typography>{text}</Typography>
    </Box>
  )
}

function AssistantPage({
  question,
  messages,
  asking,
  error,
  dataMode,
  onQuestionChange,
  onSubmit,
  onSuggestion,
  onDetails,
}: {
  question: string
  messages: AssistantMessage[]
  asking: boolean
  error: string
  dataMode?: string
  onQuestionChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onSuggestion: (value: string) => void
  onDetails: (record: PaymentObligation) => void
}) {
  return (
    <Box>
      <Box className="section-heading assistant-page-heading">
        <Box>
          <Typography variant="h2">AI Payment Assistant</Typography>
          <Typography className="section-description">
            {dataMode === 'live'
              ? 'Ask questions about backend-retrieved SAP supplier invoices; payment status and outstanding balances are not verified.'
              : 'Ask questions about backend-filtered payment obligation records.'}
          </Typography>
        </Box>
        <Chip icon={<AutoAwesomeOutlinedIcon />} label="Local Ollama · llama3.2" size="small" className="assistant-chip" />
      </Box>
      {dataMode === 'demo' && (
        <Alert severity="warning" className="inline-alert">
          The assistant is answering from fictional demo records, not verified SAP data. Its generated explanation is not authoritative.
        </Alert>
      )}
      {dataMode === 'live' && (
        <Alert severity="warning" className="inline-alert">
          Live records are SAP invoices, not verified payment obligations. The assistant cannot verify paid, unpaid, overdue, or due-date claims from this source.
        </Alert>
      )}
      <Alert severity="info" className="inline-alert">
        Read-only assistant. It cannot create, approve, post, or execute payments. Missing fields are outside the current SAP invoice source.
      </Alert>
      <Paper className="assistant-panel payment-assistant-panel" elevation={0}>
        <Box className="assistant-examples" aria-label="Suggested questions">
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion}
              size="small"
              variant="outlined"
              disabled={asking}
              onClick={() => onSuggestion(suggestion)}
            >
              {suggestion}
            </Button>
          ))}
        </Box>
        <Box className="assistant-conversation" aria-live="polite">
          {messages.map((message, index) => (
            <Box key={`${message.role}-${index}`} className={`assistant-message assistant-message-${message.role}`}>
              <Typography className="assistant-message-text">{message.text}</Typography>
              {message.result && (
                <>
                  {message.result.dataMode === 'demo' && (
                    <Chip size="small" label="Based on demo sample records" className="data-mode-chip assistant-source-chip" />
                  )}
                  {message.result.dataMode === 'live' && (
                    <Chip size="small" label="Based on live SAP invoices" className="assistant-source-chip" variant="outlined" />
                  )}
                  <Typography className="assistant-evidence-count">
                    {message.result.matchedRecordCount} matching backend record(s)
                  </Typography>
                  {message.result.records.slice(0, 5).map((record) => (
                    <Button
                      key={record.id}
                      className="assistant-evidence-button"
                      onClick={() => onDetails(record)}
                    >
                      {liveValue(record.supplierId)} · {liveValue(record.documentReference ?? record.invoiceReference)}
                    </Button>
                  ))}
                  {message.result.limitations.length > 0 && (
                    <Typography className="assistant-limitations">
                      {message.result.limitations[0]}
                    </Typography>
                  )}
                </>
              )}
            </Box>
          ))}
          {asking && <Box className="assistant-loading" role="status"><CircularProgress size={18} /> Asking the backend assistant…</Box>}
        </Box>
        {error && <Alert severity="error" className="assistant-response">{error}</Alert>}
        <Box component="form" onSubmit={onSubmit} className="assistant-form">
          <TextField
            fullWidth
            multiline
            minRows={2}
            maxRows={5}
            label="Your question"
            placeholder="Ask about live supplier invoices, totals, suppliers, or document status..."
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            required
            disabled={asking}
            slotProps={{ htmlInput: { maxLength: 2000 } }}
          />
          <Button type="submit" variant="contained" disableElevation disabled={asking || !question.trim()}>
            {asking ? <CircularProgress size={20} color="inherit" /> : 'Ask assistant'}
          </Button>
        </Box>
      </Paper>
    </Box>
  )
}

function RecordDetails({
  record,
  loading,
  error,
  onClose,
}: {
  record: PaymentObligation | null
  loading: boolean
  error: string
  onClose: () => void
}) {
  const fields: Array<[string, string]> = record
    ? record.dataSource === 'live'
      ? [
          ['Supplier identifier', liveValue(record.supplierId)],
          ['Company code', liveValue(record.companyCode)],
          ['Document reference', liveValue(record.documentReference ?? record.invoiceReference)],
          ['Document date', formatLiveDate(record.documentDate)],
          ['Posting date', formatLiveDate(record.postingDate)],
          ['Invoice reference', liveValue(record.invoiceReference)],
          ['Invoice gross amount', liveAmount(record.amount ?? record.invoiceAmount, record.currency)],
          ['Currency', liveValue(record.currency)],
          ['Invoice document status', liveValue(record.invoiceProcessingStatus)],
          ['Payment reference', liveValue(record.paymentReference)],
          ['Data source', 'Live SAP invoice data'],
        ]
      : [
          ['Supplier', displayValue(record.supplierName)],
          ['Supplier identifier', displayValue(record.supplierId)],
          ['Company code', displayValue(record.companyCode)],
          ['Document reference', displayValue(record.documentReference ?? record.invoiceReference)],
          ['Document date', formatDate(record.documentDate)],
          ['Posting date', formatDate(record.postingDate)],
          ['Invoice reference', displayValue(record.invoiceReference)],
          ['Due date', formatDate(record.dueDate)],
          ['Amount', formatAmount(record.amount ?? record.invoiceAmount, record.currency)],
          ['Currency', displayValue(record.currency)],
          ['Payment status', displayValue(record.paymentStatus)],
          ['Invoice document status', displayValue(record.invoiceProcessingStatus)],
          ['Clearing date', formatDate(record.clearingDate ?? record.paymentDate)],
          ['Payment reference', displayValue(record.paymentReference)],
          ['Data source', 'Demo sample data'],
        ]
    : []

  return (
    <Dialog open={Boolean(record)} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle className="details-title">
        {record?.dataSource === 'live' ? 'SAP supplier invoice details' : 'Payment obligation details'}
      </DialogTitle>
      <DialogContent dividers>
        {loading && <LoadState label="Loading record details…" />}
        {error && <Alert severity="error">{error}</Alert>}
        {!loading && !error && record && (
          <Box component="dl" className="details-grid payment-details-grid">
            {fields.map(([label, value]) => (
              <DetailField key={label} label={label} value={value} />
            ))}
          </Box>
        )}
        {record?.dataSource === 'demo' && (
          <Alert severity="warning" className="inline-alert">
            Fictional demonstration record. Status and clearing information are not verified SAP data.
          </Alert>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <>
      <Typography component="dt">{label}</Typography>
      <Typography component="dd">{value}</Typography>
    </>
  )
}

export default App
