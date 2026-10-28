import { mockSupplierPayments } from './mockSupplierPayments'

export type PaymentStatus = 'Paid' | 'Pending' | 'Overdue'

export interface SupplierPayment {
  id: string
  supplierId: string
  supplierName: string
  invoiceReference: string
  companyCode: string
  currency: string
  invoiceAmount: number
  dueDate: string
  paymentDate: string | null
  paymentStatus: PaymentStatus
}

export interface SupplierPaymentFilters {
  search?: string
  paymentStatus?: PaymentStatus | ''
  companyCode?: string
  currency?: string
}

export interface SupplierPaymentSummary {
  invoiceCount: number
  totalInvoiced: number
  paidAmount: number
  outstandingAmount: number
  overdueCount: number
}

export async function getSupplierPayments(
  filters: SupplierPaymentFilters = {},
): Promise<SupplierPayment[]> {
  const search = filters.search?.trim().toLocaleLowerCase() ?? ''

  return mockSupplierPayments.filter((payment) => {
    const matchesSearch =
      !search ||
      [
        payment.id,
        payment.supplierId,
        payment.supplierName,
        payment.invoiceReference,
        payment.companyCode,
        payment.currency,
        payment.invoiceAmount.toString(),
        payment.dueDate,
        payment.paymentDate ?? '',
        payment.paymentStatus,
      ].some((value) => value.toLocaleLowerCase().includes(search))

    return (
      matchesSearch &&
      (!filters.paymentStatus || payment.paymentStatus === filters.paymentStatus) &&
      (!filters.companyCode || payment.companyCode === filters.companyCode) &&
      (!filters.currency || payment.currency === filters.currency)
    )
  })
}

export async function getSupplierPayment(id: string): Promise<SupplierPayment | null> {
  return mockSupplierPayments.find((payment) => payment.id === id) ?? null
}

export async function getSupplierPaymentSummary(): Promise<SupplierPaymentSummary> {
  return mockSupplierPayments.reduce<SupplierPaymentSummary>(
    (summary, payment) => {
      summary.invoiceCount += 1
      summary.totalInvoiced += payment.invoiceAmount
      if (payment.paymentStatus === 'Paid') {
        summary.paidAmount += payment.invoiceAmount
      } else {
        summary.outstandingAmount += payment.invoiceAmount
      }
      if (payment.paymentStatus === 'Overdue') {
        summary.overdueCount += 1
      }
      return summary
    },
    {
      invoiceCount: 0,
      totalInvoiced: 0,
      paidAmount: 0,
      outstandingAmount: 0,
      overdueCount: 0,
    },
  )
}

export function getPaymentFilterOptions() {
  return {
    companyCodes: [...new Set(mockSupplierPayments.map((payment) => payment.companyCode))],
    currencies: [...new Set(mockSupplierPayments.map((payment) => payment.currency))],
  }
}
