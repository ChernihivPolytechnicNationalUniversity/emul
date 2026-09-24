import type { BuildOptions, SourceFile, Target } from "emul-shared/source"

/**
 * The build service, as the site sees it: `POST /api/jobs` with the project, then poll
 * `GET /api/jobs/:id` until the job leaves the queue. Files come back as presigned URLs on
 * the object store; the browser downloads them from there, not through the API.
 */

export type JobArtifact = { name: string; size: number; contentType: string; url: string }

export type JobStatus = {
  id: string
  state: string
  /** Null while the job is queued or running. */
  result: { ok: boolean; error: string | null; finishedAt: string; durationMs: number } | null
  artifacts: JobArtifact[]
  /** Set when the service itself failed on the job (no result then). */
  error: string | null
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    if (body.error) return body.error
  } catch {
    // Not JSON: the status line is all there is.
  }
  return `${res.status} ${res.statusText}`
}

export async function submitBuild(target: Target, files: SourceFile[], options: BuildOptions = {}): Promise<string> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "build", target, files, options }),
  })
  if (!res.ok) throw new Error(await readError(res))
  const body = (await res.json()) as { id: string }
  return body.id
}

export async function getJob(id: string): Promise<JobStatus> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as JobStatus
}

const DONE = new Set(["completed", "failed"])

/** Resolves with the job's final status; `signal` aborts the wait (the job itself runs on). */
export async function waitForJob(id: string, signal?: AbortSignal, intervalMs = 1000): Promise<JobStatus> {
  for (;;) {
    const job = await getJob(id)
    if (DONE.has(job.state)) return job
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, intervalMs)
      signal?.addEventListener("abort", () => {
        clearTimeout(t)
        reject(new DOMException("aborted", "AbortError"))
      })
    })
  }
}

export async function fetchArtifact(artifact: JobArtifact, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(artifact.url, { signal })
  if (!res.ok) throw new Error(`${artifact.name}: ${res.status} ${res.statusText}`)
  return new Uint8Array(await res.arrayBuffer())
}

export async function fetchText(artifact: JobArtifact, signal?: AbortSignal): Promise<string> {
  const res = await fetch(artifact.url, { signal })
  if (!res.ok) throw new Error(`${artifact.name}: ${res.status} ${res.statusText}`)
  return res.text()
}
