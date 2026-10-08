/**
 * 执行层回归测试（不需要 uTools，也不需要 jsdom）。
 *
 * 背景：之前所有测试都只验证"生成的脚本文本长什么样"，从未验证它**能否被启动**。
 * 结果漏掉了一个致命缺陷——提权时把整段脚本 base64 再套一层 base64，
 * 外层命令行膨胀到约 59000 字符，超过 Windows 的 32767 上限，进程根本无法创建，
 * 表现为"点修复没反应、切换也失败"。本文件把这些约束固化成断言。
 *
 * 覆盖：
 *  1. 用户级切换不得提权（否则每次切换都弹 UAC，用户点「否」整个切换就失败）
 *  2. 提权必须用 -File 拉起临时脚本，命令行不得逼近 32767
 *  3. 临时脚本必须是 UTF-8 带 BOM（PowerShell 5.1 否则按 ANSI 解析中文）
 *  4. 脚本内的注册表键常量必须正确（HKLM 的键不在 HKLM\Environment）
 *  5. 操作结果要留在列表里，失败时标红且可关闭
 *
 * 用法：node test/exec-check.js
 */
'use strict'

const os = require('os')
const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')

const REPO = path.join(__dirname, '..')
const WIN_CMDLINE_LIMIT = 32767

let passed = 0
let failed = 0

function check(condition, label, note) {
  if (condition) {
    passed++
    console.log('  ✓ ' + label + (note === undefined ? '' : '  —— ' + note))
  } else {
    failed++
    console.log('  ✗ ' + label + (note === undefined ? '' : '  —— ' + note))
  }
}

/* ------------------------------------------------------------------ *
 * 注册表夹具：复刻用户这台机器的真实状态
 *   - 系统 PATH 里有 Oracle javapath（会抢在 %JAVA_HOME%\bin 之前）
 *   - 用户 PATH 首项已是 %JAVA_HOME%\bin
 * ------------------------------------------------------------------ */
const MACHINE_PATH =
  'C:\\Program Files\\Common Files\\Oracle\\Java\\javapath;' +
  '%SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\Git\\cmd'
const USER_PATH = '%JAVA_HOME%\\bin;C:\\Program Files (x86)\\pcsuite\\'

const fixtures = {
  machinePath: MACHINE_PATH,
  userPath: USER_PATH,
  machineJavaHome: 'C:\\Program Files\\Java\\jdk-17.0.3.1',
  userJavaHome: null,
}

function regReply(args) {
  const joined = args.join(' ')
  const isUserKey = /HKCU/i.test(joined)
  if (/\/v\s+Path/i.test(joined)) {
    return Buffer.from(
      '    Path    REG_EXPAND_SZ    ' + (isUserKey ? fixtures.userPath : fixtures.machinePath),
      'utf8'
    )
  }
  if (/\/v\s+JAVA_HOME/i.test(joined)) {
    const value = isUserKey ? fixtures.userJavaHome : fixtures.machineJavaHome
    return value ? Buffer.from('    JAVA_HOME    REG_SZ    ' + value, 'utf8') : null
  }
  if (/JavaSoft/i.test(joined)) return null
  const value = isUserKey ? fixtures.userJavaHome : fixtures.machineJavaHome
  const lines = ['HKEY  \\ ...']
  if (value) lines.push('    JAVA_HOME    REG_SZ    ' + value)
  return Buffer.from(lines.join('\r\n'), 'utf8')
}

const spawns = []        // 记录每一次 powershell 调用
const keptScripts = []   // 被保留下来的临时脚本路径

childProcess.execFileSync = function (file, args) {
  if (/reg\.exe$/i.test(String(file))) {
    return regReply(args) || Buffer.from('')
  }

  const fidx = args.indexOf('-File')
  const eidx = args.indexOf('-EncodedCommand')
  const record = {
    file: String(file),
    args: args,
    cmdline: ('"' + file + '" ' + args.map((a) => '"' + a + '"').join(' ')).length,
    elevated: false,
    scriptFile: null,
    outer: null,
  }

  if (fidx >= 0) {
    record.scriptFile = args[fidx + 1]
  } else if (eidx >= 0) {
    record.elevated = true
    record.outer = Buffer.from(args[eidx + 1], 'base64').toString('utf16le')
    const m = /'-File',\s*'([^']+)'/.exec(record.outer)
    if (m) record.scriptFile = m[1]
    // 外层命令行由 Node 直接传给 powershell.exe，同样受 32767 限制
  }
  spawns.push(record)
  return Buffer.from('')
}

// 让临时脚本存活下来以便检查；同时记录路径
const realUnlink = fs.unlinkSync
fs.unlinkSync = function (target) {
  const text = String(target)
  if (/\.ps1$/i.test(text) && fs.existsSync(text)) {
    keptScripts.push(text)
  }
  if (/\.ps1$/i.test(text)) return
  return realUnlink.apply(fs, arguments)
}

/* ------------------------------------------------------------------ *
 * 启动 preload（每个场景都需要干净的快照缓存，故按场景重新加载）
 * ------------------------------------------------------------------ */
function loadPlugin(scope) {
  const store = new Map()
  store.set('switchjava/scope', scope)
  store.set('switchjava/manual', [])

  const utoolsMock = {
    getPath: () => os.tmpdir(),
    dbStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    showNotification: (m) => {
      utoolsMock.lastNotify = String(m)
    },
    showOpenDialog: () => undefined,
  }
  global.utools = utoolsMock
  global.window = {
    utools: { hideMainWindow: () => {}, outPlugin: () => (utoolsMock.outPluginCalled = true) },
  }

  delete require.cache[require.resolve(path.join(REPO, 'preload.js'))]
  require(path.join(REPO, 'preload.js'))
  return { api: global.window.exports.switch, utools: utoolsMock }
}

function listOf(api) {
  let items = null
  api.args.enter({}, (list) => {
    items = list
  })
  return items
}

function readScript(file) {
  const buf = fs.readFileSync(file)
  return {
    hasBom: buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
    text: buf.slice(3).toString('utf8'),
  }
}

/* ================================================================== *
 * 场景一：用户级切换（本机就是"javapath 在系统 PATH"这种坏状态）
 * ================================================================== */
console.log('')
console.log('===== 场景一：用户级切换不得提权 =====')
{
  spawns.length = 0
  const { api } = loadPlugin('User')
  const items = listOf(api)
  const fixItem = items.find((i) => i._kind === 'fixPath')
  check(!!fixItem, '列出了修复类条目', fixItem ? fixItem.title : '(无)')

  api.args.select({}, { _kind: 'jdk', _path: 'C:\\Program Files\\Java\\jdk-21', _label: 'JDK 21' }, () => {})

  check(spawns.length > 0, '确实发起了 powershell 调用', spawns.length + ' 次')
  const call = spawns[0]
  check(call && !call.elevated, '用户级切换不提权（不弹 UAC）')
  check(call && call.cmdline < WIN_CMDLINE_LIMIT, '命令行未超 32767', (call ? call.cmdline : 0) + ' 字符')

  const script = call && call.scriptFile ? readScript(call.scriptFile) : null
  check(!!script && script.hasBom, '临时 .ps1 带 UTF-8 BOM（否则中文乱码）')
  check(!!script && script.text.indexOf("$ops    = @('setJavaHome')") >= 0, '只写 JAVA_HOME，不把系统级修复捆进切换')
  check(
    !!script && script.text.indexOf('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment') >= 0,
    '机器作用域的注册表键写对了（HKLM 的键不在 HKLM\\Environment）'
  )
  check(!!script && script.text.indexOf('Get-MergedPathText') >= 0, '脚本内含合并 PATH 推断逻辑')
}

/* ================================================================== *
 * 场景二：系统级切换（必须提权，且提权链路必须能被启动）
 * ================================================================== */
console.log('')
console.log('===== 场景二：提权链路必须能被启动 =====')
{
  spawns.length = 0
  const { api } = loadPlugin('Machine')
  api.args.select({}, { _kind: 'jdk', _path: 'C:\\Program Files\\Java\\jdk-21', _label: 'JDK 21' }, () => {})

  const call = spawns[0]
  check(!!call && call.elevated, '系统级切换走提权')
  check(!!call && call.cmdline < WIN_CMDLINE_LIMIT, '提权命令行未超 32767', (call ? call.cmdline : 0) + ' 字符')
  check(!!call && /-Verb RunAs/.test(call.outer || ''), '外层脚本使用 Start-Process -Verb RunAs')
  check(!!call && /-File/.test(call.outer || ''), '外层脚本用 -File 拉起逻辑脚本（而非再套一层 base64）')
  check(
    !!call && (call.outer || '').length < 2000,
    '外层脚本保持短小，规模与逻辑脚本解耦',
    (call ? (call.outer || '').length : 0) + ' 字符'
  )
  check(!!call && /exit 1223/.test(call.outer || ''), '取消 UAC 时回传 1223 以便识别')

  const script = call && call.scriptFile ? readScript(call.scriptFile) : null
  check(
    !!script && script.text.indexOf("$ops    = @('fixPath:Machine', 'setJavaHome')") >= 0,
    '系统级切换同时修 PATH 与写 JAVA_HOME'
  )
  check(!!script && script.text.indexOf('RegistryValueKind]::ExpandString') >= 0, 'PATH 以 REG_EXPAND_SZ 写回')
}

/* ================================================================== *
 * 场景三：执行结果要看得见（这是"点了没反应"的直接解药）
 * ================================================================== */
console.log('')
console.log('===== 场景三：执行结果显示在列表里 =====')
{
  spawns.length = 0
  const { api, utools } = loadPlugin('User')

  let items = null
  const collect = (list) => {
    items = list
  }

  // execFileSync 被桩替换，不会产出结果文件 → 走"未取得执行结果"的失败分支
  api.args.select({}, { _kind: 'jdk', _path: 'C:\\Program Files\\Java\\jdk-21', _label: 'JDK 21' }, collect)

  check(!!utools.lastNotify, '发出了通知', utools.lastNotify)
  check(!utools.outPluginCalled, '失败时不急着退出插件，用户能读到结果')
  const resultItem =
    items && items.find((i) => i._kind === 'dismissResult')
  check(!!resultItem, '列表顶部出现"上次操作"结果条目', resultItem ? resultItem.title : '(无)')
  check(!!resultItem && resultItem._fix === true, '失败结果被标记为修复类（会红色高亮）')
  check(!!resultItem && /失败/.test(resultItem.title), '标题明确写出失败')

  // 回车关闭提示
  let after = null
  api.args.select({}, { _kind: 'dismissResult' }, (list) => {
    after = list
  })
  check(
    !!after && !after.some((i) => i._kind === 'dismissResult'),
    '回车可以关闭该提示'
  )
}

/* ================================================================== *
 * 清理
 * ================================================================== */
fs.unlinkSync = realUnlink
let removed = 0
for (const file of keptScripts) {
  try {
    fs.unlinkSync(file)
    removed++
  } catch (err) {
    /* 忽略 */
  }
}

console.log('')
console.log('已清理临时脚本 ' + removed + '/' + keptScripts.length + ' 个')
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项')
if (failed > 0) {
  console.log('FAIL')
  process.exit(1)
}
console.log('OK: 执行层约束全部满足。')
