/**
 * Management request dispatch for the browser page.
 *
 * The page's only authority. It is a pure function over an injected
 * orchestrator/service pair, so the browser half never reaches the state file
 * and this module stays testable without the DSH runtime.
 */

import { errorInfo } from './util.js'

/**
 * Host-side route path. The connection registry matches this string against the
 * request's exact `URL.pathname`, which always starts with a slash, so the
 * registered value must carry one.
 */
export const ROUTE = '/api/agent-crew'

/**
 * True when a registered route path can ever match an incoming request.
 * `connection.fetch` looks routes up by `new URL(request.url).pathname`, which
 * always begins with a slash, so a relative registration silently 404s.
 * @param {unknown} path
 * @returns {boolean}
 */
export function isMatchableRoutePath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.endsWith('/') && !path.includes('://')
}

/**
 * Browser-side relative reference to the same route. It resolves against the
 * page's base URL, so a deployment prefix and the desktop `dsh-app://app/`
 * origin both work without hard-coding an origin.
 */
export const ROUTE_RELATIVE = 'api/agent-crew'

/**
 * One management request → one response body.
 *
 * Every branch answers with `{ ok: true, data }` or
 * `{ ok: false, error: { code, message } }`; a thrown `CrewError` keeps its
 * stable code so the page can show it verbatim.
 *
 * @param {{ orchestrator: any, service: any }} deps
 * @param {unknown} body
 * @returns {Promise<{ ok: boolean, data?: Record<string, unknown>, error?: { code: string, message: string } }>}
 */
export async function dispatchManagement({ orchestrator, service }, body) {
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? /** @type {Record<string, any>} */ (body)
    : {}
  const action = typeof input.action === 'string' ? input.action : ''
  try {
    switch (action) {
      case 'list': {
        const limit = Math.min(50, Math.max(1, Math.trunc(Number(input.limitRuns) || 20)))
        const profiles = orchestrator.listProfiles({ includeInstructions: true })
        const runs = orchestrator
          .listRuns(limit)
          .map((run) => orchestrator.getRun(run.id, { previewChars: 400 }))
        return {
          ok: true,
          data: {
            dir: service.dataDir,
            provider: service.provider,
            limits: service.limits,
            warning: service.storeWarning ?? null,
            profiles,
            runs,
          },
        }
      }
      case 'saveProfile': {
        const profile = await orchestrator.defineProfile(input.profile ?? {}, { source: 'store' })
        return { ok: true, data: { profile } }
      }
      case 'deleteProfile': {
        const profile = await orchestrator.removeProfile(String(input.id ?? ''))
        return { ok: true, data: { id: profile.id, removed: true } }
      }
      case 'codexProviders': {
        // Enumerate what the running Host can actually delegate to. A codex
        // provider instance owns its model, so this is the only truthful view.
        const names = new Set()
        for (const profile of orchestrator.listProfiles()) {
          if ((profile.runtime ?? 'spawn') === 'codex' && profile.codexProvider) names.add(profile.codexProvider)
        }
        const rows = [...names].map((name) => {
          const provider = service.getProvider?.(name)
          return {
            name,
            ready: provider !== undefined,
            model: provider?.config?.model ?? null,
          }
        })
        return { ok: true, data: { providers: rows } }
      }
      case 'mentionables': {
        // The @ menu runs on every keystroke: answer with the smallest useful row.
        const profiles = orchestrator.listProfiles()
        return {
          ok: true,
          data: {
            profiles: profiles.map((profile) => ({
              id: profile.id,
              name: profile.name,
              role: profile.role,
              tools: profile.tools,
              runtime: profile.runtime ?? 'spawn',
              memoryCount: profile.memoryCount ?? 0,
            })),
          },
        }
      }
      case 'memoryClear': {
        const result = await orchestrator.manageMemory({ profileId: String(input.id ?? ''), action: 'clear' })
        return { ok: true, data: result }
      }
      case 'memoryRead': {
        const result = await orchestrator.manageMemory({
          profileId: String(input.id ?? ''),
          action: 'read',
          kind: input.kind,
          title: input.title,
          query: input.query,
          limit: input.limit,
        })
        return { ok: true, data: result }
      }
      case 'deleteRun': {
        const removed = await orchestrator.removeRun(String(input.id ?? ''))
        return { ok: true, data: removed }
      }
      default:
        return {
          ok: false,
          error: { code: 'UNKNOWN_ACTION', message: `Unknown action ${JSON.stringify(action)}.` },
        }
    }
  } catch (error) {
    const info = errorInfo(error)
    return { ok: false, error: { code: info.code, message: info.message } }
  }
}

/**
 * Build the Fetch route the browser page calls.
 *
 * Kept here, next to the dispatcher, so the exact registered path and the
 * request decoding are testable without the DSH runtime: the route object is
 * plain data plus a `fetch` function.
 *
 * @param {{ orchestrator: any, service: any }} deps
 * @returns {{ path: string, methods: string[], requestBody: 'buffered', fetch: (request: any) => Promise<Response> }}
 */
export function createManagementRoute({ orchestrator, service }) {
  if (!isMatchableRoutePath(ROUTE)) {
    throw new Error(`agent-crew management route ${JSON.stringify(ROUTE)} must be an absolute path without a trailing slash`)
  }
  return {
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let body
      try {
        body = await request.json()
      } catch {
        return Response.json(
          { ok: false, error: { code: 'BAD_REQUEST', message: 'The body is not JSON.' } },
          { status: 400 },
        )
      }
      const answer = await dispatchManagement({ orchestrator, service }, body)
      return Response.json(answer, { headers: { 'cache-control': 'no-store' } })
    },
  }
}
