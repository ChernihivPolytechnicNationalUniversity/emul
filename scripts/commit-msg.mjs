// Conventional Commits v1.0.0 in one line: no body, no trailers (Co-Authored-By, Signed-off-by…).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([\\p{L}\\p{N}._/,-]+\\))?!?: [^\\s\\u200b-\\u200d\\ufeff].*$`, 'u')
// Subjects git writes itself, each held to one line.
const MERGE = /^Merge ((branch(es)?|remote-tracking branch|tag|commit) '.+'|pull request #\d+ from \S+)( into \S+)?$/
const AUTOSQUASH = /^(fixup|squash|amend)! \S.*$/
const REVERT = /^(Revert|Reapply) ".+"$/
const REVERT_BODY = /^This reverts commit [0-9a-f]{7,40}\.$/
const SCISSORS = /^. -{24} >8 -{24}$/m
// A trailer hidden in a comment survives `git commit -m`, which keeps comment lines.
const TRAILER = /^\s*[\w-]+-by\s*:/i

export function checkCommitMessage(raw, commentChar = '#') {
  const text = raw.replace(/\r\n?/g, '\n').split(SCISSORS)[0]
  const lines = []
  for (const line of text.split('\n').map((l) => l.trimEnd())) {
    if (!line.startsWith(commentChar)) lines.push(line)
    else if (TRAILER.test(line.slice(commentChar.length))) return `no trailers, even commented out ("${line}")`
  }
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines.at(-1)) lines.pop()
  const subject = lines[0] ?? ''
  if (!subject) return 'the message is empty'
  const body = lines.slice(1).filter(Boolean)
  if (REVERT.test(subject) && body.length === 1 && REVERT_BODY.test(body[0])) return null
  if (body.length) return `one line only, no body or trailers (found "${body[0]}")`
  if (MERGE.test(subject) || AUTOSQUASH.test(subject) || REVERT.test(subject)) return null
  if (subject !== subject.trimStart()) return 'no leading spaces'
  if (!SUBJECT.test(subject)) return `not Conventional Commits: <type>[(scope)][!]: <description>, type one of ${TYPES.join(', ')}`
  return null
}

function gitCommentChar() {
  try {
    const c = execFileSync('git', ['config', 'core.commentChar'], { encoding: 'utf8' }).trim()
    return c && c !== 'auto' ? c : '#'
  } catch {
    return '#'
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const raw = readFileSync(process.argv[2], 'utf8')
  const error = checkCommitMessage(raw, gitCommentChar())
  if (error) {
    console.error(`\n✖ commit rejected: ${error}\n  ${raw.split('\n')[0]}\n  e.g. fix(field): keep a dragged part under the pointer\n`)
    process.exit(1)
  }
}
