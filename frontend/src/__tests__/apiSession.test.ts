import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('refreshSession', () => {
  it('shares one rotating-cookie request across concurrent callers and clears it after settlement', async () => {
    let resolveFetch!: (response: Response) => void
    const mockFetch = vi.fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveFetch = resolve }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ accessToken: 'next-token' }),
      } as Response)
    vi.stubGlobal('fetch', mockFetch)
    const { refreshSession } = await import('../lib/api')

    const first = refreshSession()
    const second = refreshSession()
    expect(first).toBe(second)
    expect(mockFetch).toHaveBeenCalledOnce()

    resolveFetch({
      ok: true,
      json: async () => ({ accessToken: 'shared-token' }),
    } as Response)
    await expect(first).resolves.toEqual({ accessToken: 'shared-token' })
    await expect(second).resolves.toEqual({ accessToken: 'shared-token' })

    await expect(refreshSession()).resolves.toEqual({ accessToken: 'next-token' })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('clears a rejected flight so a later caller can retry', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ accessToken: 'recovered-token' }),
      } as Response)
    vi.stubGlobal('fetch', mockFetch)
    const { refreshSession } = await import('../lib/api')

    await expect(refreshSession()).rejects.toThrow('network down')
    await expect(refreshSession()).resolves.toEqual({ accessToken: 'recovered-token' })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
