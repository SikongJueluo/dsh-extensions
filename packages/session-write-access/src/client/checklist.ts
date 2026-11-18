export interface WorkspaceOption {
  path: string
  title: string
}

export interface DirectoryOption {
  path: string
  title?: string
  checked: boolean
  fixed: boolean
  grant: boolean
  coveredBy?: string
}

function contains(parent: string, child: string): boolean {
  const separator = parent.includes('\\') ? '\\' : '/'
  const prefix = parent.endsWith(separator) ? parent : parent + separator
  return parent === child || child.startsWith(prefix)
}

export function directoryOptions(
  workspaceRoot: string,
  deploymentRoots: readonly string[],
  grants: readonly { path: string }[],
  workspaces: readonly WorkspaceOption[],
): DirectoryOption[] {
  const titles = new Map(workspaces.map((workspace) => [workspace.path, workspace.title]))
  const fixedRoots = [workspaceRoot, ...deploymentRoots]
  const grantRoots = grants.map((grant) => grant.path)
  const paths = new Set([
    ...fixedRoots,
    ...grantRoots,
    ...workspaces.map((workspace) => workspace.path),
  ])
  return [...paths].map((path) => {
    const fixed = fixedRoots.some((root) => contains(root, path))
    const grant = grantRoots.includes(path)
    const coveredBy = [...fixedRoots, ...grantRoots].find(
      (root) => root !== path && contains(root, path),
    )
    return {
      path,
      title: titles.get(path),
      checked: fixed || grant || coveredBy !== undefined,
      fixed,
      grant,
      coveredBy,
    }
  })
}
