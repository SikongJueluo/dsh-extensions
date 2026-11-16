import tailwindcss from '@tailwindcss/vite'
import type { Plugin, UserConfig } from 'vite'

/**
 * Runtime requests the DSH web shell answers from its frozen platform table.
 * Everything else (Base UI, CVA, tailwind-merge, lucide) must be bundled into
 * the client artifact: the table is closed and `dsh.client.external` only adds
 * exact package rows, never arbitrary npm dependencies.
 */
const DSH_PLATFORM_MODULES = [
  /^react$/,
  /^react\/jsx-runtime$/,
  /^react\/jsx-dev-runtime$/,
  /^react-dom$/,
  /^react-dom\/client$/,
]

/**
 * Exact host module rows outside React that the shell seeds into its frozen
 * table. Requesting one is a deliberate, pinned host coupling: the package must
 * also declare it under `dsh.client.external`, and `scripts/check-client.mjs`
 * rejects an undeclared request. Keep this list exact; never widen it to a
 * package prefix.
 */
const DSH_HOST_MODULES = ['@deepseek-ai/dsh-client-ui-primitives']

export interface DshClientOptions {
  /** Package name the module loader registers; must equal `package.json` name. */
  id: string
  /** Client entry relative to the package root, e.g. `src/client/index.tsx`. */
  entry: string
}

/**
 * Wrap the CJS library output in the DSH module-loader factory and inline the
 * extracted stylesheet into the factory body.
 *
 * - The loader materializes a plugin by running `factory(require)`; its
 *   `require` resolves the platform table and registered sibling packages.
 * - Styles must be inserted while the factory runs so the loader claims the
 *   `<style>` tag for this plugin and removes it on disable/HMR. A CSS asset
 *   emitted next to `client.js` would never be requested by DSH.
 */
function dshClientPlugin({ id }: DshClientOptions): Plugin {
  return {
    name: 'dsh-client-module',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const css: string[] = []
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'asset') continue
        if (!fileName.endsWith('.css') && !fileName.endsWith('.css.map')) continue
        if (fileName.endsWith('.css')) css.push(String(output.source))
        delete bundle[fileName]
      }

      const stylesheet = css
        .join('\n')
        .replaceAll(/\/\*# sourceMappingURL=[^*]*\*\/\s*/g, '')
        .trim()

      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !output.isEntry) continue
        output.code = wrapFactory(id, output.code, stylesheet)
      }
    },
  }
}

function wrapFactory(id: string, code: string, css: string): string {
  const pluginId = JSON.stringify(id)
  const cssKey = JSON.stringify(`${id}/client.css`)
  const styles = css
    ? [
        `var __dshCss = ${JSON.stringify(css)};`,
        'if (typeof document !== "undefined") {',
        `  var __dshStyle = document.createElement("style");`,
        `  __dshStyle.setAttribute("data-plugin", ${pluginId});`,
        `  __dshStyle.setAttribute("data-plugin-css", ${cssKey});`,
        '  __dshStyle.textContent = __dshCss;',
        `  var __dshPrev = document.querySelector('style[data-plugin-css="' + ${cssKey} + '"]');`,
        '  if (__dshPrev) __dshPrev.remove();',
        '  document.head.appendChild(__dshStyle);',
        '}',
      ].join('\n')
    : ''

  return [
    'window.__ModuleLoader__.load({',
    `  id: ${pluginId},`,
    '  factory: function (require) {',
    '    "use strict";',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    code,
    styles,
    '    return module.exports;',
    '  }',
    '});',
    '',
  ].join('\n')
}

/**
 * Vite config for one browser-half plugin: a single CJS artifact at
 * `lib/client.js`, produced next to tsdown's host output without wiping it.
 */
export function defineClientConfig({ id, entry }: DshClientOptions): UserConfig {
  return {
    plugins: [tailwindcss(), dshClientPlugin({ id, entry })],
    define: { 'process.env.NODE_ENV': '"production"' },
    esbuild: { jsx: 'automatic' },
    build: {
      outDir: 'lib',
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'es2022',
      cssCodeSplit: false,
      sourcemap: false,
      minify: false,
      lib: {
        entry,
        formats: ['cjs'],
        fileName: () => 'client.js',
        cssFileName: 'client',
      },
      rollupOptions: {
        external: [...DSH_PLATFORM_MODULES, ...DSH_HOST_MODULES],
        output: { exports: 'named' },
        onwarn(warning, defaultHandler) {
          // Base UI and lucide ship React Server Component directives; they
          // are meaningless in this browser-only CJS bundle.
          if (
            warning.code === 'MODULE_LEVEL_DIRECTIVE' &&
            warning.message.includes('"use client"')
          ) {
            return
          }
          defaultHandler(warning)
        },
      },
    },
  }
}
