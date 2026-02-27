import { useState, useEffect, useCallback } from 'react'
import type { RecordModel, ListResult, RecordListOptions } from 'pocketbase'
import pb from '../pb'

export function usePB<T extends RecordModel>(
  collection: string,
  options?: RecordListOptions & { page?: number; perPage?: number },
) {
  const [data, setData] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const page = options?.page ?? 1
  const perPage = options?.perPage ?? 50
  const sort = options?.sort ?? ''
  const filter = options?.filter ?? ''
  const expand = options?.expand ?? ''

  const fetch = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const result: ListResult<T> = await pb.collection(collection).getList(page, perPage, {
        sort,
        filter,
        expand,
      })
      setData(result.items)
      setTotal(result.totalItems)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [collection, page, perPage, sort, filter, expand])

  useEffect(() => {
    fetch()
  }, [fetch])

  return { data, total, isLoading, error, refetch: fetch }
}
