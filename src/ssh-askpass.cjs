#!/usr/bin/env node
// This process only serves OpenSSH's single prompt through a local authenticated socket.
const net = require('node:net')
const socket = net.connect(process.env.DSH_SSH_ASKPASS_PIPE)
let reply = ''
socket.setTimeout(5000, () => { socket.destroy(); process.exitCode = 1 })
socket.once('error', () => { process.exitCode = 1 })
socket.once('connect', () => socket.write(`${process.env.DSH_SSH_ASKPASS_TOKEN}\n${Buffer.from(process.argv[2] || '').toString('base64')}\n`))
socket.on('data', data => { reply += data; if (reply.length > 32768) socket.destroy() })
socket.once('end', () => {
  const [status, secret] = reply.split('\n')
  if (status !== 'OK') { process.exitCode = 1; return }
  process.stdout.write(Buffer.from(secret || '', 'base64').toString('utf8') + '\n')
})
