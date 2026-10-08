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

function buildSnapshot() {
  const jdks = scanJdks()
  const scope = getScope()

  const envUser = queryEnvVar(SCOPE_USER, 'JAVA_HOME')
  const envMachine = queryEnvVar(SCOPE_MACHINE, 'JAVA_HOME')
  const activePath = envUser || envMachine || process.env.JAVA_HOME || ''
  const activeIsIndirect = /%[A-Za-z0-9_]+%/.test(activePath)

  // PATH 必须从注册表读取：插件进程的环境块是启动时的快照，不会反映最新写入
  const rawPath = queryRawPath(scope)
  const shadowingEntry = findShadowingJavaEntry(rawPath)
  const pathHasEntry = rawPath === null ? false : hasJavaHomeEntryInPath(rawPath)

  return {
    jdks: jdks,
    envUser: envUser,
    envMachine: envMachine,
    activePath: activePath,
    activeIsIndirect: activeIsIndirect,
    scope: scope,
    autoPath: getAutoFixPath(),
    pathHasEntry: pathHasEntry,
    shadowingEntry: shadowingEntry,
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

function Open-EnvKey([string]$s) {
  if ($s -eq 'User') { return [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true) }
  return [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('Environment', $true)
}

foreach ($op in $ops) {
  try {
    switch ($op) {
      'fixPath' {
        $key = Open-EnvKey $scope
        if ($key -eq $null) { throw ('无法打开 ' + $scope + ' 范围的环境变量注册表键') }
        $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $entry = '%JAVA_HOME%\bin'
        $parts = @($raw -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and $_ -ine $entry -and $_ -ine '%JAVA_HOME%/bin' })
        $newPath = (@($entry) + $parts) -join ';'
        if ($newPath -ne $raw) {
          $key.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
          Add-Msg 'PATH 已修正：%JAVA_HOME%\bin 已置于最前'
        } else {
          Add-Msg 'PATH 已是最优状态'
        }
        $key.Close()
      }
      'setJavaHome' {
        if (-not (Test-Path -LiteralPath (Join-Path $target 'bin\java.exe'))) {
          throw ('目标目录不是有效的 JDK：' + $target)
        }
        $setx = Join-Path $env:SystemRoot 'System32\setx.exe'
        if ($scope -eq 'User') { & $setx JAVA_HOME $target | Out-Null } else { & $setx JAVA_HOME $target /M | Out-Null }
        if ($LASTEXITCODE -ne 0) { throw ('setx 写入失败，退出码 ' + $LASTEXITCODE) }
        Add-Msg ('JAVA_HOME 已写入 ' + $scope + ' 范围：' + $target)
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
      default { throw ('未知操作：' + $op) }
    }
  } catch {
    $ok = $false
    Add-Msg ('[' + $op + '] ' + $_.Exception.Message)
  }
}

$payload = [ordered]@{ ok = $ok; messages = @($messages) }
$payload | ConvertTo-Json -Compress -Depth 4 | Set-Content -LiteralPath ${psQuote(resultFile)} -Encoding UTF8
`
}

function normalizeMessages(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((item) => String(item))
  return [String(value)]
}

/**
 * 运行一组操作。
 * 需要写入系统级环境变量（或需要清理系统级 JAVA_HOME）时自动提权，UAC 只弹一次。
 */
function runOps(ops, ctx) {
  const resultFile = path.join(
    tempDir(),
    'switchjava-' + process.pid + '-' + Date.now() + '.json'
  )
  const script = buildOpsScript(ops, ctx, resultFile)
  const innerArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    toBase64Utf16(script),
  ]

  const needsElevation =
    ctx.scope === SCOPE_MACHINE ||
    (ctx.scope === SCOPE_USER && ops.indexOf('removeOtherJavaHome') >= 0)

  let launchError = null
  try {
    if (needsElevation) {
      const outerScript =
        'Start-Process -FilePath ' +
        psQuote(PS_EXE) +
        ' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ' +
        innerArgs.map(psQuote).join(', ')
      execFileSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', toBase64Utf16(outerScript)], {
        timeout: ELEVATE_TIMEOUT,
        windowsHide: true,
        stdio: 'pipe',
      })
    } else {
      execFileSync(PS_EXE, innerArgs, {
        timeout: EXEC_TIMEOUT,
        windowsHide: true,
        stdio: 'pipe',
      })
    }
  } catch (err) {
    launchError = err
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
    return { ok: payload.ok === true, messages: normalizeMessages(payload.messages) }
  }

  if (launchError) {
    const detail = (bufferToText(launchError.stderr) + ' ' + String(launchError.message || '')).trim()
    if (/取消|cancell?ed|0x800704c7/i.test(detail)) {
      return { ok: false, cancelled: true, messages: ['已取消管理员授权'] }
    }
    return { ok: false, messages: ['执行失败：' + detail] }
  }

  return { ok: false, messages: ['未取得执行结果，可能被安全软件拦截'] }
}

/* ================================================================== *
 * 八、业务动作
 * ================================================================== */

function performSwitch(jdk) {
  const scope = getScope()
  const ops = []
  if (getAutoFixPath()) ops.push('fixPath')
  ops.push('setJavaHome')

  try {
    window.utools.hideMainWindow()
  } catch (err) {
    /* 无 UI 模式下没有主窗口可隐藏 */
  }

  const result = runOps(ops, { scope: scope, target: jdk.path })
  invalidateSnapshot()

  if (!result.ok) {
    notify('切换失败：' + result.messages.join('；'))
  } else {
    let message = 'JAVA_HOME → ' + (jdk.label || jdk.path) + '（' + scopeLabel(scope) + '）'
    const otherScope = scope === SCOPE_MACHINE ? SCOPE_USER : SCOPE_MACHINE
    const otherValue = queryEnvVar(otherScope, 'JAVA_HOME')
    if (otherValue && !samePath(otherValue, jdk.path)) {
      message += '；注意：' + scopeLabel(otherScope) + '仍有 JAVA_HOME=' + otherValue + '，会覆盖本次设置'
    }
    notify(message + '。新开的终端窗口生效，已打开的窗口需重开。')
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
  const scope = getScope()
  const result = runOps(['fixPath'], { scope: scope, target: '' })
  invalidateSnapshot()
  notify(result.ok ? 'PATH 修复完成：' + result.messages.join('；') : 'PATH 修复失败：' + result.messages.join('；'))
}

function runRemoveOtherJavaHome() {
  const scope = getScope()
  const result = runOps(['removeOtherJavaHome'], { scope: scope, target: '' })
  invalidateSnapshot()
  notify(result.ok ? result.messages.join('；') : '清理失败：' + result.messages.join('；'))
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

  actionItems.push({
    title: (snapshot.autoPath ? '☑' : '☐') + ' 切换时自动修复 PATH',
    description: snapshot.autoPath
      ? '已开启：确保 %JAVA_HOME%\\bin 位于 PATH 最前，避免被 javapath 抢先'
      : '已关闭：切换时只写 JAVA_HOME，不修改 PATH',
    icon: '',
    _kind: 'autoPath',
    _search: 'path 自动 修复 开关 设置',
  })

  if (snapshot.shadowingEntry || !snapshot.pathHasEntry) {
    actionItems.push({
      title: '⚠ 修复 PATH',
      description: snapshot.shadowingEntry
        ? 'PATH 中的 ' + snapshot.shadowingEntry + ' 会抢先于 %JAVA_HOME%\\bin，点击修复'
        : 'PATH 中缺少 %JAVA_HOME%\\bin，点击修复',
      icon: '',
      _kind: 'fixPath',
      _search: 'path 修复 诊断 清理 fix 问题',
    })
  }

  const conflictScope = snapshot.scope === SCOPE_MACHINE ? SCOPE_USER : SCOPE_MACHINE
  const conflictValue = conflictScope === SCOPE_MACHINE ? snapshot.envMachine : snapshot.envUser
  if (conflictValue) {
    actionItems.push({
      title: '⚠ 清理冲突的 JAVA_HOME',
      description: scopeLabel(conflictScope) + ' 也存在 JAVA_HOME=' + conflictValue + '，会覆盖本次设置',
      icon: '',
      _kind: 'cleanConflict',
      _search: 'conflict 冲突 清理 覆盖 重复',
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
 * 十、模板插件应用入口
 * ================================================================== */

let lastKeyword = ''

function refresh(callbackSetList, keyword) {
  lastKeyword = keyword === undefined ? lastKeyword : keyword
  callbackSetList(buildListItems(lastKeyword))
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

        if (kind === 'jdk') {
          const snapshot = getSnapshot(false)
          const jdk = snapshot.jdks.find((item) => samePath(item.path, itemData._path))
          if (!jdk) {
            notify('该 JDK 目录已失效，请重新扫描')
            invalidateSnapshot()
            refresh(callbackSetList)
            return
          }
          performSwitch(jdk)
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
