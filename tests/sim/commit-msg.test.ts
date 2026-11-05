import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no types
import { checkCommitMessage } from '../../scripts/commit-msg.mjs'

const ok = (m: string) => expect(checkCommitMessage(m)).toBeNull()
const bad = (m: string) => expect(checkCommitMessage(m)).toEqual(expect.any(String))

describe('commit-msg hook', () => {
  it('takes one-line Conventional Commits', () => {
    ok('feat: add a part\n')
    ok('fix(field-drag): keep the part under the pointer\n')
    ok('refactor(sim)!: drop the old netlist\n')
    ok('docs: x\n# Please enter the commit message\n# comment\n')
    ok('ci: hook\n\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n+body\n')
  })
  it('lets git-made subjects through', () => {
    ok("Merge branch 'main' into feat/x\n")
    ok('Merge pull request #68 from org/feat/x\n')
    ok('Revert "feat: add a part"\n\nThis reverts commit abc.\n')
    ok('fixup! feat: add a part\n')
  })
  it('rejects a body and trailers', () => {
    bad('feat: add a part\n\nlonger text\n')
    bad('feat: add a part\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n')
    bad('feat: add a part\n\nSigned-off-by: someone <a@b.c>\n')
  })
  it('rejects anything not Conventional Commits', () => {
    bad('')
    bad('\n\n')
    bad('add a part\n')
    bad('Feat: add a part\n')
    bad('feature: add a part\n')
    bad('feat:add a part\n')
    bad('feat:  add a part\n')
    bad('feat: \n')
    bad('feat(): add a part\n')
    bad('feat(a b): add a part\n')
    bad('EMUL-12: add a part\n')
  })
})
