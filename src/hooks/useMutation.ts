import { useState, useCallback } from 'react'
import type { RecordModel } from 'pocketbase'
import pb from '../pb'

export function useMutation<T extends RecordModel>(collection: string) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const create = useCallback(
    async (data: Record<string, unknown>) => {
      setIsLoading(true)
      setError(null)
      try {
        const record = await pb.collection(collection).create<T>(data)
        return record
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        setError(e)
        throw e
      } finally {
        setIsLoading(false)
      }
    },
    [collection],
  )

  const update = useCallback(
    async (id: string, data: Record<string, unknown>) => {
      setIsLoading(true)
      setError(null)
      try {
        const record = await pb.collection(collection).update<T>(id, data)
        return record
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        setError(e)
        throw e
      } finally {
        setIsLoading(false)
      }
    },
    [collection],
  )

  const remove = useCallback(
    async (id: string) => {
      setIsLoading(true)
      setError(null)
      try {
        await pb.collection(collection).delete(id)
        return true
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        setError(e)
        throw e
      } finally {
        setIsLoading(false)
      }
    },
    [collection],
  )

  return { create, update, remove, isLoading, error }
}
