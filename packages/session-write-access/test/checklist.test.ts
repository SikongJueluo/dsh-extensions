import { describe, expect, it } from 'vitest'
import { directoryOptions } from '../src/client/checklist.js'

describe('directoryOptions', () => {
  it('pins the session workspace and includes ungranted workspaces', () => {
    const options = directoryOptions(
      '/projects/current',
      [],
      [],
      [
        { path: '/projects/other', title: 'Other' },
        { path: '/projects/current', title: 'Current' },
      ],
    )
    expect(options).toEqual([
      {
        path: '/projects/current',
        title: 'Current',
        checked: true,
        fixed: true,
        grant: false,
        coveredBy: undefined,
      },
      {
        path: '/projects/other',
        title: 'Other',
        checked: false,
        fixed: false,
        grant: false,
        coveredBy: undefined,
      },
    ])
  })

  it('merges grants with workspace rows and retains directories outside the registry', () => {
    const options = directoryOptions(
      '/current',
      [],
      [{ path: '/other' }, { path: '/external' }],
      [{ path: '/other', title: 'Other' }],
    )
    expect(options.map(({ path, checked, grant }) => ({ path, checked, grant }))).toEqual([
      { path: '/current', checked: true, grant: false },
      { path: '/other', checked: true, grant: true },
      { path: '/external', checked: true, grant: true },
    ])
  })

  it('keeps deployment and workspace descendants fixed without matching sibling prefixes', () => {
    const options = directoryOptions(
      '/current',
      ['/shared'],
      [],
      [
        { path: '/current/child', title: 'Child' },
        { path: '/shared/project', title: 'Shared' },
        { path: '/shared-other', title: 'Sibling' },
      ],
    )
    expect(options.find(({ path }) => path === '/current/child')).toMatchObject({
      fixed: true,
      checked: true,
    })
    expect(options.find(({ path }) => path === '/shared/project')).toMatchObject({
      fixed: true,
      checked: true,
      coveredBy: '/shared',
    })
    expect(options.find(({ path }) => path === '/shared-other')).toMatchObject({
      fixed: false,
      checked: false,
    })
  })

  it('keeps a child checked after removing its exact grant when its parent is still granted', () => {
    const workspaces = [{ path: '/parent/child', title: 'Child' }]
    const before = directoryOptions(
      '/current',
      [],
      [{ path: '/parent' }, { path: '/parent/child' }],
      workspaces,
    )
    const after = directoryOptions('/current', [], [{ path: '/parent' }], workspaces)
    expect(before.find(({ path }) => path === '/parent/child')).toMatchObject({
      checked: true,
      grant: true,
      coveredBy: '/parent',
    })
    expect(after.find(({ path }) => path === '/parent/child')).toMatchObject({
      checked: true,
      grant: false,
      coveredBy: '/parent',
    })
  })

  it('recognizes filesystem roots and Windows directory separators', () => {
    expect(
      directoryOptions('/', [], [], [{ path: '/project', title: 'Project' }])[1],
    ).toMatchObject({ fixed: true, checked: true })
    const options = directoryOptions(
      'C:\\project',
      ['D:\\'],
      [],
      [
        { path: 'D:\\shared', title: 'Shared' },
        { path: 'C:\\project-other', title: 'Other' },
      ],
    )
    expect(options[2]).toMatchObject({ fixed: true, checked: true })
    expect(options[3]).toMatchObject({ fixed: false, checked: false })
  })
})
