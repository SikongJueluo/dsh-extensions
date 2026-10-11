// Smoke checks for the pure matcher (run after `pnpm build`):
//   node packages/cmd-permit/smoke.mjs
import { isHighRisk } from 'dsh-auto-permit'
import {
  compileRules,
  decideAllow,
  segmentHead,
  splitSegments,
} from './lib/index.js'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`)
  if (!ok) failed += 1
}

const rules = compileRules({
  allow: ['cargo', 'rtk', 'direnv'],
  allowPattern: ['^gh pr\\b'],
  denyShape: ['\\bsudo\\b'],
})

check('split covers all five operators', splitSegments('a && b || c ; d | e\nf').length === 6)
check('env-prefix head is unwrapped', segmentHead('FOO=1 cargo build') === 'cargo')
check('path head becomes basename', segmentHead('/usr/bin/cargo build') === 'cargo')
check('wrapper env skips its assignments', segmentHead('env RUSTFLAGS=-g cargo t') === 'cargo')

check('simple name allows', decideAllow('cargo build --release', rules).kind === 'allow')
check('rtk-wrapped command allows (rtk is the head)', decideAllow('rtk git status', rules).kind === 'allow')
check('compound all-covered allows', decideAllow('cargo build && cargo test', rules).kind === 'allow')
check('compound one-uncovered defers', decideAllow('cargo build && npm install', rules).kind === 'none')
check('pattern segment allows', decideAllow('gh pr list', rules).kind === 'allow')
check('pattern does not leak to siblings', decideAllow('gh repo delete x', rules).kind === 'none')
check('pipeline needs every stage', decideAllow('cargo build | grep error', rules).kind === 'none')
check('substitution never matches', decideAllow('cargo build && echo $(rm -rf ~)', rules).kind === 'none')
check('quoted operator over-splits (fail-closed)', decideAllow('echo "a && b"', rules).kind === 'none')
check('empty command defers', decideAllow('', rules).kind === 'none')

check('denyShape compiles', rules.denyShapes.length === 1)
check(
  'invalid regex skipped and reported',
  compileRules({ allow: [], allowPattern: ['[unclosed'], denyShape: [] }).issues.invalidPatterns.length === 1,
)
check('builtin high-risk table reachable from sibling', isHighRisk('sudo rm -rf /tmp/x'))

process.exit(failed === 0 ? 0 : 1)
