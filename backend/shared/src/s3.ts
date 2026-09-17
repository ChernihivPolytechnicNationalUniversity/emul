import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import type { Readable } from "node:stream"
import { config } from "./config.ts"

const { bucket, ...client } = config.s3
export const s3 = new S3Client(client)

/** Fail at start rather than on the first job when the bucket or the credentials are wrong. */
export async function checkBucket() {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }))
}

export async function putObject(key: string, body: Buffer | string, contentType: string) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }))
}

/** The object as a stream with its headers, to pipe straight into an HTTP response. */
export async function getObject(key: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return { body: res.Body as Readable, size: res.ContentLength, contentType: res.ContentType }
}
