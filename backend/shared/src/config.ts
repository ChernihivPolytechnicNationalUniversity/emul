/** Deployment settings from the environment; a missing required one fails the process at start. */
function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export const config = {
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  s3: {
    bucket: required("S3_BUCKET"),
    // Endpoint and path style are for MinIO and the like; left unset, the SDK targets AWS.
    endpoint: process.env.S3_ENDPOINT,
    // Where browsers reach the store: presigned URLs are signed against this host (the cluster-internal
    // endpoint is unreachable from outside). Unset: the same endpoint.
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    // Without keys the SDK falls back to its default chain (IAM role, IRSA, ~/.aws).
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
        : undefined,
  },
}
