import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no types
import { checkCommitMessage } from '../../scripts/commit-msg.mjs'

const ok = (m: string, c?: string) => expect(checkCommitMessage(m, c), m).toBeNull()
const bad = (m: string, c?: string) => expect(checkCommitMessage(m, c), m).toEqual(expect.any(String))
const SCISSORS = '# ------------------------ >8 ------------------------'

describe('commit-msg hook', () => {
  it('takes the spec examples as one-line headers', () => {
    ok('feat: allow provided config object to extend other configs\n')
    ok('feat!: send an email to the customer when a product is shipped\n')
    ok('feat(api)!: send an email to the customer when a product is shipped\n')
    ok('docs: correct spelling of CHANGELOG\n')
    ok('feat(lang): add Polish language\n')
    ok('fix: prevent racing of requests\n')
    ok('revert: let us never again speak of the noodle incident\n')
  })
  it('takes scopes, unicode and what an editor leaves behind', () => {
    ok('fix(поле): тримати деталь\n')
    ok('feat(a/b): x\n')
    ok('feat(a,b-c.d_e): x\n')
    ok('feat: 😀')
    ok('feat: x')
    ok('feat: x\n\n\n')
    ok('feat: x \n')
    ok('feat: x\r\n')
    ok('feat: x\r\n\r\n# comment\r\n')
    ok('docs: x\n# Please enter the commit message\n#\tmodified:   src/a.ts\n')
    ok(`ci: x\n${SCISSORS}\n# Do not modify or remove the line above.\ndiff --git a/x b/x\n+body\n`)
    ok(`ci: x\n${SCISSORS}\nleft over\n`)
    ok('feat: x\n; comment\n', ';')
  })
  it('lets the subjects git writes through, one line each', () => {
    ok("Merge branch 'main' into feat/x\n")
    ok("Merge branch 'main'\n")
    ok("Merge remote-tracking branch 'origin/main'\n")
    ok("Merge tag 'v1.0'\n")
    ok('Merge pull request #68 from org/feat/x\n')
    ok('Revert "feat: add a part"\n')
    ok('Revert "feat: add a part"\n\nThis reverts commit 0123abc.\n')
    ok('Reapply "feat: add a part"\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.\n')
    ok('fixup! feat: add a part\n')
  })
  it('rejects a body and trailers, however they are dressed', () => {
    bad('feat: add a part\n\nlonger text\n')
    bad('feat: add a part\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n')
    bad('feat: add a part\n\nSigned-off-by: someone <a@b.c>\n')
    bad('feat: x\r\n\r\nCo-Authored-By: y\r\n')
    bad('feat: x\n\n# Co-Authored-By: y <y@z>\n')
    bad('ci: x\ndiff --git a/x b/x\nCo-Authored-By: y\n')
    bad('feat: y\n#body\n', ';')
    bad('Merge stuff\n\nCo-Authored-By: x\n')
    bad("Merge branch 'main'\n\nCo-Authored-By: x\n")
    bad('Merge whatever I want\n')
    bad('Merge \n')
    bad('fixup! x\n\nCo-Authored-By: y\n')
    bad('amend! x\n\nbody\n')
    bad('squash! \n')
    bad('Revert "x\n\nSigned-off-by: y\n')
    bad('Revert "x"\n\nThis reverts commit abc1234.\n\nSigned-off-by: y\n')
  })
  it('rejects anything not Conventional Commits', () => {
    for (const m of ['', '\n\n', 'add a part', ' feat: x', 'Feat: x', 'FEAT: x', 'feature: x', 'feat-x: y',
      'feat:x', 'feat:  x', 'feat:\tx', 'feat: x', 'feat: ', 'feat:', 'feat!:', 'feat: ​',
      'feat!(api): x', 'feat !: x', 'feat(api)! : x', 'feat!!: x', 'feat : x',
      'feat(): x', 'feat(a b): x', 'feat((a)): x', 'feat(a)(b): x', 'feat(a(b)): x', 'feat(!): x', 'feat(a:b): x',
      'EMUL-12: x']) bad(m + '\n')
  })
})
