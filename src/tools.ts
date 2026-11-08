import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-approval'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { remoteWorkdir } from './model.js'
import type { RemoteTransport } from './transport.js'
import type { SavedWorkspace } from './types.js'

export interface WorkingDirectoryApi {
  ensure(agent: Agent, signal?: AbortSignal): Promise<string | undefined>
}

export interface SandboxPolicyApi {
  resolve(input: { session: Agent['session'] }): { mode: SandboxMode }
}

const HOST_EXECUTION_TOOLS = new Set([
  'bash', 'pwsh', 'powershell', 'terminal', 'exec_command', 'write_stdin',
  'run_code', 'subagent', 'spawn_agent', 'delegate_task', 'create_agent',
  'create_team', 'team', 'worktree', 'create_worktree',
])

/** No host command fallback for a remote session, including old resumed sessions. */
export function remoteToolDenial(name: string): string | undefined {
  if (HOST_EXECUTION_TOOLS.has(name) || /(?:^|_)(?:subagent|worktree)(?:_|$)/.test(name)) {
    return '此远程项目的命令必须使用 remote_bash。远程项目当前支持 Native 工具模式；本机终端、PTC 和子代理执行尚未接入。'
  }
  return undefined
}

export function bindRemoteAgent(
  owner: Context,
  agent: Agent,
  workspace: SavedWorkspace,
  transport: Pick<RemoteTransport, 'run'>,
  workingDirectory: WorkingDirectoryApi,
  sandboxPolicy: SandboxPolicyApi | undefined,
  connection?: { assertAvailable(): void },
): void {
  const ctx = agent.ctx
  const label = workspace.target.kind === 'wsl' ? `WSL ${workspace.target.distribution}` : `SSH ${workspace.target.host}`
  const tool = defineTool({
    name: 'remote_bash',
    description: `Run a foreground Bash command on ${label}. The remote project is ${workspace.target.remotePath}. `
      + 'Use this tool for all commands in this remote session. Every call starts a fresh shell. '
      + 'The remote host requires Python 3 and bash. Remote execution needs danger-full-access because the Windows sandbox cannot confine that machine; request the normal DSH approval when needed. '
      + 'Files opened with other tools use the native mounted directory or paths relative to it. Background jobs and interactive terminals are unavailable.',
    parameters: {
      description: { type: 'string', required: true, description: 'Short description of the command.' },
      command: { type: 'string', required: true, description: 'Bash source to execute remotely.' },
      workdir: { type: 'string', description: 'Remote Linux absolute directory, or a path relative to the current project directory.' },
      timeoutMs: { type: 'number', description: 'Deadline in milliseconds, from 1 to 600000. Defaults to 120000.' },
      sandbox_permissions: { type: 'string', enum: ['danger-full-access'], description: 'Request normal DSH approval for remote execution when the current mode is confined.' },
      justification: { type: 'string', description: 'Explain this specific command for the DSH approval prompt.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          cwd: { type: 'string', required: true }, exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          stdout: { type: 'string', required: true }, stderr: { type: 'string', required: true },
          stdoutTruncated: { type: 'boolean', required: true }, stderrTruncated: { type: 'boolean', required: true },
          timedOut: { type: 'boolean', required: true }, aborted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const result = value as { cwd: string; exitCode: number | null; stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean; timedOut: boolean; aborted: boolean }
        return [{ type: 'text', text: [
          `[${label}] ${result.cwd}`, result.stdout, result.stderr,
          result.stdoutTruncated || result.stderrTruncated ? '[output truncated to tail]' : '',
          result.timedOut ? '[command timed out]' : '',
          result.aborted ? '[command cancelled]' : '',
          `[exit code: ${result.exitCode ?? 'terminated'}]`,
        ].filter(Boolean).join('\n') }]
      },
    },
    async execute(args, exec) {
      connection?.assertAvailable()
      if (!args.command.trim() || !args.description.trim()) throw new Error('command 和 description 不能为空。')
      if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > 600_000)) {
        throw new Error('timeoutMs 必须为 1 至 600000 的整数。')
      }
      validateEscalationArgs(args.sandbox_permissions, args.justification)
      const effectiveMode = sandboxPolicy?.resolve({ session: agent.session }).mode
      if (effectiveMode === undefined) throw new Error('缺少 DSH sandboxPolicy 服务，无法确认远程命令的授权范围。')
      let mode = effectiveMode
      if (args.sandbox_permissions !== undefined) {
        mode = await approveEscalation({
          requestedMode: args.sandbox_permissions,
          justification: args.justification as string,
          effectiveMode, subject: 'remote command',
        }, { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'remote_bash', signal: exec.signal })
      }
      if (mode !== 'danger-full-access') {
        throw new Error('远程命令尚未获得执行授权。请使用 sandbox_permissions="danger-full-access" 并给出 justification，交由 DSH 审批。')
      }
      exec.signal.throwIfAborted()
      const current = await workingDirectory.ensure(agent, exec.signal)
      if (current === undefined) throw new Error('远程会话缺少工作目录，拒绝退回本机执行。')
      const cwd = remoteWorkdir(args.workdir, current, workspace)
      const result = await transport.run(workspace.target, args.command, { cwd, timeoutMs: args.timeoutMs, signal: exec.signal })
      exec.signal.throwIfAborted()
      return { ...result, cwd }
    },
    presentCall: args => ({ card: 'terminal', title: args.command, description: `${label} · ${args.description}`, cwd: args.workdir ?? workspace.target.remotePath }),
  })
  owner.effect(function* () {
    yield ctx.tools.register(tool)
    yield ctx.tools.guard(execution => {
      try { connection?.assertAvailable() } catch (error) { return error instanceof Error ? error.message : '远程项目已断开。' }
      return remoteToolDenial(execution.name)
    })
    yield ctx.systemPrompt.section({
      name: 'dsh-ssh:workspace', order: 950, interpolate: false,
      text: `This is a remote project on ${label}.\n`
        + `Remote project: ${workspace.target.remotePath}\nNative mounted project: ${workspace.localPath}\n`
        + 'Run every command with remote_bash. Use Native tool mode. Use file tools with relative paths or the native mounted project path; Linux absolute paths are for remote_bash. '
        + 'Never fall back to a Windows/local shell when disconnected. No background command, interactive terminal, worktree creation, or subagent execution is supported in this remote project.',
    })
  }, `dsh-ssh: remote session ${agent.id}`)
}
