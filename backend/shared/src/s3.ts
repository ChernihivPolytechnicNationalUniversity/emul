import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { s3Config } from "./config.ts"

const { bucket, publicEndpoint, ...client } = s3Config()
export const s3 = new S3Client(client)
// A signature covers the host, so URLs handed to browsers are signed by a client on the public endpoint.
const signer = new S3Client({ ...client, endpoint: publicEndpoint })

/** Fail at start rather than on the first job when the bucket or the credentials are wrong. */
export async function checkBucket() {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }))
}

export async function putObject(key: string, body: Buffer | string, contentType: string) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }))
}

export async function getObject(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return Buffer.from(await res.Body!.transformToByteArray())
}

export const getJson = async <T>(key: string) => JSON.parse((await getObject(key)).toString("utf8")) as T
export const putJson = (key: string, value: unknown) => putObject(key, JSON.stringify(value, null, 2), "application/json")

/** A URL to fetch one object, for the worker: same client as the API's own, inside the cluster. */
export function presignRead(key: string, ttlSeconds: number) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlSeconds })
}

/** A URL to write one object, for the worker; the content type comes with the PUT itself. */
export function presignWrite(key: string, ttlSeconds: number) {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlSeconds })
}

/** A URL the browser fetches straight from the store; the bucket itself stays private. */
export function presignGet(key: string, filename: string, ttlSeconds = 15 * 60) {
  return getSignedUrl(
    signer,
    new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: `attachment; filename="${filename}"` }),
    { expiresIn: ttlSeconds },
  )
}
