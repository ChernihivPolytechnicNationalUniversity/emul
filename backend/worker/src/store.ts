/**
 * The worker's whole view of the object store: the presigned URLs in the job's data. No
 * credentials live here, so nothing the compiled code could read from this process is worth
 * reading.
 */

export async function download(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

export async function upload(url: string, body: Buffer | string, contentType: string): Promise<void> {
  const res = await fetch(url, { method: "PUT", body, headers: { "content-type": contentType } })
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${res.statusText}`)
}

export const uploadJson = (url: string, value: unknown) => upload(url, JSON.stringify(value, null, 2), "application/json")
