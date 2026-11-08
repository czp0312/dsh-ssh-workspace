import { build } from 'esbuild'
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

await mkdir('lib', { recursive: true })
await copyFile('src/ssh-askpass.cjs', 'lib/ssh-askpass.cjs')
await chmod('lib/ssh-askpass.cjs', 0o755)
if (process.platform === 'win32') {
  const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/optimize+', `/out:${resolve('lib/ssh-askpass.exe')}`, resolve('src/ssh-askpass.cs')], { stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) throw new Error('Cannot build Windows SSH askpass helper')
}
const typecheck = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--declaration', '--emitDeclarationOnly', '--outDir', 'lib/types'], { stdio: 'inherit' })
if (typecheck.status !== 0) process.exit(typecheck.status ?? 1)
await build({ entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', sourcemap: true })
await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  loader: { '.css': 'text' },
  sourcemap: true,
  banner: {
    js: `window.__ModuleLoader__.load({
  id: "dsh-ssh-workspaces",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`,
  },
  footer: {
    js: `    return module.exports;
  },
});
`,
  },
})

const client = await readFile('lib/client.js', 'utf8')
const errors = []
if (!client.startsWith('window.__ModuleLoader__.load({')) errors.push('missing DSH module wrapper')
if (!client.includes('id: "dsh-ssh-workspaces"')) errors.push('wrong DSH module id')
if (!client.includes('factory: (require)')) errors.push('missing DSH require factory')
if (/^\s*(?:import|export)\s/m.test(client)) errors.push('browser bundle contains a top-level ESM statement')
if (!client.includes('require("react")')) errors.push('React must be resolved by the DSH module loader')
if (errors.length) throw new Error(`Invalid DSH client bundle: ${errors.join('; ')}`)

console.log('Built host and DSH module-loader client for DSH 0.2.2-rc.1')
