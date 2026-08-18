import { readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import os from 'node:os'

const SCRIPT_PATH = fileURLToPath(new URL('./screenshot.ps1', import.meta.url))

const DEFAULTS = {
  graceMs: 10000,
}

/**
 * Resolve the PowerShell executable, mirroring the official
 * dsh-pwsh-local strategy (pwsh 7 install -> PATH pwsh -> Windows
 * PowerShell 5.1). 5.1 supports the .NET screen-capture used by
 * screenshot.ps1, so it is a valid final executor.
 */
const resolvePowershell = async (subprocess) => {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const fixed = [
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  for (const candidate of fixed) {
    if (existsSync(candidate)) return candidate
  }
  for (const name of ['pwsh', 'powershell']) {
    try {
      return await subprocess.resolveExecutable(name)
    } catch {
      // try the next name
    }
  }
  throw new Error('no PowerShell executable found (tried pwsh 7 install, PATH, and Windows PowerShell 5.1)')
}

/**
 * dsh-screenshot — host half.
 *
 * Registers `/dsh-screenshot/capture`: the browser asks this route to
 * capture the full screen(s) via screenshot.ps1 (Node.js / subprocess,
 * no browser APIs). The route returns the PNG as a base64 data URL
 * inside JSON, so the client can paint it into a full-screen overlay
 * and let the user crop a rectangle — the QQ-screenshot interaction.
 */
function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'exact',
      path: '/dsh-screenshot/capture',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }

        let pngPath = null
        try {
          const subprocess = ctx.get('subprocess')
          if (subprocess === undefined) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'subprocess service unavailable' }))
            return
          }

          const powershellPath = await resolvePowershell(subprocess)
          const handle = subprocess.spawn({
            argv: [
              powershellPath,
              '-NoProfile',
              '-NonInteractive',
              '-WindowStyle', 'Hidden',
              '-File', SCRIPT_PATH,
            ],
            cwd: os.tmpdir(),
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: 8192, spill: { maxBytes: 1024 * 1024 } },
              stderr: { maxBytes: 8192, spill: { maxBytes: 1024 * 1024 } },
            },
            graceMs: cfg.graceMs,
          })

          const outcome = await handle.done
          const collected = handle.collected

          if (outcome.exitCode !== 0) {
            const stderrText = collected?.stderr ? collected.stderr.readFrom(0).text : ''
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'screenshot failed', stderr: stderrText }))
            return
          }

          const stdoutText = collected?.stdout ? collected.stdout.readFrom(0).text : ''
          // screenshot.ps1 writes exactly one line (the PNG path) to stdout;
          // take the last non-empty line defensively.
          const lines = stdoutText.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          pngPath = lines[lines.length - 1] || ''

          if (!pngPath || !existsSync(pngPath)) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'screenshot file not found', path: pngPath }))
            return
          }

          const pngBuffer = await readFile(pngPath)
          const base64 = pngBuffer.toString('base64')
          // Clean up the temp file; the image is fully in the data URL now.
          await unlink(pngPath).catch(() => {})

          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ image: `data:image/png;base64,${base64}` }))
        } catch (err) {
          // Best-effort cleanup on failure.
          if (pngPath && existsSync(pngPath)) await unlink(pngPath).catch(() => {})
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String(err) }))
        }
      },
    })
    return () => dispose()
  }, 'dsh-screenshot: capture route')
}

export default {
  name: 'dsh-screenshot',
  inject: ['webServer', 'subprocess'],
  apply,
}