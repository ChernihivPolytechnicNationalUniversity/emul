import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { config } from "./config.ts"

const { bucket, publicEndpoint, ...client } = config.s3
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

/** A URL the browser fetches straight from the store; the bucket itself stays private. */
export function presignGet(key: string, filename: string, ttlSeconds = 15 * 60) {
  return getSignedUrl(
    signer,
    new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: `attachment; filename="${filename}"` }),
    { expiresIn: ttlSeconds },
  )
}
