/** @module tooling/client/index */
import tailwindcss from '@tailwindcss/vite'
import type { Plugin, UserConfig } from 'vite'

const DSH_PLATFORM_MODULES = [
  /^react$/u,
  /^react\/jsx-runtime$/u,
  /^react\/jsx-dev-runtime$/u,
  /^react-dom$/u,
  /^react-dom\/client$/u,
]

const DSH_HOST_MODULES = ['@deepseek-ai/dsh-client-ui-primitives']

export interface DshClientOptions {
  id: string

  entry: string
}

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
        .replaceAll(/\/\*# sourceMappingURL=[^*]*\*\/\s*/gu, '')
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
