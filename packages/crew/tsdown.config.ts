import { defineHostConfig } from '../../tooling/host/index.ts'

export default {
  ...defineHostConfig(),

  deps: {
    alwaysBundle: ['@dsh-extensions/config'],
    dts: { alwaysBundle: ['@dsh-extensions/config'] },
  },
}
