// Conventional Commits v1.0.0 in one line: no body, no trailers (Co-Authored-By, Signed-off-by…).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([^()\\s]+\\))?!?: \\S.*$`)
const GIT_MADE = /^(Merge |Revert "|fixup! |squash! |amend! )/

export function checkCommitMessage(raw) {
  const lines = raw.split(/^diff --git /m)[0].split('\n').filter((l) => !l.startsWith('#'))
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines.at(-1).trim()) lines.pop()
  const subject = lines[0] ?? ''
  if (!subject.trim()) return 'the message is empty'
  if (GIT_MADE.test(subject)) return null
  if (lines.length > 1) return `one line only, no body or trailers (found "${lines.slice(1).find((l) => l.trim())}")`
  if (subject !== subject.trim()) return 'no leading or trailing spaces'
  if (!SUBJECT.test(subject)) return `not Conventional Commits: <type>[(scope)][!]: <description>, type one of ${TYPES.join(', ')}`
  return null
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const raw = readFileSync(process.argv[2], 'utf8')
  const error = checkCommitMessage(raw)
  if (error) {
    console.error(`\n✖ commit rejected: ${error}\n  ${raw.split('\n')[0]}\n  e.g. fix(field): keep a dragged part under the pointer\n`)
    process.exit(1)
  }
}
