import assert from 'node:assert/strict'
import { RemoteTransport } from '../src/transport.js'

const transport = new RemoteTransport()
try {
  const distributions = await transport.listWsl()
  const distribution = process.argv[2] ?? distributions[0]
  assert.ok(distribution, 'No WSL distribution is installed')
  const root = { kind: 'wsl' as const, distribution, remotePath: '/' }
  const info = await transport.inspect(root)
  const target = { ...root, remotePath: info.home }
  const listing = await transport.browse(target, info.home)
  const result = await transport.run(target, "printf 'dsh-ssh-wsl-ok\\n'; pwd", { timeoutMs: 10_000 })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.match(result.stdout, /dsh-ssh-wsl-ok/)
  assert.ok(result.stdout.includes(info.home))
  const cancelled = new AbortController()
  const running = transport.run(target, 'sleep 30', { signal: cancelled.signal, timeoutMs: 10_000 })
  setTimeout(() => cancelled.abort(), 500)
  const stopped = await running
  assert.equal(stopped.aborted, true)
  console.log(JSON.stringify({ distribution, platform: info.platform, python: info.python, listedDirectoryCount: listing.directories.length, command: 'passed', cancellation: 'passed' }, null, 2))
} finally {
  await transport.dispose()
}
