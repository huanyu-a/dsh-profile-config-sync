// 最小 ZIP 读写 —— 只为「本地源码插件」那一组用（打包成 `local-plugins/<名字>.zip`，换机解回去）。
//
// 为什么不引第三方包：插件本身是零依赖的（只能 import node:*），也不该为了打个 zip 拉一个库进来。
// 为什么不只发 .tgz：另一台机器可能是 Windows，那边 apply.ps1 用 Expand-Archive 只会解 zip。
//
// 支持范围（够用就行，不做 zip64 / 加密 / 多卷）：
//   - 写：deflate（method 8），压不动就存（method 0），UTF-8 文件名（bit 11）
//   - 读：method 0 / 8，按中央目录读，跳过目录项

import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

export function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

/** 当前时间转 MS-DOS 的 (date, time) 两个 16 位整数。 */
function dosStamp(d = new Date()) {
  const year = Math.max(1980, d.getFullYear())
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  return { date, time }
}

/**
 * 打包。
 * @param {{name:string, data:Buffer, mtime?:Date}[]} entries name 用 `/` 分隔、相对归档根
 * @returns {Buffer}
 */
export function zipBuild(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '')
    const crc = crc32(data)
    const deflated = deflateRawSync(data)
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0
    const { date, time } = dosStamp(entry.mtime instanceof Date ? entry.mtime : new Date())

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)            // version needed
    local.writeUInt16LE(0x0800, 6)        // UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)            // extra
    locals.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)          // version made by
    central.writeUInt16LE(20, 6)          // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)          // extra len
    central.writeUInt16LE(0, 32)          // comment len
    central.writeUInt16LE(0, 34)          // disk start
    central.writeUInt16LE(0, 36)          // internal attrs
    central.writeUInt32LE(0, 38)          // external attrs
    central.writeUInt32LE(offset, 42)     // local header offset
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, end])
}

/** 从 EOCD 找到中央目录的位置（容忍尾部注释）。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

/**
 * 解包到目录。
 * @returns {{files:number, names:string[]}}
 */
export function zipExtract(buf, destDir) {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是 zip 文件（找不到中央目录结尾）')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  let files = 0
  const names = []
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录项 ${i} 标记不对`)
    const method = buf.readUInt16LE(p + 10)
    const crcExpect = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue
    // 防目录穿越：解出来的路径必须落在 destDir 里
    const target = join(destDir, ...name.split('/'))
    if (!target.startsWith(destDir)) throw new Error(`归档里有可疑路径：${name}`)

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`本地头标记不对：${name}`)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const body = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? Buffer.from(body) : inflateRawSync(body)
    if (crc32(data) !== crcExpect) throw new Error(`CRC 校验失败：${name}`)
    if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    files += 1
    names.push(name)
  }
  return { files, names }
}