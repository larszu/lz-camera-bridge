import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const moduleRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(moduleRoot, '..', '..')
const devRoot = path.join(repoRoot, 'companion-dev')
const targetRoot = path.join(devRoot, 'companion-module-lz-camera-bridge')

fs.mkdirSync(devRoot, { recursive: true })
fs.mkdirSync(targetRoot, { recursive: true })

for (const entry of ['package.json', 'companion', 'dist']) {
  fs.cpSync(path.join(moduleRoot, entry), path.join(targetRoot, entry), {
    recursive: true,
    force: true,
  })
}

execFileSync('npm', ['install', '--omit=dev', '--no-package-lock'], {
  cwd: targetRoot,
  stdio: 'inherit',
  shell: true,
})

console.log(`[companion-module] synced to ${targetRoot}`)
