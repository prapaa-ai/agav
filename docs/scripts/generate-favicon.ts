import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const root = process.cwd()
const logoSourcePath = path.join(root, 'public', 'logo.png')
const svgPath = path.join(root, 'public', 'favicon.svg')
const pngPath = path.join(root, 'app', 'icon.png')
const applePath = path.join(root, 'app', 'apple-icon.png')
const transparent = { r: 0, g: 0, b: 0, alpha: 0 }

type Padding = {
  top: number
  bottom: number
  left: number
  right: number
}

async function renderLogo(
  width: number,
  height: number,
  padding: Padding,
): Promise<Buffer> {
  const innerWidth = width - padding.left - padding.right
  const innerHeight = height - padding.top - padding.bottom
  const logo = await sharp(logoSourcePath)
    .resize(innerWidth, innerHeight, {
      fit: 'contain',
      background: transparent,
    })
    .png()
    .toBuffer()

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: transparent,
    },
  })
    .composite([{ input: logo, left: padding.left, top: padding.top }])
    .png()
    .toBuffer()
}

async function main() {
  const logoBuffer = await renderLogo(320, 258, { top: 4, bottom: 10, left: 4, right: 4 })
  const logoDataUrl = `data:image/png;base64,${logoBuffer.toString('base64')}`
  const faviconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" rx="16" fill="transparent"/>
  <image href="${logoDataUrl}" x="2" y="6" width="60" height="52" preserveAspectRatio="xMidYMid meet"/>
</svg>
`

  await fs.mkdir(path.dirname(svgPath), { recursive: true })
  await fs.writeFile(svgPath, faviconSvg)
  await fs.writeFile(pngPath, await renderLogo(96, 96, { top: 2, bottom: 2, left: 2, right: 2 }))
  await fs.writeFile(applePath, await renderLogo(180, 180, { top: 4, bottom: 6, left: 4, right: 4 }))

  console.log('Generated favicon assets from the existing Agav logo')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})