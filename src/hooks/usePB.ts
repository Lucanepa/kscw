import { useState, useEffect, useCallback } from 'react'
import type { RecordModel, ListResult, RecordListOptions } from 'pocketbase'
import pb from '../pb'

export function usePB<T extends RecordModel>(
  collection: string,
  options?: RecordListOptions & {
    page?: number
    perPage?: number
    enabled?: boolean
    all?: boolean
  },
) {
  const [data, setData] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const enabled = options?.enabled ?? true
  const all = options?.all ?? false
  const page = options?.page ?? 1
  const perPage = options?.perPage ?? 50
  const sort = options?.sort ?? ''
  const filter = options?.filter ?? ''
  const expand = options?.expand ?? ''
  const fields = options?.fields ?? ''

  const fetchData = useCallback(async () => {
    if (!enabled) {
      setData([])
      setTotal(0)
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const queryOpts: Record<string, string> = {}
      if (sort) queryOpts.sort = sort
      if (filter) queryOpts.filter = filter
      if (expand) queryOpts.expand = expand
      if (fields) queryOpts.fields = fields

      if (all) {
        const items = await pb.collection(collection).getFullList<T>(queryOpts)
        setData(items)
        setTotal(items.length)
      } else {
        const result: ListResult<T> = await pb.collection(collection).getList(page, perPage, queryOpts)
        setData(result.items)
        setTotal(result.totalItems)
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [collection, enabled, all, page, perPage, sort, filter, expand, fields])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return { data, total, isLoading, error, refetch: fetchData }
}
