/** Binary → base64 in chunks: `String.fromCharCode(...all)` would overflow the stack on a firmware image. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
