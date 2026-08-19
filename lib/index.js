import { readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import os from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'

const SCREENSHOT_SCRIPT = fileURLToPath(new URL('./screenshot.ps1', import.meta.url))
const INPUT_SCRIPT = fileURLToPath(new URL('./computer_use.ps1', import.meta.url))

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
 * Spawn PowerShell with a script and return parsed JSON from stdout.
 * Throws on non-zero exit or invalid JSON.
 */
const runPowerShell = async (ctx, scriptPath, args, cfg) => {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('subprocess service unavailable')

  const powershellPath = await resolvePowershell(subprocess)
  const handle = subprocess.spawn({
    argv: [
      powershellPath,
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      ...args,
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
    throw new Error(`PowerShell exited with code ${outcome.exitCode}: ${stderrText}`)
  }

  const stdoutText = collected?.stdout ? collected.stdout.readFrom(0).text : ''
  const lines = stdoutText.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const jsonLine = lines[lines.length - 1] || ''

  try {
    return JSON.parse(jsonLine)
  } catch {
    throw new Error(`failed to parse PowerShell output as JSON: ${jsonLine}`)
  }
}

/**
 * Build the image content blocks for a screenshot, following the
 * read_image pattern so the model sees the image natively.
 */
function screenshotContent(value) {
  return [
    {
      type: 'text',
      text: `Screenshot captured: ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes`,
    },
    {
      type: 'image',
      attachment: {
        attachmentId: AttachmentId(value.image.attachmentId),
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
      },
    },
  ]
}

/**
 * dsh-screenshot — host half.
 *
 * Web route:  /dsh-screenshot/capture  (browser → full-screen PNG)
 * Model tools: screenshot, mouse_click, mouse_move, type_text,
 *              key_press, scroll, open_url
 */
function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  // ── Web route (browser-side screenshot button) ─────────────
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
              '-File', SCREENSHOT_SCRIPT,
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
          const lines = stdoutText.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          pngPath = lines[lines.length - 1] || ''

          if (!pngPath || !existsSync(pngPath)) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'screenshot file not found', path: pngPath }))
            return
          }

          const pngBuffer = await readFile(pngPath)
          const base64 = pngBuffer.toString('base64')
          await unlink(pngPath).catch(() => {})

          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ image: `data:image/png;base64,${base64}` }))
        } catch (err) {
          if (pngPath && existsSync(pngPath)) await unlink(pngPath).catch(() => {})
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String(err) }))
        }
      },
    })
    return () => dispose()
  }, 'dsh-screenshot: capture route')

  // ── System prompt ───────────────────────────────────────────
  ctx.systemPrompt.section({
    name: 'tool:computer-use',
    order: 110,
    text: `## Computer Use

You can control the desktop to complete tasks. Use these tools:

- **screenshot**: Capture the full screen as an image. Returns the image so you can see the current state. Use this first to understand what is on screen.
- **mouse_click**: Click at screen coordinates (x, y). Use button="left"|"right"|"middle" and click_count for double-clicks (2).
- **mouse_move**: Move the mouse cursor to (x, y) without clicking.
- **type_text**: Type text at the current cursor position. Use this after clicking in a text field.
- **key_press**: Press a key or key combination. Use "+" to join modifiers and the main key, e.g. "enter", "ctrl+c", "alt+tab", "escape".
- **scroll**: Scroll the mouse wheel. Direction is "up", "down", "left", or "right". Amount is the number of notches.
- **open_url**: Open a URL in the default browser.

Workflow: Take a screenshot → analyze what you see → decide the next action → execute it → take another screenshot to verify. Repeat until the task is complete. Screen coordinates are 0-based from the top-left corner of the primary display.`,
  })

  // ── Model-facing tools ──────────────────────────────────────

  // screenshot — needs attachments service
  ctx.inject(['attachments'], (imageCtx) => {
    imageCtx.tools.register(defineTool({
      name: 'screenshot',
      description: 'Capture the full screen as an image. Returns the image so you can see the current state. Use this to understand what is on screen before taking action.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            image: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
              },
            },
          },
        },
        render: (_args, value) => {
          return [{
            type: 'text',
            text: `Screenshot captured: ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes`,
          }, {
            type: 'image',
            attachment: {
              attachmentId: AttachmentId(value.image.attachmentId),
              mediaType: value.image.mediaType,
              bytes: value.image.bytes,
              width: value.image.width,
              height: value.image.height,
            },
          }]
        },
      },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const subprocess = ctx.get('subprocess')
        if (subprocess === undefined) throw new Error('subprocess service unavailable')

        const powershellPath = await resolvePowershell(subprocess)
        const handle = subprocess.spawn({
          argv: [
            powershellPath,
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle', 'Hidden',
            '-File', SCREENSHOT_SCRIPT,
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
          throw new Error(`screenshot failed (exit ${outcome.exitCode}): ${stderrText}`)
        }

        const stdoutText = collected?.stdout ? collected.stdout.readFrom(0).text : ''
        const lines = stdoutText.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        const pngPath = lines[lines.length - 1] || ''

        if (!pngPath || !existsSync(pngPath)) {
          throw new Error(`screenshot file not found: ${pngPath}`)
        }

        const pngBuffer = await readFile(pngPath)
        await unlink(pngPath).catch(() => {})

        const attachments = imageCtx.get('attachments')
        const ref = await attachments.saveImage({
          data: pngBuffer,
          mediaType: 'image/png',
          name: 'screenshot.png',
        })

        const value = {
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
          },
        }

        if (exec.parent !== void 0) {
          exec.deferContext(createUserMessage({
            content: screenshotContent(value),
            source: { kind: 'plugin', plugin: 'dsh-screenshot' },
          }))
        }

        return value
      },
    }))
  })

  // mouse_click
  ctx.tools.register(defineTool({
    name: 'mouse_click',
    description: 'Click the mouse at screen coordinates (x, y). Use button="left"|"right"|"middle" and click_count for multiple clicks (2 = double-click).',
    parameters: {
      x: { type: 'integer', required: true, description: 'X coordinate from the left edge of the screen.' },
      y: { type: 'integer', required: true, description: 'Y coordinate from the top edge of the screen.' },
      button: { type: 'string', description: 'Which mouse button to click. Defaults to "left".' },
      click_count: { type: 'integer', description: 'Number of clicks. 1 = single, 2 = double. Defaults to 1.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          x: { type: 'integer' },
          y: { type: 'integer' },
          button: { type: 'string' },
          count: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `mouse_click failed: ${value.error ?? 'unknown error'}` }]
        return [{ type: 'text', text: `Clicked ${value.button} button (${value.count}x) at (${value.x}, ${value.y})` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const result = await runPowerShell(ctx, INPUT_SCRIPT, [
        '-Action', 'click',
        '-X', String(args.x),
        '-Y', String(args.y),
        ...(args.button ? ['-Button', args.button] : []),
        ...(args.click_count ? ['-Count', String(args.click_count)] : []),
      ], cfg)
      if (!result.ok) throw new Error(result.error ?? 'mouse_click failed')
      return { ok: true, x: result.x, y: result.y, button: result.button, count: result.count }
    },
  }))

  // mouse_move
  ctx.tools.register(defineTool({
    name: 'mouse_move',
    description: 'Move the mouse cursor to screen coordinates (x, y) without clicking.',
    parameters: {
      x: { type: 'integer', required: true, description: 'X coordinate from the left edge of the screen.' },
      y: { type: 'integer', required: true, description: 'Y coordinate from the top edge of the screen.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          x: { type: 'integer' },
          y: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `mouse_move failed: ${value.error ?? 'unknown error'}` }]
        return [{ type: 'text', text: `Mouse moved to (${value.x}, ${value.y})` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const result = await runPowerShell(ctx, INPUT_SCRIPT, [
        '-Action', 'move',
        '-X', String(args.x),
        '-Y', String(args.y),
      ], cfg)
      if (!result.ok) throw new Error(result.error ?? 'mouse_move failed')
      return { ok: true, x: result.x, y: result.y }
    },
  }))

  // type_text
  ctx.tools.register(defineTool({
    name: 'type_text',
    description: 'Type text at the current cursor position. Make sure to click in a text field first with mouse_click.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to type.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          typed: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `type_text failed: ${value.error ?? 'unknown error'}` }]
        return [{ type: 'text', text: `Typed ${value.typed} characters` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const result = await runPowerShell(ctx, INPUT_SCRIPT, [
        '-Action', 'type',
        '-Text', args.text,
      ], cfg)
      if (!result.ok) throw new Error(result.error ?? 'type_text failed')
      return { ok: true, typed: result.typed }
    },
  }))

  // key_press
  ctx.tools.register(defineTool({
    name: 'key_press',
    description: 'Press a key or key combination. Use "+" to join modifiers and the main key, e.g. "enter", "ctrl+c", "alt+tab", "escape", "ctrl+v".',
    parameters: {
      key: { type: 'string', required: true, description: 'Key or combination, e.g. "enter", "ctrl+c", "alt+tab".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          key: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `key_press failed: ${value.error ?? 'unknown error'}` }]
        return [{ type: 'text', text: `Pressed "${value.key}"` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const result = await runPowerShell(ctx, INPUT_SCRIPT, [
        '-Action', 'key',
        '-Key', args.key,
      ], cfg)
      if (!result.ok) throw new Error(result.error ?? 'key_press failed')
      return { ok: true, key: result.key }
    },
  }))

  // scroll
  ctx.tools.register(defineTool({
    name: 'scroll',
    description: 'Scroll the mouse wheel. Direction is "up", "down", "left", or "right". Amount is the number of notches.',
    parameters: {
      direction: { type: 'string', required: true, enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction.' },
      amount: { type: 'integer', description: 'Number of wheel notches. Defaults to 1.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          direction: { type: 'string' },
          amount: { type: 'integer' },
          delta: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `scroll failed: ${value.error ?? 'unknown error'}` }]
        return [{ type: 'text', text: `Scrolled ${value.direction} x${value.amount}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const result = await runPowerShell(ctx, INPUT_SCRIPT, [
        '-Action', 'scroll',
        '-Direction', args.direction,
        '-Amount', String(args.amount ?? 1),
      ], cfg)
      if (!result.ok) throw new Error(result.error ?? 'scroll failed')
      return { ok: true, direction: result.direction, amount: result.amount, delta: result.delta }
    },
  }))

  // open_url
  ctx.tools.register(defineTool({
    name: 'open_url',
    description: 'Open a URL in the default browser. After opening, take a screenshot to see the page.',
    parameters: {
      url: { type: 'string', required: true, description: 'The URL to open, e.g. "https://example.com".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `open_url failed: ${value.error ?? 'unknown error'}` }]
        return [{ type: 'text', text: `Opened ${value.url} in browser` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const result = await runPowerShell(ctx, INPUT_SCRIPT, [
        '-Action', 'open',
        '-Url', args.url,
      ], cfg)
      if (!result.ok) throw new Error(result.error ?? 'open_url failed')
      return { ok: true, url: result.url }
    },
  }))
}

export default {
  name: 'dsh-screenshot',
  inject: ['webServer', 'subprocess', 'tools', 'systemPrompt'],
  apply,
}