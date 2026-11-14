import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OWNER_COOKIE_BOUNDARY_WARNING, assertManagementIdentity, ownerCookieBoundaryWarning } from '../src/security.js'

describe('management identity warning', () => {
  it('reports the owner-cookie boundary when the credentials file is readable', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-swa-sec-'))
    writeFileSync(join(home, '.credentials.yaml'), 'secret: donotread\n')
    expect(ownerCookieBoundaryWarning({ HOME: home, DSH_HOME: home })).toBe(OWNER_COOKIE_BOUNDARY_WARNING)
  })

  it('stays quiet when the credentials file is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-swa-sec-'))
    mkdirSync(join(home, 'empty'))
    expect(ownerCookieBoundaryWarning({ HOME: home, DSH_HOME: join(home, 'empty') })).toBeUndefined()
  })

  it('refuses isolated mode while the cookie secret is readable', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-swa-sec-'))
    writeFileSync(join(home, '.credentials.yaml'), 'secret: donotread\n')
    const environment = { HOME: home, DSH_HOME: home }
    expect(() => assertManagementIdentity('isolated', environment)).toThrow(/refuses to load/)
    expect(() => assertManagementIdentity('owner-cookie', environment)).not.toThrow()
    const empty = mkdtempSync(join(tmpdir(), 'dsh-swa-sec-'))
    expect(() => assertManagementIdentity('isolated', { HOME: empty, DSH_HOME: empty })).not.toThrow()
  })

  it('never claims the route is user-only without host support', () => {
    expect(OWNER_COOKIE_BOUNDARY_WARNING).toMatch(/NOT an Agent-proof authorization boundary/)
    expect(OWNER_COOKIE_BOUNDARY_WARNING).toMatch(/separate OS user|user-presence/)
  })
})
