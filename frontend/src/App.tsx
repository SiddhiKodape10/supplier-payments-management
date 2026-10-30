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
  Tooltip,
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
  getAccountingLineItems,
  getHealth,
  getPaymentDetails,
  getPaymentObligations,
  getPaymentSummary,
  getSapConnectionStatus,
  type HealthStatus,
  type AccountingLineItem,
  type PaymentAssistantResponse,
  type PaymentFilters,
  type PaymentObligation,
  type PaymentStatus,
  type PaymentSummary,
  type SapConnectionStatus,
} from './services/api'
import './App.css'

type Page = 'dashboard' | 'assistant'
type SortKey = 'supplierId' | 'companyCode' | 'supplierName' | 'documentReference' | 'documentDate' | 'postingDate' | 'amount' | 'currency' | 'dueDate' | 'paymentStatus' | 'invoiceProcessingStatus'
type SortDirection = 'asc' | 'desc'

const PAGE_SIZE = 25
const initialFilters: PaymentFilters = {}
const suggestions = [
  'Summarize outstanding supplier balances.',
  'Show overdue accounting items.',
  'Find open items for supplier 100012.',
  'Show company code 1010 exposure.',
  'Summarize outstanding balances by currency.',
  'Explain why an accounting item was classified as overdue.',
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

function formatMetricValue(
  metricKey: 'totalOutstandingAmount' | 'overdueAmount' | 'overdueItems' | 'upcomingPaymentObligations' | 'completedPayments' | 'outstandingItems' | 'suppliersWithOutstandingBalances' | 'clearedAccountingItems',
  summary: PaymentSummary | null,
  fallbackMap?: Record<string, number>
): string {
  if (!summary) return '—'
  const metric = summary.metrics?.[metricKey]
  const status = summary.metricStatus?.[metricKey]
  const isAvailable = metric ? metric.available : status === 'available'

  if (!isAvailable) return '—'

  if (metricKey === 'outstandingItems' || metricKey === 'overdueItems' || metricKey === 'suppliersWithOutstandingBalances' || metricKey === 'clearedAccountingItems') {
    if (typeof metric?.totalCount === 'number') return String(metric.totalCount)
    if (metricKey === 'outstandingItems' && typeof summary.outstandingItemCount === 'number') return String(summary.outstandingItemCount)
    if (metricKey === 'overdueItems' && typeof summary.overdueItemCount === 'number') return String(summary.overdueItemCount)
    if (metricKey === 'suppliersWithOutstandingBalances' && typeof summary.suppliersWithOutstandingBalances === 'number') return String(summary.suppliersWithOutstandingBalances)
    if (metricKey === 'clearedAccountingItems' && typeof summary.clearedAccountingItems === 'number') return String(summary.clearedAccountingItems)
    if (metric?.byCurrency && metric.byCurrency.length > 0) {
      return String(metric.byCurrency.reduce((sum, item) => sum + item.count, 0))
    }
    return '0'
  }

  if (metric?.byCurrency && metric.byCurrency.length > 0) {
    return metric.byCurrency.map((item) => formatAmount(item.amount, item.currency)).join(' · ')
  }

  if (fallbackMap && Object.keys(fallbackMap).length > 0) {
    return formatCurrencyTotals(fallbackMap)
  }

  return '—'
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

function mapAccountingLineItems(records: AccountingLineItem[]): PaymentObligation[] {
  return records.map((record) => {
    const grossVal = record.grossAmount ? Number(record.grossAmount) : (typeof record.amount === 'number' ? Math.abs(record.amount) : null)
    return {
      id: record.id,
      supplierId: record.supplierId,
      supplierName: record.supplierName,
      companyCode: record.companyCode,
      documentReference: record.accountingDocument,
      invoiceReference: record.invoiceReference,
      documentDate: record.documentDate,
      postingDate: record.postingDate,
      dueDate: record.dueDate,
      amount: grossVal,
      grossAmount: grossVal,
      currency: record.currency ?? record.balanceCurrency,
      paymentStatus: null,
      invoiceProcessingStatus: record.openItemStatus,
      statusReason: record.statusReason,
      clearingDate: record.clearingDate,
      paymentReference: record.clearingDocument,
      dataSource: 'live',
      limitations: record.openItemStatus === 'Unverified' ? ['Open balance could not be verified for this accounting item.'] : [],
    }
  })
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
      const listPromise = page === 'dashboard'
        ? getAccountingLineItems(appliedFilters, { top: PAGE_SIZE, skip: pageIndex * PAGE_SIZE })
            .then((result) => ({ ...result, records: mapAccountingLineItems(result.records) }))
        : getPaymentObligations(appliedFilters, { top: PAGE_SIZE, skip: pageIndex * PAGE_SIZE })
      const [listResult, totalsResult] = await Promise.allSettled([listPromise, getPaymentSummary(appliedFilters)])

      if (listResult.status === 'fulfilled') {
        setRecords(uniqueRecords(listResult.value.records))
        setTotal(listResult.value.total)
      } else {
        setRecords([])
        setTotal(0)
      }

      if (totalsResult.status === 'fulfilled') {
        setSummary(totalsResult.value.summary)
      } else {
        setSummary(null)
      }

      const errors = [listResult, totalsResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => errorMessage(result.reason))
      setDataError(errors.join(' '))
    } finally {
      setLoading(false)
    }
  }, [appliedFilters, pageIndex, page])

  useEffect(() => {
    if (page !== 'dashboard') return
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
    if (page === 'dashboard' && health?.dataMode === 'live') {
      setDetailLoading(false)
      return
    }
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
      if (page === 'dashboard' && health?.dataMode === 'live') {
        const fields = ['supplierId','supplierName','companyCode','documentReference','documentDate','postingDate','dueDate','amount','currency','invoiceProcessingStatus','clearingDate','paymentReference','dataSource']
        const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
        const csv = [fields.join(','), ...sortedRecords.map((record) => fields.map((field) => escape(record[field as keyof PaymentObligation])).join(','))].join('\r\n')
        const blob = new Blob([`${csv}\r\n`], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = 'sap-accounting-line-items.csv'
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
        return
      }
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

  const clearChat = () => {
    setMessages([])
    setAssistantError('')
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
            <Button aria-current={page === 'assistant' ? 'page' : undefined} onClick={() => choosePage('assistant')}>
              <AutoAwesomeOutlinedIcon fontSize="small" /> AI Payment Assistant
            </Button>
          </Box>
        </Paper>

        {page === 'dashboard' && (
          <FilterPanel
            filters={draftFilters}
            onChange={updateDraft}
            onApply={applyFilters}
            onClear={clearFilters}
            searchPage={false}
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
            onClearChat={clearChat}
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
          label="Supplier name"
          value={filters.supplierName ?? ''}
          onChange={(event) => onChange('supplierName', event.target.value)}
          size="small"
          className="payment-filter"
          slotProps={{ htmlInput: { maxLength: 100 } }}
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
            select
            label="Verified status"
            value={filters.paymentStatus ?? ''}
            onChange={(event) => onChange('paymentStatus', event.target.value)}
            size="small"
            className="payment-filter"
          >
            <MenuItem value="">All statuses</MenuItem>
            <MenuItem value="Open">Open</MenuItem>
            <MenuItem value="Overdue">Overdue</MenuItem>
            <MenuItem value="Cleared">Cleared</MenuItem>
            <MenuItem value="Reversed">Reversed</MenuItem>
            <MenuItem value="Unverified">Unverified</MenuItem>
          </TextField>
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
  return (
    <>
      <Box className="payment-summary" aria-label="Verified accounting payment summary">
        {!loading && (
          <SummaryCard
            label="Total outstanding amount"
            value={formatMetricValue('totalOutstandingAmount', summary, summary?.outstandingAmountByCurrency)}
            icon={<AccountBalanceWalletOutlinedIcon />}
            tone="indigo"
            detail={summary?.metricStatus?.totalOutstandingAmount === 'available'
              ? 'Verified accounting balances by currency'
              : (summary?.metrics?.totalOutstandingAmount?.reason ?? 'Open-item evidence requires verified balance and direction fields')}
          />
        )}
        {!loading && (
          <SummaryCard
            label="Overdue amount"
            value={formatMetricValue('overdueAmount', summary, summary?.overdueAmountByCurrency)}
            icon={<PaidOutlinedIcon />}
            tone="amber"
            detail={summary?.metricStatus?.overdueAmount === 'available'
              ? `${summary?.overdueItemCount ?? 0} verified overdue items`
              : (summary?.metrics?.overdueAmount?.reason ?? 'Authoritative due date and open status are required')}
          />
        )}
        {!loading && (
          <SummaryCard
            label="Outstanding items"
            value={formatMetricValue('outstandingItems', summary, undefined)}
            icon={<ReceiptLongOutlinedIcon />}
            tone="amber"
            detail={summary?.metricStatus?.outstandingItems === 'available'
              ? 'Verified open accounting items'
              : (summary?.metrics?.outstandingItems?.reason ?? 'Stable item and open-status evidence is required')}
          />
        )}
        {!loading && (
          <SummaryCard
            label="Overdue items"
            value={formatMetricValue('overdueItems', summary, undefined)}
            icon={<PaidOutlinedIcon />}
            tone="orange"
            detail={summary?.metricStatus?.overdueItems === 'available'
              ? 'Verified overdue open items'
              : (summary?.metrics?.overdueItems?.reason ?? 'Authoritative due date and open status are required')}
          />
        )}
        {!loading && (
          <SummaryCard
            label="Suppliers with outstanding balances"
            value={formatMetricValue('suppliersWithOutstandingBalances', summary, undefined)}
            icon={<ReceiptLongOutlinedIcon />}
            tone="blue"
            detail={summary?.metricStatus?.suppliersWithOutstandingBalances === 'available'
              ? 'Distinct supplier IDs with verified open balances'
              : (summary?.metrics?.suppliersWithOutstandingBalances?.reason ?? 'Verified open balances are required to count suppliers')}
          />
        )}
        {!loading && (
          <SummaryCard
            label="Cleared accounting items"
            value={formatMetricValue('clearedAccountingItems', summary, undefined)}
            icon={<CheckCircleOutlineRoundedIcon />}
            tone="green"
            detail={summary?.metricStatus?.clearedAccountingItems === 'available'
              ? 'Accounting items with verified clearing evidence'
              : (summary?.metrics?.clearedAccountingItems?.reason ?? 'Clearing evidence fields are required to count cleared items')}
          />
        )}
      </Box>
      <PaymentRecords
        title={dataMode === 'live' ? 'Supplier accounting line items' : 'Payment obligations'}
        dataMode={dataMode}
        description={dataMode === 'live'
          ? 'Verified SAP accounting items with supplier, document, balance, currency, due date, and clearing evidence.'
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
      {dataMode === 'live' && (
        <Alert severity="info" className="data-coverage-note">
          Connected to live SAP supplier accounting data. Settlement status is not inferred from invoice or clearing fields alone.
        </Alert>
      )}
      {summary?.limitations.map((limitation) => (
        <Typography key={limitation} className="limitation-note">{limitation}</Typography>
      ))}
    </>
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
                      <td>
                        <Typography className="supplier-name">{liveValue(record.supplierName)}</Typography>
                        <Typography className="supplier-id">{liveValue(record.supplierId)}</Typography>
                      </td>
                      <td>{liveValue(record.companyCode)}</td>
                      <td>{liveValue(record.documentReference ?? record.invoiceReference)}</td>
                      <td>{formatLiveDate(record.documentDate)}</td>
                      <td>{formatLiveDate(record.postingDate)}</td>
                      <td className="amount-cell">{liveAmount(record.grossAmount ?? record.amount ?? record.invoiceAmount, record.currency)}</td>
                      <td>{liveValue(record.currency)}</td>
                      <td>
                        <StatusChip
                          status={record.invoiceProcessingStatus}
                          reason={record.statusReason}
                          liveMode
                        />
                      </td>
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

function StatusChip({
  status,
  reason,
  liveMode = false,
}: {
  status: PaymentStatus | string | null | undefined
  reason?: string | null
  liveMode?: boolean
}) {
  if (!status) {
    return <Chip className="payment-status" label="Unavailable" size="small" variant="outlined" />
  }
  if (liveMode) {
    const colorMap: Record<string, 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning'> = {
      Open: 'info',
      Overdue: 'error',
      Cleared: 'success',
      Reversed: 'default',
      Excluded: 'default',
      Unverified: 'warning',
    }
    const color = colorMap[status] ?? 'default'
    const chip = (
      <Chip
        className={`payment-status status-${status.toLowerCase()}`}
        label={status}
        color={color}
        size="small"
        variant={status === 'Excluded' || status === 'Reversed' ? 'outlined' : 'filled'}
      />
    )
    return reason ? (
      <Tooltip title={reason} arrow placement="top">
        <span>{chip}</span>
      </Tooltip>
    ) : chip
  }
  const normalized = status as PaymentStatus
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
  onClearChat,
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
  onClearChat: () => void
  onDetails: (record: PaymentObligation) => void
}) {
  const activeDataLabel = dataMode === 'live' ? 'Live SAP Data' : 'Demo Data'

  return (
    <Box>
      <Box className="section-heading assistant-page-heading">
        <Box>
          <Typography variant="h2">AI Payment Assistant</Typography>
          <Typography className="section-description">
            Ask questions about supplier balances and accounting items using available SAP data.
          </Typography>
        </Box>
        <Box className="assistant-toolbar">
          <Chip
            icon={<AutoAwesomeOutlinedIcon />}
            label={activeDataLabel}
            size="small"
            className="assistant-data-chip"
            variant="outlined"
          />
          <Button
            type="button"
            size="small"
            variant="outlined"
            onClick={onClearChat}
            className="assistant-clear-button"
            disabled={asking}
          >
            Clear Chat
          </Button>
        </Box>
      </Box>
      {dataMode === 'demo' && (
        <Alert severity="warning" className="inline-alert">
          The assistant is answering from fictional demo records and is not using verified SAP accounting values.
        </Alert>
      )}
      {dataMode === 'live' && (
        <Alert severity="warning" className="inline-alert">
          Live records are SAP accounting items, not verified payment obligations. The assistant must not infer completed payment status from invoice or clearing fields alone.
        </Alert>
      )}
      <Alert severity="info" className="inline-alert">
        Read-only assistant. It cannot create, approve, post, or execute payments. Missing fields remain unavailable unless they are explicitly supplied by SAP.
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
                    <Chip size="small" label="Based on live SAP data" className="assistant-source-chip" variant="outlined" />
                  )}
                  <Typography className="assistant-evidence-count">
                    Showing {Math.min(message.result.records.length, 5)} of {message.result.matchedRecordCount} matching {message.result.dataMode === 'live' ? 'live SAP accounting records' : 'demo records'}
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
            placeholder="Ask about supplier balances, overdue accounting items, or company-level totals..."
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            required
            disabled={asking}
            slotProps={{ htmlInput: { maxLength: 2000 } }}
          />
          <Button type="submit" variant="contained" disableElevation disabled={asking || !question.trim()}>
            {asking ? <CircularProgress size={20} color="inherit" /> : 'Send'}
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
          ['Invoice gross amount', liveAmount(record.grossAmount ?? record.amount ?? record.invoiceAmount, record.currency)],
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
