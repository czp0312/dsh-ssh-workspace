import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolsService from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { bindRemoteAgent, remoteToolDenial } from '../src/tools.js'
import type { SavedWorkspace } from '../src/types.js'

async function fixture(mode: SandboxMode = 'workspace-write', outcome = 'allowed-once', connection?: { assertAvailable(): void }) {
  const ctx = new Context()
  const system = await ctx.plugin(SystemPrompt)
  const tools = await ctx.plugin(ToolsService)
  const owner = await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: () => undefined })
  const nativePath = process.platform === 'win32' ? 'Z:\\project' : '/mnt/remote-project'
  const agent = { id: 'remote-test', session: { header: { cwd: nativePath } } } as unknown as Agent
  const scope = createScope(owner.ctx, agent)
  Object.assign(agent, { ctx: scope.ctx })
  const workspace: SavedWorkspace = {
    id: 'remote-project', workspaceId: 'native-project', title: 'Remote', localPath: nativePath,
    target: { kind: 'ssh', host: 'dev-server', remotePath: '/srv/project' }, createdAt: 0,
  }
  const requested: unknown[] = []
  ctx.provide('approval', { request: async (request: unknown) => { requested.push(request); return outcome } })
  const commands: { command: string; cwd?: string }[] = []
  bindRemoteAgent(owner.ctx, agent, workspace, {
    run: async (_target, command, options) => {
      commands.push({ command, cwd: options?.cwd })
      return { exitCode: 0, stdout: 'remote result', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false, aborted: false }
    },
  }, { ensure: async () => nativePath }, { resolve: () => ({ mode }) }, connection)
  const tool = ctx.tools.get('remote_bash', agent)
  assert.ok(tool)
  const execution = { agent, callId: 'call-test', rootCallId: 'call-test', name: 'remote_bash', token: Symbol(), signal: new AbortController().signal } as unknown as ToolRunContext
  return { ctx, agent, owner, tool, execution, requested, commands, nativePath,
    dispose: async () => { await owner.dispose(); await scope.dispose(); await tools.dispose(); await system.dispose() },
  }
}

test('remote tool and host execution guard stay inside the selected agent scope', async t => {
  const f = await fixture(); t.after(f.dispose)
  assert.equal(f.ctx.tools.get('remote_bash'), undefined)
  assert.ok(f.ctx.tools.checkGuards({ ...f.execution, name: 'bash' }))
  assert.equal(f.ctx.tools.checkGuards({ ...f.execution, agent: undefined, name: 'bash' }), undefined)
  assert.equal(f.ctx.tools.checkGuards(f.execution), undefined)
  for (const name of ['bash', 'pwsh', 'run_code', 'terminal', 'subagent', 'subagent_fork', 'create_worktree']) assert.ok(remoteToolDenial(name))
  assert.equal(remoteToolDenial('read_file'), undefined)
  await f.owner.dispose()
  assert.equal(f.ctx.tools.get('remote_bash', f.agent), undefined)
})

test('confined command cannot run without explicit DSH escalation', async t => {
  const f = await fixture(); t.after(f.dispose)
  await assert.rejects(f.tool.execute({ description: 'Inspect project', command: 'pwd' }, f.execution), /尚未获得执行授权/)
  assert.equal(f.commands.length, 0)
  assert.equal(f.requested.length, 0)
})

test('approval rejection prevents transport startup', async t => {
  const f = await fixture('workspace-write', 'rejected'); t.after(f.dispose)
  await assert.rejects(f.tool.execute({ description: 'Inspect project', command: 'pwd', sandbox_permissions: 'danger-full-access', justification: 'Run pwd on the selected SSH server.' }, f.execution), /rejected/)
  assert.equal(f.requested.length, 1)
  assert.equal(f.commands.length, 0)
})

test('approved command uses the mapped remote cwd and returns canonical output', async t => {
  const f = await fixture(); t.after(f.dispose)
  const result = await f.tool.execute({ description: 'Inspect source', command: 'pwd', workdir: 'src', sandbox_permissions: 'danger-full-access', justification: 'Inspect the remote source directory.' }, f.execution)
  assert.equal(f.requested.length, 1)
  assert.deepEqual(f.commands, [{ command: 'pwd', cwd: '/srv/project/src' }])
  assert.match(JSON.stringify(result), /remote result/)
})

test('standing full-access uses the remote transport without a redundant approval', async t => {
  const f = await fixture('danger-full-access'); t.after(f.dispose)
  await f.tool.execute({ description: 'Inspect project', command: 'pwd' }, f.execution)
  assert.equal(f.requested.length, 0)
  assert.equal(f.commands.length, 1)
})

test('manual disconnection blocks both command and file tools in resumed remote sessions', async t => {
  let paused = true
  const f = await fixture('danger-full-access', 'allowed-once', { assertAvailable() { if (paused) throw new Error('远程项目已断开，请连接后继续。') } }); t.after(f.dispose)
  assert.match(f.ctx.tools.checkGuards({ ...f.execution, name: 'read_file' })!, /已断开/)
  await assert.rejects(f.tool.execute({ description: 'Must not run offline', command: 'pwd' }, f.execution), /已断开/)
  assert.equal(f.commands.length, 0)
  paused = false
  assert.equal(f.ctx.tools.checkGuards({ ...f.execution, name: 'read_file' }), undefined)
  await f.tool.execute({ description: 'Resume remotely', command: 'pwd' }, f.execution)
  assert.equal(f.commands.length, 1)
})
