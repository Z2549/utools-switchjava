/**
 * SwitchJava —— uTools 模板插件应用 preload（列表模式 / 无 UI 模式）
 *
 * 目标：在 uTools 中一键切换 Windows 的 JAVA_HOME 环境变量。
 *
 * 设计原则：
 *   1. 零预设：不要求用户事先定义 JAVA8_HOME / JAVA11_HOME 之类的中间变量，插件自行扫描本机 JDK。
 *   2. 幂等：重复执行不产生副作用，PATH 修复只在缺失时发生。
 *   3. 不污染：不在 uTools 程序目录留下文件，临时文件写入系统 temp 并在使用后删除。
 *   4. 透明：写入的是 JDK 真实路径，不使用 %JAVAxx_HOME% 这类无法被多数工具解析的间接引用。
 *
 * 规范：CommonJS；源码可读；不压缩、不混淆、不打包。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

/* ================================================================== *
 * 一、常量
 * ================================================================== */

const IS_WIN = process.platform === 'win32'

const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
const REG_EXE = path.join(SYSTEM_ROOT, 'System32', 'reg.exe')
const PS_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const REG_MACHINE_ENV = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const REG_USER_ENV = 'HKCU\\Environment'

const SCOPE_USER = 'User'
const SCOPE_MACHINE = 'Machine'

/** dbStorage 键（本地不同步存储，用于保存用户主动选择的配置） */
const KEY_SCOPE = 'switchjava/scope'
const KEY_MANUAL = 'switchjava/manual'
const KEY_AUTO_PATH = 'switchjava/autoPath'

/** 扫描结果缓存时长：避免每次按键都重新扫描 */
const SCAN_TTL = 60 * 1000

const EXEC_TIMEOUT = 20000
const ELEVATE_TIMEOUT = 180000

const ENTRY_JAVA_HOME_BIN = '%JAVA_HOME%\\bin'

/* ================================================================== *
 * 二、通用工具
 * ================================================================== */

function notify(message) {
  try {
    utools.showNotification(String(message))
  } catch (err) {
    /* 通知失败不应影响主流程 */
  }
}

function tempDir() {
  try {
    const dir = utools.getPath('temp')
    if (dir) return dir
  } catch (err) {
    /* 回退到 Node 的临时目录 */
  }
  return os.tmpdir()
}

/**
 * 上一次操作的结果，直接显示在列表顶部。
 * 通知（showNotification）一闪而过、失败时容易被忽略，用户往往"不知道有没有生效"，
 * 所以把结果留在列表里，失败时还会标红。
 */
let lastResult = null

function rememberResult(ok, text) {
  lastResult = { ok: !!ok, text: String(text) }
}

/**
 * 操作完成后弹出的结果提示框。
 *
 * 实现说明（基于本机 uTools 7.8.0 客户端源码确认）：
 * - createBrowserWindow 的 url 必须是插件目录内、.html 结尾的相对路径，允许 ?query 传参；
 * - outPlugin 只会处理"调用方自己的窗口"，不会销毁 createBrowserWindow 创建的独立窗口，
 *   因此弹窗可以在插件退出后继续存活；
 * - 页面里 window.close() 由客户端托管生效，可以实现自动关闭。
 *
 * 失败（旧版 uTools 无此 API 等）时返回 false，调用方回退到 showNotification。
 */
function showResultDialog(ok, title, message) {
  try {
    if (typeof window.utools.createBrowserWindow !== 'function') return false
    const query =
      '?ok=' + (ok ? '1' : '0') +
      '&title=' + encodeURIComponent(String(title || '')) +
      '&msg=' + encodeURIComponent(String(message || ''))
    window.utools.createBrowserWindow('result.html' + query, {
      width: 460,
      height: 240,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      center: true,
      autoHideMenuBar: true,
    })
    return true
  } catch (err) {
    return false
  }
}

/**
 * reg.exe / 控制台程序的输出按系统 ANSI 代码页编码（简中为 GBK）。
 * 先判断是否含高位字节，再选择 UTF-8 或 GBK 解码，避免中文路径乱码。
 */
function bufferToText(buf) {
  if (buf === null || buf === undefined) return ''
  if (typeof buf === 'string') return buf
  if (!Buffer.isBuffer(buf)) return String(buf)

  let hasHighByte = false
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) {
      hasHighByte = true
      break
    }
  }
  if (!hasHighByte) return buf.toString('utf8')

  for (const enc of ['gbk', 'gb18030']) {
    try {
      return new TextDecoder(enc).decode(buf)
    } catch (err) {
      /* 该编码不受支持，尝试下一个 */
    }
  }
  return buf.toString('utf8')
}

/** 执行外部命令并返回原始 Buffer；失败时返回 null（不抛异常） */
function runCapture(file, args, timeout) {
  try {
    return execFileSync(file, args, {
      timeout: timeout || EXEC_TIMEOUT,
      windowsHide: true,
      stdio: 'pipe',
    })
  } catch (err) {
    return null
  }
}

/** 比较两个路径是否指向同一位置（大小写不敏感，忽略结尾分隔符） */
function samePath(a, b) {
  if (!a || !b) return false
  try {
    const norm = (p) =>
      path.resolve(String(p).trim().replace(/^"|"$/g, '')).replace(/[\\/]+$/, '').toLowerCase()
    return norm(a) === norm(b)
  } catch (err) {
    return false
  }
}

function compareVersionDesc(a, b) {
  const pa = String(a || '').split('.')
  const pb = String(b || '').split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = Number(pa[i]) || 0
    const y = Number(pb[i]) || 0
    if (x !== y) return y - x
  }
  return 0
}

function psQuote(value) {
  return "'" + String(value === undefined || value === null ? '' : value).replace(/'/g, "''") + "'"
}

function toBase64Utf16(text) {
  return Buffer.from(String(text), 'utf16le').toString('base64')
}

/* ================================================================== *
 * 三、配置读写（dbStorage，本地不同步）
 * ================================================================== */

function storageGet(key, fallback) {
  try {
    const value = utools.dbStorage.getItem(key)
    return value === undefined || value === null ? fallback : value
  } catch (err) {
    return fallback
  }
}

function storageSet(key, value) {
  try {
    utools.dbStorage.setItem(key, value)
  } catch (err) {
    /* 存储失败不影响本次操作 */
  }
}

function getScope() {
  return storageGet(KEY_SCOPE, SCOPE_USER) === SCOPE_MACHINE ? SCOPE_MACHINE : SCOPE_USER
}

function getAutoFixPath() {
  return storageGet(KEY_AUTO_PATH, true) !== false
}

function getManualPaths() {
  const list = storageGet(KEY_MANUAL, [])
  if (!Array.isArray(list)) return []
  return list.filter((item) => typeof item === 'string' && item.trim() !== '')
}

function addManualPath(target) {
  const list = getManualPaths()
  if (list.some((item) => samePath(item, target))) return false
  list.push(target)
  storageSet(KEY_MANUAL, list)
  return true
}

function scopeLabel(scope) {
  return scope === SCOPE_MACHINE ? '系统级' : '用户级'
}

/* ================================================================== *
 * 四、注册表 / 环境变量读取
 * ================================================================== */

/**
 * 读取指定范围内的环境变量原始值。
 * 使用 reg.exe 而非 .NET API，确保拿到的是未展开的原始字符串（例如可能存在的 %JAVA8_HOME%）。
 */
function queryEnvVar(scope, name) {
  const key = scope === SCOPE_MACHINE ? REG_MACHINE_ENV : REG_USER_ENV
  const buf = runCapture(REG_EXE, ['query', key, '/v', name], EXEC_TIMEOUT)
  if (!buf) return null
  const text = bufferToText(buf)
  const match = /REG_(?:SZ|EXPAND_SZ|MULTI_SZ)\s+([\s\S]+)/.exec(text)
  if (!match) return null
  const value = match[1].trim()
  return value === '' ? null : value
}

function readJavaHomeVars() {
  const out = []
  const keys = [REG_MACHINE_ENV, REG_USER_ENV]
  for (const key of keys) {
    const buf = runCapture(REG_EXE, ['query', key], EXEC_TIMEOUT)
    if (!buf) continue
    const text = bufferToText(buf)
    const re = /^\s*(JAVA[A-Z0-9_]*_HOME)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/gim
    let match
    while ((match = re.exec(text)) !== null) {
      out.push(match[2].trim())
    }
  }
  return out
}

/** 注册表 JavaSoft\JDK\<version>\JavaHome —— 安装器写入的权威记录 */
function readRegistryJavaHomes() {
  const out = []
  const keys = [
    'HKLM\\SOFTWARE\\JavaSoft\\JDK',
    'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\JDK',
  ]
  for (const key of keys) {
    const buf = runCapture(REG_EXE, ['query', key, '/s'], EXEC_TIMEOUT)
    if (!buf) continue
    const text = bufferToText(buf)
    const re = /JavaHome\s+REG_SZ\s+([\s\S]+)/g
    let match
    while ((match = re.exec(text)) !== null) {
      out.push(match[1].trim())
    }
  }
  return out
}

/** 从 PATH 中形如 xxx\bin 的条目反推 JDK 根目录 */
function readPathJavaHomes() {
  const out = []
  const raw = String(process.env.PATH || '') + ';' + String(process.env.Path || '')
  for (const piece of raw.split(';')) {
    const entry = piece.trim().replace(/^"|"$/g, '')
    if (entry === '') continue
    if (/[\\/]bin$/i.test(entry)) {
      out.push(entry.replace(/[\\/]bin$/i, ''))
    }
  }
  return out
}

/* ================================================================== *
 * 五、JDK 识别与扫描
 * ================================================================== */

/** 解析 JDK 根目录下的 release 文件（避免启动 java 进程，速度快且无副作用） */
function readReleaseFile(dir) {
  const file = path.join(dir, 'release')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return {}
  }
  const map = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim())
    if (match) map[match[1]] = match[2]
  }
  return map
}

const VENDOR_RULES = [
  [/oracle/i, 'Oracle'],
  [/adoptium|temurin/i, 'Temurin'],
  [/microsoft/i, 'Microsoft'],
  [/azul|zulu/i, 'Azul Zulu'],
  [/amazon|corretto/i, 'Amazon Corretto'],
  [/bellsoft|liberica/i, 'BellSoft'],
  [/sapmachine|sap se/i, 'SAP SapMachine'],
  [/ibm|semeru/i, 'IBM Semeru'],
  [/jetbrains/i, 'JetBrains'],
  [/alibaba|dragonwell/i, 'Alibaba Dragonwell'],
  [/tencent|kona/i, 'Tencent Kona'],
  [/openjdk/i, 'OpenJDK'],
]

function detectVendor(release) {
  const haystack = String(release.IMPLEMENTOR || '') + ' ' + String(release.IMPLEMENTOR_VERSION || '')
  for (const [re, name] of VENDOR_RULES) {
    if (re.test(haystack)) return name
  }
  return ''
}

/** 目录名兜底解析版本，例如 jdk-17.0.3.1 / jdk1.8.0_402 / java-21-openjdk */
function versionFromDirName(dir) {
  const name = path.basename(dir)
  const dotted = /(\d+\.\d+(?:[._]\d+)*)/.exec(name)
  if (dotted) return dotted[1]
  const major = /(?:jdk|java)[-_.]?(\d{1,2})\b/i.exec(name)
  return major ? major[1] : ''
}

/** Java 8 的版本号形如 1.8.0_402，其主版本号应归一化为 8 */
function majorOf(version) {
  const text = String(version || '')
  const legacy = /^1\.(\d+)/.exec(text)
  if (legacy) return legacy[1]
  return text.split('.')[0] || ''
}

const IGNORED_DIR_NAMES = ['javapath', 'javapath_target', 'javatmp', 'bin', 'lib', 'conf', 'include']

/**
 * 判定一个目录是否为可用的 JAVA_HOME，是则返回描述对象，否则返回 null。
 */
function describeJdk(dir) {
  if (!dir) return null

  let base
  try {
    base = path.basename(dir).toLowerCase()
  } catch (err) {
    return null
  }
  if (IGNORED_DIR_NAMES.indexOf(base) >= 0) return null

  const javaExe = path.join(dir, 'bin', 'java.exe')
  if (!fs.existsSync(javaExe)) return null

  const hasJavac = fs.existsSync(path.join(dir, 'bin', 'javac.exe'))
  const release = readReleaseFile(dir)
  const version = String(release.JAVA_VERSION || '') || versionFromDirName(dir)
  const vendor = detectVendor(release)

  return {
    path: path.resolve(dir),
    version: version || '未知',
    vendor: vendor,
    major: majorOf(version),
    release: release,
    isJdk: hasJavac,
    label: 'JDK ' + (version || path.basename(dir)),
  }
}

/** 候选安装根目录：覆盖常见发行版厂商目录 + 其他盘符 + 用户级目录 */
function candidateRoots() {
  const roots = []
  const push = (p) => {
    if (p) roots.push(p)
  }

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA
  const home = os.homedir()

  const vendorDirs = [
    'Java',
    'JavaSoft',
    'Eclipse Adoptium',
    'Eclipse Foundation',
    'Microsoft',
    'Zulu',
    'Azul',
    'Amazon Corretto',
    'BellSoft',
    'Semeru',
    'IBM',
    'SapMachine',
    'JetBrains',
    'Alibaba',
    'Tencent',
    'OpenJDK',
  ]

  for (const base of [programFiles, programFilesX86]) {
    for (const vendor of vendorDirs) push(path.join(base, vendor))
  }
  push(path.join(programFiles, 'Common Files', 'Oracle', 'Java'))

  if (localAppData) {
    push(path.join(localAppData, 'Programs', 'Eclipse Adoptium'))
    push(path.join(localAppData, 'Programs', 'Microsoft'))
    push(path.join(localAppData, 'Programs', 'Zulu'))
    push(path.join(localAppData, 'Programs', 'Amazon Corretto'))
    push(path.join(localAppData, 'Amazon Corretto'))
    push(path.join(localAppData, 'JetBrains', 'Toolbox', 'apps'))
  }

  if (home) {
    push(path.join(home, '.jdks'))
    push(path.join(home, '.sdkman', 'candidates', 'java'))
    push(path.join(home, 'scoop', 'apps'))
  }

  for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const drive = String.fromCharCode(code) + ':\\'
    try {
      if (!fs.existsSync(drive)) continue
    } catch (err) {
      continue
    }
    push(path.join(drive, 'Java'))
    push(path.join(drive, 'Program Files', 'Java'))
    push(path.join(drive, 'Program Files', 'Eclipse Adoptium'))
    push(path.join(drive, 'develop', 'Java'))
    push(path.join(drive, 'dev', 'Java'))
    push(path.join(drive, 'software', 'Java'))
    push(path.join(drive, 'SDK', 'Java'))
  }

  return roots
}

/** 全量扫描：手动补充 → 厂商目录 → 注册表 → 已有 JAVA*_HOME → PATH 反推 */
function scanJdks() {
  const found = new Map()

  const consider = (dir) => {
    if (!dir) return
    let resolved
    try {
      resolved = path.resolve(String(dir).trim().replace(/^"|"$/g, ''))
    } catch (err) {
      return
    }
    const key = resolved.toLowerCase()
    if (found.has(key)) return
    const info = describeJdk(resolved)
    if (info) found.set(key, info)
  }

  for (const dir of getManualPaths()) consider(dir)

  for (const root of candidateRoots()) {
    try {
      if (!fs.existsSync(root)) continue
    } catch (err) {
      continue
    }
    consider(root)
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch (err) {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      consider(path.join(root, entry.name))
    }
  }

  for (const dir of readRegistryJavaHomes()) consider(dir)
  for (const dir of readJavaHomeVars()) consider(dir)
  for (const dir of readPathJavaHomes()) consider(dir)

  const list = []
  found.forEach((info) => list.push(info))
  list.sort((a, b) => compareVersionDesc(a.version, b.version))
  return list
}

/* ================================================================== *
 * 六、运行状态快照（带缓存，避免每次按键都做 I/O）
 * ================================================================== */

let snapshotCache = { at: 0, data: null }

function invalidateSnapshot() {
  snapshotCache = { at: 0, data: null }
}

/**
 * 分析某一作用域 PATH 的原始文本。
 *   known   —— 是否成功读到该作用域的 Path
 *   hasEntry—— 是否包含 %JAVA_HOME%\bin
 *   shadow  —— 排在 %JAVA_HOME%\bin 之前、且自身能提供 java.exe 的目录（典型是 Oracle javapath）
 */
function analysePath(rawPath) {
  if (rawPath === null || rawPath === undefined) {
    return { known: false, hasEntry: false, shadow: null }
  }
  return {
    known: true,
    hasEntry: hasJavaHomeEntryInPath(rawPath),
    shadow: findShadowingJavaEntry(rawPath),
  }
}

/**
 * 判断哪些作用域的 PATH 需要修复。
 *
 * 关键事实（本机实测确认）：Windows 合并 PATH 时【系统 PATH 在前、用户 PATH 追加在后】。
 * 因此系统 PATH 里的 javapath 永远排在用户 PATH 的 %JAVA_HOME%\bin 之前 —— 只修用户 PATH
 * 是徒劳的，必须修系统 PATH。这正是"点了修复却没变化"的根本原因。
 */
function computeRepairScopes(machineInfo, userInfo) {
  // 两个作用域都读不到就别猜：宁可不说，也不要报假警
  if (!machineInfo.known && !userInfo.known) return []
  if (machineInfo.shadow) return [SCOPE_MACHINE]
  if (machineInfo.known && machineInfo.hasEntry) return []
  if (userInfo.shadow) return [SCOPE_USER]
  if (userInfo.hasEntry) return []
  return [SCOPE_USER]
}

function describeRepair(machineInfo, userInfo, scopes) {
  if (scopes.length === 0) return ''
  const blockers = []
  if (machineInfo.shadow) blockers.push('系统 PATH 的 ' + machineInfo.shadow)
  else if (userInfo.shadow) blockers.push('用户 PATH 的 ' + userInfo.shadow)

  let text
  if (blockers.length > 0) {
    text =
      blockers.join('、') +
      ' 排在 %JAVA_HOME%\\bin 前面，且它不读 JAVA_HOME，所以 java -version 不会跟着切换变；点击修复'
  } else {
    text = 'PATH 里没有 %JAVA_HOME%\\bin，java 不会跟随 JAVA_HOME 变化；点击修复'
  }
  if (scopes.indexOf(SCOPE_MACHINE) >= 0) text += '（需管理员，弹一次 UAC）'
  return text
}

function buildSnapshot() {
  const jdks = scanJdks()
  const scope = getScope()

  const envUser = queryEnvVar(SCOPE_USER, 'JAVA_HOME')
  const envMachine = queryEnvVar(SCOPE_MACHINE, 'JAVA_HOME')
  const activePath = envUser || envMachine || process.env.JAVA_HOME || ''
  const activeIsIndirect = /%[A-Za-z0-9_]+%/.test(activePath)

  // PATH 必须从注册表读取：插件进程的环境块是启动时的快照，不会反映最新写入
  const machineInfo = analysePath(queryRawPath(SCOPE_MACHINE))
  const userInfo = analysePath(queryRawPath(SCOPE_USER))
  const repairScopes = computeRepairScopes(machineInfo, userInfo)

  return {
    jdks: jdks,
    envUser: envUser,
    envMachine: envMachine,
    activePath: activePath,
    activeIsIndirect: activeIsIndirect,
    scope: scope,
    autoPath: getAutoFixPath(),
    machineInfo: machineInfo,
    userInfo: userInfo,
    repairScopes: repairScopes,
    fixDescription: describeRepair(machineInfo, userInfo, repairScopes),
    at: Date.now(),
  }
}

function getSnapshot(force) {
  const fresh = snapshotCache.at > 0 && Date.now() - snapshotCache.at < SCAN_TTL
  if (!force && fresh && snapshotCache.data) return snapshotCache.data
  const data = buildSnapshot()
  snapshotCache = { at: Date.now(), data: data }
  return data
}

/** 读取指定范围 PATH 的原始（未展开）文本 */
function queryRawPath(scope) {
  const key = scope === SCOPE_MACHINE ? REG_MACHINE_ENV : REG_USER_ENV
  const buf = runCapture(REG_EXE, ['query', key, '/v', 'Path'], EXEC_TIMEOUT)
  if (!buf) return null
  const text = bufferToText(buf)
  const match = /REG_(?:SZ|EXPAND_SZ)\s+([\s\S]+)/.exec(text)
  if (!match) return null
  const value = match[1].trim()
  return value === '' ? null : value
}

function hasJavaHomeEntryInPath(rawPath) {
  if (!rawPath) return false
  return rawPath.split(';').some((piece) => {
    const entry = piece.trim().replace(/\//g, '\\').toLowerCase()
    return entry === '%java_home%\\bin'
  })
}

/**
 * 找出 PATH 中排在 %JAVA_HOME%\bin 之前的、其他 java 启动器目录。
 * 典型捣乱者是 Oracle 的 javapath：它不读 JAVA_HOME，会抢在真正的 JDK 之前被命中。
 */
function findShadowingJavaEntry(rawPath) {
  if (!rawPath) return null
  const entries = rawPath
    .split(';')
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')

  const javaHomeIndex = entries.findIndex(
    (entry) => entry.replace(/\//g, '\\').toLowerCase() === '%java_home%\\bin'
  )

  for (let i = 0; i < entries.length; i++) {
    if (javaHomeIndex >= 0 && i >= javaHomeIndex) break
    const entry = entries[i]
    if (/^%[A-Za-z0-9_]+%/i.test(entry)) continue
    try {
      if (fs.existsSync(path.join(entry, 'java.exe'))) return entry
    } catch (err) {
      /* 忽略无法访问的 PATH 条目 */
    }
  }
  return null
}

/* ================================================================== *
 * 七、执行切换（PowerShell，同步执行，避免插件退出打断）
 * ================================================================== */

function buildOpsScript(ops, ctx, resultFile) {
  const opList = ops.map(psQuote).join(', ')

  return String.raw`
$ErrorActionPreference = 'Stop'
$messages = New-Object System.Collections.ArrayList
$ok = $true
$target = ${psQuote(ctx.target)}
$scope  = ${psQuote(ctx.scope)}
$other  = if ($scope -eq 'User') { 'Machine' } else { 'User' }
$ops    = @(${opList})

function Add-Msg([string]$m) { [void]$messages.Add($m) }

function Get-PathFirstEntry([string]$s) {
  $parts = @($s -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
  if ($parts.Count -eq 0) { return '' }
  return [string]$parts[0]
}

# PATH 里的 %VAR% 会用「合并后」的变量表展开（系统值被用户值覆盖）
function Expand-EnvText([string]$text, $map) {
  if ($text -eq '') { return '' }
  $guard = 0
  while ($guard -lt 20) {
    $guard++
    $m = [regex]::Match($text, '%([A-Za-z0-9_()]+)%')
    if (-not $m.Success) { break }
    $name = $m.Groups[1].Value.ToLower()
    if (-not $map.ContainsKey($name)) { break }
    $val = [string]$map[$name]
    if ($val -eq '') { break }
    $text = $text.Substring(0, $m.Index) + $val + $text.Substring($m.Index + $m.Length)
  }
  return $text
}

function Get-MergedVarMap {
  $map = @{}
  foreach ($s in @('Machine', 'User')) {
    $k = Open-EnvKeyRead $s
    if ($k -eq $null) { continue }
    try {
      foreach ($n in $k.GetValueNames()) {
        if ($n -eq '') { continue }
        $map[$n.ToLower()] = [string]$k.GetValue($n, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      }
    } finally { $k.Close() }
  }
  return $map
}

# 本机实测确认：合并 PATH = 系统 PATH 在前 + 用户 PATH 追加在后
function Get-MergedPathText {
  $map = Get-MergedVarMap
  $m = Expand-EnvText ([string](Get-RawEnvValue 'Machine' 'Path')) $map
  $u = Expand-EnvText ([string](Get-RawEnvValue 'User' 'Path')) $map
  $parts = @()
  if ($m -ne '') { $parts += $m }
  if ($u -ne '') { $parts += $u }
  return ($parts -join ';')
}

# 注意：HKLM 的环境变量不在 'HKLM\Environment'，而在 Session Manager 之下。
# 这里曾写成 OpenSubKey('Environment')，返回 $null，导致系统级修复 100% 失败。
$kUser = 'Environment'
$kMachine = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'

function Open-EnvKey([string]$s) {
  if ($s -eq 'User') { return [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($kUser, $true) }
  return [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($kMachine, $true)
}

function Open-EnvKeyRead([string]$s) {
  if ($s -eq 'User') { return [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($kUser, $false) }
  return [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($kMachine, $false)
}

function Get-EnvKeyLabel([string]$s) {
  if ($s -eq 'User') { return 'HKCU\' + $kUser }
  return 'HKLM\' + $kMachine
}

function Get-RawEnvValue([string]$s, [string]$name) {
  $k = Open-EnvKeyRead $s
  if ($k -eq $null) { return '' }
  try { return [string]$k.GetValue($name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $k.Close() }
}

foreach ($op in $ops) {
  $opName = [string]$op
  $opArg = ''
  $sep = $opName.IndexOf(':')
  if ($sep -ge 0) { $opArg = $opName.Substring($sep + 1); $opName = $opName.Substring(0, $sep) }
  try {
    switch ($opName) {
      'fixPath' {
        $fixScope = if ($opArg -ne '') { $opArg } else { $scope }
        $key = Open-EnvKey $fixScope
        if ($key -eq $null) { throw ('无法打开注册表键 ' + (Get-EnvKeyLabel $fixScope)) }
        $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $entry = '%JAVA_HOME%\bin'
        $parts = @($raw -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and $_ -ine $entry -and $_ -ine '%JAVA_HOME%/bin' })
        $first = ''
        if ($parts.Count -gt 0) { $first = [string]$parts[0] }
        $newPath = (@($entry) + $parts) -join ';'
        $key.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        $key.Close()
        $readBack = [string](Get-RawEnvValue $fixScope 'Path')
        $okNow = $readBack.Trim().StartsWith($entry, [System.StringComparison]::OrdinalIgnoreCase)
        if ($raw.Trim().StartsWith($entry, [System.StringComparison]::OrdinalIgnoreCase)) {
          Add-Msg ((Get-EnvKeyLabel $fixScope) + ' 首项原本就是 ' + $entry + '，无需改动')
        } elseif ($okNow) {
          Add-Msg ((Get-EnvKeyLabel $fixScope) + ' 首项 ' + $first + ' 已替换为 ' + $entry + '（已回读确认）')
        } else {
          Add-Msg ((Get-EnvKeyLabel $fixScope) + ' 写入后回读异常，请检查权限')
        }
      }
      'setJavaHome' {
        if (-not (Test-Path -LiteralPath (Join-Path $target 'bin\java.exe'))) {
          throw ('目标目录不是有效的 JDK：' + $target)
        }
        $key = Open-EnvKey $scope
        if ($key -eq $null) { throw ('无法打开注册表键 ' + (Get-EnvKeyLabel $scope)) }
        $key.SetValue('JAVA_HOME', $target, [Microsoft.Win32.RegistryValueKind]::String)
        $key.Close()
        $readBack = [string](Get-RawEnvValue $scope 'JAVA_HOME')
        if (-not $readBack.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)) {
          throw ('JAVA_HOME 回读不一致：期望 ' + $target + '，实际 ' + $readBack)
        }
        Add-Msg ((Get-EnvKeyLabel $scope) + ' JAVA_HOME = ' + $readBack + '（已回读确认）')
      }
      'removeOtherJavaHome' {
        $key = Open-EnvKey $other
        if ($key -eq $null) { throw ('无法打开 ' + $other + ' 范围的环境变量注册表键') }
        $existing = $key.GetValue('JAVA_HOME', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($existing -eq $null) {
          Add-Msg ($other + ' 范围没有 JAVA_HOME，无需清理')
        } else {
          $key.DeleteValue('JAVA_HOME', $false)
          Add-Msg ('已移除 ' + $other + ' 范围的 JAVA_HOME（原值：' + [string]$existing + '）')
        }
        $key.Close()
      }
      default { throw ('未知操作：' + $opName) }
    }
  } catch {
    $ok = $false
    Add-Msg ('[' + $opName + '] ' + $_.Exception.Message)
  }
}

# 依据合并后的 PATH 推断"新开的进程会命中哪个 java.exe"，再真实跑一次 java -version 作为最终验证。
$mergedPath = Get-MergedPathText
$firstJava = ''
foreach ($piece in $mergedPath.Split(';')) {
  $e = $piece.Trim()
  if ($e -eq '') { continue }
  try { $cand = Join-Path $e 'java.exe' } catch { continue }
  if (Test-Path -LiteralPath $cand) { $firstJava = $cand; break }
}

$jhUser = [string](Get-RawEnvValue 'User' 'JAVA_HOME')
$jhMachine = [string](Get-RawEnvValue 'Machine' 'JAVA_HOME')
$jhEffective = if ($jhUser -ne '') { $jhUser } else { $jhMachine }

$javaVersion = ''
if ($firstJava -ne '') {
  # java -version 把版本信息写到 stderr；在外层 $ErrorActionPreference='Stop' 下，
  # stderr 重定向会被当成终止性错误抛出来，所以这里必须先临时降级。
  $savedEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $env:Path = $mergedPath
    if ($jhEffective -ne '') { $env:JAVA_HOME = $jhEffective }
    foreach ($item in @(& $firstJava -version 2>&1)) {
      $t = ''
      if ($item -is [System.Management.Automation.ErrorRecord]) { $t = [string]$item.Exception.Message } else { $t = [string]$item }
      if ($t.Trim() -ne '') { $javaVersion = $t.Trim(); break }
    }  } catch {
    $javaVersion = ''
  } finally {
    $ErrorActionPreference = $savedEap
  }
}

# .NET 直接写注册表不会广播 WM_SETTINGCHANGE，资源管理器等已运行的进程仍用旧环境块，
# 这正是"改完在新窗口里仍是旧值"的原因之一。setx 会广播，我们手动补上同样的广播。
try {
  $sig = '[DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);'
  $u32 = Add-Type -MemberDefinition $sig -Name EnvBroadcast -Namespace SwitchJava -PassThru
  $res = [IntPtr]::Zero
  [void]$u32::SendMessageTimeout([IntPtr]0xffff, 0x1A, [IntPtr]::Zero, 'Environment', 2, 3000, [ref]$res)
} catch {
  # 广播失败只影响已运行程序是否立即刷新，不影响注册表写入结果
}

$payload = [ordered]@{
  ok = $ok
  messages = @($messages)
  verify = [ordered]@{
    firstJava = $firstJava
    javaVersion = $javaVersion
    javaHomeUser = $jhUser
    javaHomeMachine = $jhMachine
    javaHomeEffective = $jhEffective
    mergedPathLength = $mergedPath.Length
    machinePathFirst = (Get-PathFirstEntry ([string](Get-RawEnvValue 'Machine' 'Path')))
    userPathFirst = (Get-PathFirstEntry ([string](Get-RawEnvValue 'User' 'Path')))
  }
}
$payload | ConvertTo-Json -Compress -Depth 5 | Set-Content -LiteralPath ${psQuote(resultFile)} -Encoding UTF8
`
}

function normalizeMessages(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((item) => String(item))
  return [String(value)]
}

/**
 * 把脚本落成 .ps1 临时文件。
 * 必须带 UTF-8 BOM：PowerShell 5.1 看不到 BOM 时会按 ANSI 解析，脚本里的中文全部乱码。
 */
function writeScriptFile(script, stamp) {
  const file = path.join(tempDir(), 'switchjava-' + stamp + '.ps1')
  const bom = Buffer.from([0xef, 0xbb, 0xbf])
  fs.writeFileSync(file, Buffer.concat([bom, Buffer.from(String(script), 'utf8')]))
  return file
}

/**
 * 运行一组操作。
 * 需要写入系统级环境变量（或需要清理系统级 JAVA_HOME）时自动提权，UAC 只弹一次。
 *
 * ⚠ 曾经的致命缺陷：提权时把整段脚本 base64 之后再套一层 base64 塞进 -EncodedCommand，
 * 外层命令行因此膨胀到约 59000 字符，远超 Windows 的 32767 上限，
 * 子进程根本无法启动（Node 侧直接 spawn 失败）。现象就是"点修复没反应、切换也失败"。
 * 现在改为把脚本写成临时 .ps1，外层只负责用 -File 拉起它，
 * 命令行长度与脚本规模彻底解耦（外层只剩约 700 字符）。
 */
function runOps(ops, ctx) {
  const stamp = process.pid + '-' + Date.now()
  const resultFile = path.join(tempDir(), 'switchjava-' + stamp + '.json')
  const scriptFile = writeScriptFile(buildOpsScript(ops, ctx, resultFile), stamp)

  const needsElevation =
    ctx.scope === SCOPE_MACHINE ||
    ops.some((op) => /:Machine$/.test(op)) ||
    (ctx.scope === SCOPE_USER && ops.indexOf('removeOtherJavaHome') >= 0)

  // -WindowStyle Hidden 是"不弹黑窗"的第一道保险： PowerShell 启动时就把自己的控制台
  // 窗口设为隐藏。它对 -File 与 -EncodedCommand 两种调用方式都有效。
  const commonArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
  ]

  let launchError = null
  try {
    if (needsElevation) {
      // 外层脚本自身很短，走 -EncodedCommand 只为杜绝引号注入；
      // 真正的逻辑脚本通过 -File 交给管理员进程执行。
      //
      // 隐藏窗口是双保险：
      //   ① Start-Process 的 -WindowStyle Hidden 作用于被创建进程的窗口；
      //   ② 参数里再带一个 -WindowStyle Hidden，让提权后的 powershell 自己把
      //      控制台窗口藏起来。少了其中任何一个，Windows 上都会闪出一个黑框
      //      （这正是"切换/修复时会弹出 PowerShell 窗口"的来源）。
      // UAC 授权对话框本身无法隐藏，也不需要隐藏。
      const outerScript = [
        'try {',
        '  $p = Start-Process -FilePath ' +
          psQuote(PS_EXE) +
          " -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ArgumentList '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File'," +
          psQuote(scriptFile),
        '  exit [int]$p.ExitCode',
        '} catch {',
        '  exit 1223',
        '}',
      ].join('\n')
      execFileSync(PS_EXE, commonArgs.concat(['-EncodedCommand', toBase64Utf16(outerScript)]), {
        timeout: ELEVATE_TIMEOUT,
        windowsHide: true,
        stdio: 'pipe',
      })
    } else {
      execFileSync(PS_EXE, commonArgs.concat(['-File', scriptFile]), {
        timeout: EXEC_TIMEOUT,
        windowsHide: true,
        stdio: 'pipe',
      })
    }
  } catch (err) {
    launchError = err
  } finally {
    try {
      fs.unlinkSync(scriptFile)
    } catch (err) {
      /* 临时脚本清理失败可忽略 */
    }
  }

  let payload = null
  try {
    const raw = fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '')
    payload = JSON.parse(raw)
  } catch (err) {
    payload = null
  }
  try {
    fs.unlinkSync(resultFile)
  } catch (err) {
    /* 临时文件清理失败可忽略 */
  }

  if (payload && typeof payload === 'object') {
    return {
      ok: payload.ok === true,
      messages: normalizeMessages(payload.messages),
      verify: payload.verify && typeof payload.verify === 'object' ? payload.verify : null,
    }
  }

  if (launchError) {
    const detail = (bufferToText(launchError.stderr) + ' ' + String(launchError.message || '')).trim()
    // 1223 = ERROR_CANCELLED：用户在 UAC 对话框点了「否」
    if (launchError.status === 1223 || /取消|cancell?ed|0x800704c7/i.test(detail)) {
      return { ok: false, cancelled: true, messages: ['已取消管理员授权，未做任何修改'] }
    }
    return { ok: false, messages: ['执行失败：' + detail] }
  }

  return { ok: false, messages: ['未取得执行结果（脚本没写出结果文件，可能被安全软件拦截）'] }
}

/* ================================================================== *
 * 八、业务动作
 * ================================================================== */

function formatResult(prefix, result) {
  if (!result.ok) return prefix + '失败：' + result.messages.join('；')
  let text = prefix + '完成 — ' + result.messages.join('；')
  const verify = result.verify
  if (verify) {
    if (verify.javaVersion) {
      text += '；实测 java -version → ' + verify.javaVersion
    } else if (verify.firstJava) {
      text += '；java 会命中 ' + verify.firstJava + '（未取到版本输出）'
    }
  }
  return text
}

/** 从 `openjdk version "21.0.6" ...` 这类文本取主版本号（Java 8 时代写作 1.8.0_x → 8） */
function versionMajorFromText(text) {
  const match = /version\s+"([0-9][0-9._]*)"/i.exec(String(text || ''))
  if (!match) return ''
  const parts = match[1].split(/[._]/)
  return parts[0] === '1' && parts.length > 1 ? parts[1] : parts[0]
}

function performSwitch(jdk, callbackSetList) {
  const scope = getScope()
  const snapshot = getSnapshot(false)
  const ops = []

  // 只修「当前作用域」里的 PATH。写用户级 PATH 不需要管理员，常规切换因此保持
  // 免 UAC、瞬时完成；系统 PATH 里的抢占项（javapath）交给列表里那个显式修复项。
  // 不能把提权捆绑进切换：一旦用户在 UAC 上点「否」，连 JAVA_HOME 都写不进去。
  if (getAutoFixPath() && snapshot.repairScopes.indexOf(scope) >= 0) {
    ops.push('fixPath:' + scope)
  }
  ops.push('setJavaHome')

  try {
    window.utools.hideMainWindow()
  } catch (err) {
    /* 无 UI 模式下没有主窗口可隐藏 */
  }

  const result = runOps(ops, { scope: scope, target: jdk.path })
  invalidateSnapshot()

  if (!result.ok) {
    const text = '切换失败：' + result.messages.join('；')
    rememberResult(false, text)
    // 弹窗为主，通知兜底（弹窗失败或旧版 uTools 才用）
    if (!showResultDialog(false, '切换失败', result.messages.join('；'))) {
      notify(text)
    }
    // 失败时不要急着退出：把结果留在列表里，用户才能看清到底发生了什么
    if (typeof callbackSetList === 'function') {
      refresh(callbackSetList)
      return
    }
    window.utools.outPlugin()
    return
  }

  let message = 'JAVA_HOME → ' + (jdk.label || jdk.path) + '（' + scopeLabel(scope) + '）'
  // JAVA_HOME 是普通变量：同名的用户级变量会覆盖系统级。所以只有写系统级时，
  // 才可能被已有的用户级值盖掉；写用户级是能盖住系统级的，不该报警。
  if (scope === SCOPE_MACHINE) {
    const userValue = queryEnvVar(SCOPE_USER, 'JAVA_HOME')
    if (userValue && !samePath(userValue, jdk.path)) {
      message += '；注意：用户级 JAVA_HOME=' + userValue + ' 优先级更高，会让本次系统级设置失效'
    }
  }

  const verify = result.verify || {}
  if (verify.javaVersion) {
    message += '；新进程实测 java -version → ' + verify.javaVersion
    const actualMajor = versionMajorFromText(verify.javaVersion)
    if (jdk.major && actualMajor && actualMajor !== jdk.major) {
      message += '（注意：与所选 JDK ' + jdk.major + ' 不一致）'
    }
  } else if (verify.firstJava) {
    message += '；java 将命中 ' + verify.firstJava
  }

  // 真正卡住 java 的抢占项在「另一个」作用域时，必须说清楚，
  // 否则用户只会看到"切换了却没变化"，这正是本次要解决的困惑。
  const remaining = snapshot.repairScopes.filter((item) => item !== scope)
  if (remaining.length > 0) {
    message +=
      '；⚠ ' +
      remaining.map(scopeLabel).join('、') +
      ' PATH 里仍有会抢先的 java 目录，需点击列表中的「⚠ 修复 PATH 抢占（改' +
      remaining.map(scopeLabel).join(' 与 ') +
      '）」（需管理员）'
  }

  rememberResult(true, message)
  // 提示框要能撑过 outPlugin：独立窗口不随插件退出销毁（客户端源码已确认）
  if (!showResultDialog(true, '切换完成', message + '\n已打开的终端需重开才生效。')) {
    notify(message + '。已打开的终端需重开才生效。')
  }
  window.utools.outPlugin()
}

function findJdkByMajor(major) {
  const snapshot = getSnapshot(false)
  const wanted = String(major || '').trim()
  if (wanted === '') return null
  return (
    snapshot.jdks.find((jdk) => jdk.major === wanted) ||
    snapshot.jdks.find((jdk) => jdk.version.indexOf(wanted + '.') === 0) ||
    null
  )
}

function toggleScope() {
  const next = getScope() === SCOPE_USER ? SCOPE_MACHINE : SCOPE_USER
  storageSet(KEY_SCOPE, next)
  invalidateSnapshot()
  notify('写入范围已切换为「' + scopeLabel(next) + '」' + (next === SCOPE_MACHINE ? '（切换时会弹出 UAC）' : '（免管理员）'))
}

function pickManualJdk() {
  let picked = null
  try {
    picked = utools.showOpenDialog({
      title: '选择 JDK 根目录（应包含 bin\\java.exe）',
      properties: ['openDirectory'],
    })
  } catch (err) {
    picked = null
  }
  if (!picked || !picked.length) return

  const info = describeJdk(picked[0])
  if (!info) {
    notify('该目录不是有效的 JDK（未找到 bin\\java.exe）')
    return
  }
  if (addManualPath(info.path)) {
    invalidateSnapshot()
    notify('已添加 ' + info.label + '：' + info.path)
  } else {
    notify('该目录已在列表中')
  }
}

function runFixPath() {
  const snapshot = getSnapshot(false)
  const scopes = snapshot.repairScopes.length > 0 ? snapshot.repairScopes : [getScope()]
  const ops = scopes.map((target) => 'fixPath:' + target)
  const result = runOps(ops, { scope: getScope(), target: '' })
  invalidateSnapshot()
  const text = formatResult('PATH 修复', result)
  rememberResult(result.ok, text)
  // 不退出插件：列表里同步显示结果（失败标红），并弹出提示框双重确认
  if (!showResultDialog(result.ok, result.ok ? 'PATH 修复完成' : 'PATH 修复失败', text)) {
    notify(text)
  }
}

function runRemoveOtherJavaHome() {
  const scope = getScope()
  const result = runOps(['removeOtherJavaHome'], { scope: scope, target: '' })
  invalidateSnapshot()
  const text = result.ok
    ? '清理完成 — ' + result.messages.join('；')
    : '清理失败：' + result.messages.join('；')
  rememberResult(result.ok, text)
  if (!showResultDialog(result.ok, result.ok ? '清理完成' : '清理失败', text)) {
    notify(text)
  }
}

/* ================================================================== *
 * 九、列表渲染
 * ================================================================== */

function buildListItems(keyword) {
  const snapshot = getSnapshot(false)
  const kw = String(keyword || '').trim().toLowerCase()
  const tokens = kw === '' ? [] : kw.split(/\s+/)

  const matches = (item) => {
    if (tokens.length === 0) return true
    const haystack = String(item._search || '').toLowerCase()
    return tokens.every((token) => haystack.indexOf(token) >= 0)
  }

  const jdkItems = snapshot.jdks.map((jdk) => {
    const isActive = snapshot.activePath !== '' && samePath(snapshot.activePath, jdk.path)
    const notes = []
    if (isActive) notes.push('当前 JAVA_HOME')
    if (!jdk.isJdk) notes.push('仅 JRE')

    return {
      title: (isActive ? '✓ ' : '') + (jdk.label || jdk.path),
      description: [jdk.vendor, jdk.path].concat(notes).filter(Boolean).join(' · '),
      icon: '',
      _kind: 'jdk',
      _path: jdk.path,
      _label: jdk.label,
      _search: [jdk.version, jdk.major, jdk.vendor, jdk.path].join(' '),
    }
  })

  const actionItems = []

  actionItems.push({
    title: '⚙ 写入范围：' + scopeLabel(snapshot.scope),
    description:
      snapshot.scope === SCOPE_MACHINE
        ? '点击切换为「用户级」：免 UAC，但只对当前用户生效'
        : '点击切换为「系统级」：需 UAC，对全部用户生效',
    icon: '',
    _kind: 'scope',
    _search: 'scope 作用域 范围 用户 系统 权限 uac 管理员',
  })

  actionItems.push({
    title: '＋ 手动添加 JDK 目录',
    description: '扫描不到时手动指定 JDK 根目录（应包含 bin\\java.exe），路径会被记住',
    icon: '',
    _kind: 'add',
    _search: 'add 添加 手动 目录 路径 指定',
  })

  actionItems.push({
    title: '⟳ 重新扫描本机 JDK',
    description: '忽略缓存立即重新扫描（缓存有效期 ' + Math.round(SCAN_TTL / 1000) + ' 秒）',
    icon: '',
    _kind: 'rescan',
    _search: 'rescan 重新扫描 刷新 更新',
  })

  if (snapshot.repairScopes.length > 0) {
    actionItems.push({
      title: '⚠ 修复 PATH 抢占（改' + snapshot.repairScopes.map(scopeLabel).join(' 与 ') + '）',
      description: snapshot.fixDescription,
      icon: '',
      _kind: 'fixPath',
      _fix: true,
      _search: 'path 修复 诊断 清理 fix 问题 抢占 javapath',
    })
  }

  actionItems.push({
    title: (snapshot.autoPath ? '☑' : '☐') + ' 切换时自动修复 PATH',
    description: snapshot.autoPath
      ? '已开启：只在抢占确实存在时修复对应作用域（系统 PATH 需管理员）'
      : '已关闭：切换时只写 JAVA_HOME，不修改 PATH',
    icon: '',
    _kind: 'autoPath',
    _search: 'path 自动 修复 开关 设置',
  })

  // JAVA_HOME 属于「普通变量」：同名的用户级变量会覆盖系统级变量。
  // 所以只有「写入系统级、且用户级已有值」时才会被覆盖；
  // 反过来写用户级是能盖住系统级的，那种情况不算冲突，不该报警。
  if (snapshot.scope === SCOPE_MACHINE && snapshot.envUser) {
    actionItems.push({
      title: '⚠ 用户级 JAVA_HOME 会覆盖系统级',
      description:
        '用户级存在 JAVA_HOME=' + snapshot.envUser + '，它优先级更高，会让本次系统级设置失效；点击清除',
      icon: '',
      _kind: 'cleanConflict',
      _fix: true,
      _search: 'conflict 冲突 清理 覆盖 重复 用户级',
    })
  }

  if (snapshot.activeIsIndirect) {
    actionItems.push({
      title: '⚠ 当前 JAVA_HOME 是间接引用',
      description:
        '当前值为 ' + snapshot.activePath + '，IDEA / Maven 等工具不会展开它；点选任一 JDK 即可覆盖为真实路径',
      icon: '',
      _kind: 'hint',
      _search: '间接 引用 未展开 无效 indirect',
    })
  }

  const visible = jdkItems.filter(matches).concat(actionItems.filter(matches))

  // 把上一次操作的结果顶到最前（失败时标红），让"到底有没有生效"一眼可见
  if (kw === '' && lastResult) {
    visible.unshift({
      title: lastResult.ok ? '✔ 上次操作成功' : '✖ 上次操作失败（回车可关闭此提示）',
      description: lastResult.text,
      icon: '',
      _kind: 'dismissResult',
      _fix: !lastResult.ok,
      _search: '上次 结果 状态 日志 last result',
    })
  }

  if (kw === '' && snapshot.jdks.length === 0) {
    visible.unshift({
      title: '未检测到任何 JDK',
      description: '请点击「＋ 手动添加 JDK 目录」指定位置，或安装 JDK 后重新扫描',
      icon: '',
      _kind: 'hint',
      _search: '未检测',
    })
  }

  if (visible.length === 0) {
    visible.push({
      title: '没有匹配项',
      description: '可直接输入版本号，如 8 / 17 / 21',
      icon: '',
      _kind: 'hint',
      _search: '没有匹配',
    })
  }

  return visible
}

/* ================================================================== *
 * 十、修复类条目的红色标识
 *
 * 为什么不能直接写 HTML：uTools 模板列表的 title / description 是按纯文本渲染的。
 * uTools 7.8.0 客户端（resources/app.asar）中的列表组件是 React，渲染代码为
 *     createElement('div', { className: 'list-item-title' }, item.title)
 * 文本作为 React 子节点插入，标签会被转义，所以 title 里写 <span style="color:red">
 * 只会把标签原样显示出来。官方亦未开放 item 的样式字段。
 *
 * 可行做法：模板插件的 preload 与列表界面处于同一个渲染进程、同一个 DOM 中
 * （列表组件直接调用 window.exports[code].args.enter / search，说明二者同域），
 * 因此可以：
 *   1) 往 document.head 注入一段样式；
 *   2) 给「修复类」条目的 .list-item 节点补上标记类，呈现红色文字 + 左侧红条。
 *
 * 列表节点由 React 管理，选中态切换时 React 会重写 className 抹掉标记类，
 * 故用一个幂等的 MutationObserver 把标记补回来。
 * 以上全部只是配色：任何一步失败都不影响切换功能，条目仍保留 ⚠ 前缀兜底。
 * ================================================================== */

const FIX_CLASS = 'switchjava-fix'
const FIX_STYLE_ID = 'switchjava-fix-style'
const FIX_COLOR_LIGHT = '#d92d20'
const FIX_COLOR_DARK = '#ff7b72'

/** 当前列表中「修复类」条目的标题集合（按 title 匹配 DOM 节点） */
let fixTitles = []
let fixObserver = null
let fixScheduled = false

function hasDom() {
  return typeof document !== 'undefined' && !!document && !!document.head && !!document.body
}

function hexToRgba(hex, alpha) {
  return (
    'rgba(' +
    parseInt(hex.slice(1, 3), 16) +
    ',' +
    parseInt(hex.slice(3, 5), 16) +
    ',' +
    parseInt(hex.slice(5, 7), 16) +
    ',' +
    alpha +
    ')'
  )
}

function buildFixCss() {
  const base = [
    '.list .list-item.' + FIX_CLASS + '{box-shadow:inset 3px 0 0 0 ' + FIX_COLOR_LIGHT + ';}',
    '.list .list-item.' + FIX_CLASS + ' .list-item-title{color:' + FIX_COLOR_LIGHT + ' !important;font-weight:600;}',
    '.list .list-item.' + FIX_CLASS + ' .list-item-description{color:' + FIX_COLOR_LIGHT + ' !important;opacity:.85;}',
  ].join('')
  const selected =
    '.list .list-item.' + FIX_CLASS + '.list-item-selected{background-color:' + hexToRgba(FIX_COLOR_LIGHT, 0.16) + ';}'
  const dark = [
    '.list .list-item.' + FIX_CLASS + ' .list-item-title{color:' + FIX_COLOR_DARK + ' !important;}',
    '.list .list-item.' + FIX_CLASS + ' .list-item-description{color:' + FIX_COLOR_DARK + ' !important;}',
    '.list .list-item.' + FIX_CLASS + '.list-item-selected{background-color:' + hexToRgba(FIX_COLOR_DARK, 0.22) + ';}',
  ].join('')
  return base + selected + '@media (prefers-color-scheme: dark){' + dark + '}'
}

function installFixStyle() {
  if (!hasDom()) return false
  try {
    if (document.getElementById(FIX_STYLE_ID)) return true
    const style = document.createElement('style')
    style.id = FIX_STYLE_ID
    style.textContent = buildFixCss()
    document.head.appendChild(style)
    return true
  } catch (err) {
    return false
  }
}

/** 幂等：该加标记的加上、该去掉的去掉了，重复执行不会产生额外变化 */
function applyFixMarks() {
  fixScheduled = false
  if (!hasDom()) return

  let nodes
  try {
    nodes = document.querySelectorAll('.list .list-item')
  } catch (err) {
    return
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const titleNode = node.querySelector('.list-item-title')
    const title = titleNode ? String(titleNode.textContent || '') : ''
    const should = fixTitles.length > 0 && fixTitles.indexOf(title) >= 0
    try {
      if (node.classList.contains(FIX_CLASS) !== should) node.classList.toggle(FIX_CLASS, should)
    } catch (err) {
      /* 单个节点异常不影响其它条目 */
    }
  }
}

function scheduleFixMarks() {
  if (fixScheduled) return
  fixScheduled = true
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(applyFixMarks)
  } else {
    setTimeout(applyFixMarks, 16)
  }
  // 兜底：React 若把更新推迟到下一帧之后，再补一次
  setTimeout(applyFixMarks, 100)
}

function startFixObserver() {
  if (fixObserver || !hasDom() || typeof MutationObserver !== 'function') return
  try {
    fixObserver = new MutationObserver(scheduleFixMarks)
    fixObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    })
  } catch (err) {
    fixObserver = null
  }
}

function stopFixObserver() {
  if (!fixObserver) return
  try {
    fixObserver.disconnect()
  } catch (err) {
    /* 忽略 */
  }
  fixObserver = null
}

/** 每次刷新列表后调用：同步标记集合，并立即（及异步）重打标记 */
function syncFixMarks(items) {
  const titles = []
  for (const item of items) {
    if (item && item._fix && titles.indexOf(item.title) < 0) titles.push(item.title)
  }
  fixTitles = titles

  if (!hasDom()) return

  if (titles.length === 0) {
    stopFixObserver()
    applyFixMarks()
    return
  }
  if (!installFixStyle()) return
  startFixObserver()
  scheduleFixMarks()
}

/* ================================================================== *
 * 十一、模板插件应用入口
 * ================================================================== */

let lastKeyword = ''

function refresh(callbackSetList, keyword) {
  lastKeyword = keyword === undefined ? lastKeyword : keyword
  const items = buildListItems(lastKeyword)
  callbackSetList(items)
  syncFixMarks(items)
}

window.exports = {
  // 与 plugin.json 中 features[].code 对应 —— 列表模式
  switch: {
    mode: 'list',
    args: {
      enter: (action, callbackSetList) => {
        if (!IS_WIN) {
          notify('SwitchJava 仅支持 Windows')
          window.utools.outPlugin()
          return
        }
        refresh(callbackSetList, '')
      },

      search: (action, searchWord, callbackSetList) => {
        refresh(callbackSetList, searchWord)
      },

      select: (action, itemData, callbackSetList) => {
        const kind = itemData && itemData._kind

        if (kind === 'dismissResult') {
          lastResult = null
          refresh(callbackSetList)
          return
        }

        if (kind === 'jdk') {
          const snapshot = getSnapshot(false)
          const jdk = snapshot.jdks.find((item) => samePath(item.path, itemData._path))
          if (!jdk) {
            notify('该 JDK 目录已失效，请重新扫描')
            invalidateSnapshot()
            refresh(callbackSetList)
            return
          }
          performSwitch(jdk, callbackSetList)
          return
        }

        if (kind === 'scope') {
          toggleScope()
          refresh(callbackSetList)
          return
        }

        if (kind === 'autoPath') {
          storageSet(KEY_AUTO_PATH, !getAutoFixPath())
          invalidateSnapshot()
          refresh(callbackSetList)
          notify(getAutoFixPath() ? '已开启 PATH 自动修复' : '已关闭 PATH 自动修复')
          return
        }

        if (kind === 'add') {
          pickManualJdk()
          refresh(callbackSetList)
          return
        }

        if (kind === 'rescan') {
          invalidateSnapshot()
          refresh(callbackSetList)
          notify('已重新扫描，发现 ' + getSnapshot(false).jdks.length + ' 个 JDK')
          return
        }

        if (kind === 'fixPath') {
          runFixPath()
          refresh(callbackSetList)
          return
        }

        if (kind === 'cleanConflict') {
          runRemoveOtherJavaHome()
          refresh(callbackSetList)
          return
        }
      },

      placeholder: '输入版本号或厂商筛选，如 17 / temurin',
    },
  },

  // 与 plugin.json 中 regex 匹配指令的 code 对应 —— 无 UI 模式，直接切换
  'switch-version': {
    mode: 'none',
    args: {
      enter: (action) => {
        if (!IS_WIN) {
          notify('SwitchJava 仅支持 Windows')
          return
        }
        const major = String((action && action.payload) || '').trim()
        const jdk = findJdkByMajor(major)
        if (!jdk) {
          notify('未找到 JDK ' + major + '，请先用 switchjava 查看已安装的版本')
          return
        }
        performSwitch(jdk)
      },
    },
  },
}

/* 离开插件时撤销标记，避免在其它插件的列表里残留样式观察 */
try {
  if (typeof utools.onPluginOut === 'function') {
    utools.onPluginOut(() => {
      fixTitles = []
      stopFixObserver()
      applyFixMarks()
    })
  }
} catch (err) {
  /* 旧版本 uTools 没有该 API 时忽略 */
}
