import { defineHostConfig } from '../../tooling/host/index.ts'

export default {
  ...defineHostConfig(),
  // The shared config loader is a private workspace package; it is part of
  // each bundle so an installed bundle never needs a second runtime package.
  deps: {
    alwaysBundle: ['@dsh-extensions/config'],
    dts: { alwaysBundle: ['@dsh-extensions/config'] },
  },
}
