/**
 * 列表高亮自检（确定性场景版）
 *
 * 在真实 DOM（jsdom）中复刻 uTools 客户端的列表结构，验证：
 *   1. 「修复类」条目会被打上 switchjava-fix 标记类，普通条目不会；
 *   2. React 重写 className 后标记能被 MutationObserver 补回；
 *   3. title / description 是纯文本渲染（这就是不能用内嵌 HTML 变色的原因）；
 *   4. 跨作用域 JAVA_HOME 冲突的判定方向正确（用户级覆盖系统级）。
 *
 * 用法：
 *   npm i -D jsdom      # 或设置 NODE_PATH 指向已装 jsdom 的目录
 *   node test/list-style-check.js
 *
 * 为了让断言与「本机恰好装了什么」无关，脚本把 child_process.execFileSync
 * 换成了桩：reg.exe 的查询结果由脚本自己构造，环境变量状态完全可控。
 * 其余代码路径（扫描、列表生成、样式注入、DOM 标记）都是 preload.js 的真实实现。
 *
 * DOM 结构与类名取自 uTools 7.8.0 客户端 resources/app.asar 的列表组件源码。
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

let JSDOM
try {
  JSDOM = require('jsdom').JSDOM
} catch (err) {
  console.log('SKIP: 未找到 jsdom，跳过列表高亮检查。')
  console.log('      安装后重跑：npm i -D jsdom（或设置 NODE_PATH）')
  process.exit(0)
}

const failures = []
function check(ok, label, detail) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail ? '  —— ' + detail : ''))
  if (!ok) failures.push(label)
}
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ---------------- 1. 准备一个可控的「注册表」 ---------------- */

// 一个确实含有 java.exe 的目录，用来制造「PATH 里存在抢占项」的情形
const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchjava-test-'))
const fakeJavaDir = path.join(fakeRoot, 'fake-oracle-javapath')
fs.mkdirSync(fakeJavaDir)
fs.writeFileSync(path.join(fakeJavaDir, 'java.exe'), '')

const ENV = {
  userJavaHome: null,
  machineJavaHome: null,
  userPath: '',
  machinePath: '',
}

const REG_HEADER_MACHINE = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const REG_HEADER_USER = 'HKEY_CURRENT_USER\\Environment'

const realExecFileSync = cp.execFileSync
cp.execFileSync = function (file, args) {
  const key = String((args && args[1]) || '')
  const name = String((args && args[3]) || '')
  const isMachine = /^HKLM/i.test(key)
  const isUser = /^HKCU/i.test(key)
  const lines = []

  // 递归查询（/s）在桩里一律返回空，避免把本机真实 JDK 卷进来
  if (args && args.indexOf('/s') >= 0) {
    return Buffer.from(isMachine ? REG_HEADER_MACHINE : REG_HEADER_USER, 'utf8')
  }

  if (isMachine || isUser) {
    lines.push(isMachine ? REG_HEADER_MACHINE : REG_HEADER_USER)
    if (name === 'JAVA_HOME') {
      const value = isMachine ? ENV.machineJavaHome : ENV.userJavaHome
      if (value) lines.push('    JAVA_HOME    REG_SZ    ' + value)
    } else if (name.toLowerCase() === 'path') {
      const value = isMachine ? ENV.machinePath : ENV.userPath
      if (value) lines.push('    Path    REG_EXPAND_SZ    ' + value)
    }
  }
  return Buffer.from(lines.join('\r\n'), 'utf8')
}
void realExecFileSync

/* ---------------- 2. 组装 uTools + 浏览器环境 ---------------- */

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
})
const win = dom.window
const doc = win.document

/** 复刻客户端 React 组件的输出 */
function renderList(items) {
  const root = doc.getElementById('root')
  root.innerHTML = ''
  const list = doc.createElement('div')
  list.className = 'list'
  for (const item of items) {
    const row = doc.createElement('div')
    row.className = 'list-item'

    if (item.icon) {
      const iconCell = doc.createElement('div')
      iconCell.className = 'list-item-icon'
      const img = doc.createElement('img')
      img.setAttribute('src', item.icon)
      img.setAttribute('alt', '')
      iconCell.appendChild(img)
      row.appendChild(iconCell)
    }

    const content = doc.createElement('div')
    content.className = 'list-item-content'
    const title = doc.createElement('div')
    title.className = 'list-item-title'
    title.textContent = String(item.title)
    const desc = doc.createElement('div')
    desc.className = 'list-item-description'
    desc.textContent = String(item.description)
    content.appendChild(title)
    content.appendChild(desc)
    row.appendChild(content)

    list.appendChild(row)
  }
  root.appendChild(list)
}

/** 模拟 React 重渲染：重写 className，会抹掉插件后加的标记类 */
function reactRerender(selectedIndex) {
  const rows = doc.querySelectorAll('.list-item')
  for (let i = 0; i < rows.length; i++) {
    rows[i].className = i === (selectedIndex || 0) ? 'list-item list-item-selected' : 'list-item'
  }
}

const store = new Map()
let pluginOutHandler = null

global.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  },
  showNotification: () => {},
  showOpenDialog: () => undefined,
  onPluginOut: (cb) => {
    pluginOutHandler = cb
  },
}

global.window = win
global.document = doc
global.MutationObserver = win.MutationObserver
global.requestAnimationFrame = win.requestAnimationFrame.bind(win)
win.utools = { hideMainWindow: () => {}, outPlugin: () => {} }

/* ---------------- 3. 加载真实实现 ---------------- */

require(path.join(__dirname, '..', 'preload.js'))
const api = win.exports
const FIX_CLASS = 'switchjava-fix'

let items = []
const collect = (list) => {
  items = list
  renderList(list)
}

function fixTitlesInDom() {
  return Array.from(doc.querySelectorAll('.list .list-item.' + FIX_CLASS))
    .map((row) => row.querySelector('.list-item-title').textContent)
}

function assertMarks(stage) {
  const rows = Array.from(doc.querySelectorAll('.list .list-item'))
  const expected = items.filter((item) => item._fix).map((item) => item.title)
  const actual = fixTitlesInDom()

  console.log('\n----- ' + stage + ' -----')
  items.forEach((item, index) => {
    console.log('  ' + (item._fix ? '🟥' : '  ') + ' [' + item._kind + '] ' + item.title)
    if (!rows[index]) console.log('       (无对应 DOM 节点)')
  })

  const markOk = items.every((item, index) => {
    const row = rows[index]
    return !row || row.classList.contains(FIX_CLASS) === !!item._fix
  })
  check(markOk, '标记与 _fix 标志一一对应')
  check(
    actual.length === expected.length && expected.every((title) => actual.indexOf(title) >= 0),
    '高亮条目集合与预期一致',
    actual.length + ' 条：' + (actual.join('｜') || '（无）')
  )
  return expected
}

async function main() {
  console.log('===== 场景 A：写入范围 = 用户级 =====')
  console.log('用户级 PATH 缺少 %JAVA_HOME%\\bin，且存在一个会抢先的 java 目录；系统级另有 JAVA_HOME')

  ENV.userJavaHome = null
  ENV.machineJavaHome = 'C:\\fake\\jdk-17-machine'
  ENV.machinePath = '%JAVA_HOME%\\bin;C:\\Windows\\system32'
  ENV.userPath = fakeJavaDir + ';C:\\Windows\\system32'

  api.switch.args.enter({}, collect)
  await tick(260)

  const aExpected = assertMarks('场景 A 列表')
  check(aExpected.length > 0, '场景 A 出现了修复类条目（PATH 需要修复）', String(aExpected.length))
  check(
    items.some((item) => item._kind === 'fixPath' && item._fix),
    '「修复 PATH」被标记为修复类'
  )
  check(
    !items.some((item) => item._kind === 'cleanConflict'),
    '写用户级时不报「系统级会覆盖」的假警（用户级优先级更高）'
  )

  const styleTag = doc.getElementById('switchjava-fix-style')
  check(!!styleTag, '样式已注入 document.head')
  check(
    !!styleTag && styleTag.textContent.indexOf('.' + FIX_CLASS + ' .list-item-title') >= 0,
    '样式包含标题红色规则'
  )
  check(doc.querySelectorAll('#switchjava-fix-style').length === 1, '样式只注入一次')

  /* React 重渲染后能否补回 */
  reactRerender(1)
  const wiped = fixTitlesInDom().length
  await tick(260)
  const restored = fixTitlesInDom().length
  check(wiped === 0, '（预期）React 重写 className 会抹掉标记', String(wiped))
  check(restored === aExpected.length, 'MutationObserver 已把标记补回', wiped + ' → ' + restored)

  /* 关键词过滤后不残留 */
  api.switch.args.search({}, 'zzz-不会匹配任何条目', collect)
  await tick(260)
  check(
    doc.querySelectorAll('.list .list-item.' + FIX_CLASS).length === 0,
    '列表切换后不残留旧标记'
  )

  /* ---------------- 场景 B：切到系统级写入 ---------------- */
  console.log('\n===== 场景 B：写入范围 = 系统级，且用户级另有 JAVA_HOME =====')

  ENV.userJavaHome = 'C:\\fake\\jdk-8-user'
  store.set('switchjava/scope', 'Machine')

  // 快照有 60 秒缓存，这里用插件自身的「重新扫描」动作把它失效掉；
  // 再用空关键词清掉上一场景留下的筛选词。
  api.switch.args.select({}, { _kind: 'rescan' }, collect)
  await tick(120)
  api.switch.args.search({}, '', collect)
  await tick(260)

  assertMarks('场景 B 列表')
  check(
    items.some((item) => item._kind === 'cleanConflict' && item._fix),
    '写系统级且用户级有值时，报出「用户级会覆盖」并标记为修复类'
  )
  check(
    items.some((item) => item._kind === 'cleanConflict' && item.description.indexOf('用户级') >= 0),
    '冲突提示的方向正确（说明是用户级覆盖系统级）'
  )

  /* ---------------- 纯文本渲染验证 ---------------- */
  console.log('\n===== 纯文本渲染验证 =====')
  const htmlTitle = '⚠ <span style="color:red">修复 PATH</span>'
  renderList([{ title: htmlTitle, description: 'x', _fix: true }])
  const probe = doc.querySelector('.list-item-title')
  check(probe.textContent === htmlTitle, 'title 内嵌 HTML 会被原样显示', 'textContent 未被解析')
  check(probe.children.length === 0, 'title 内不会生成元素节点')

  /* ---------------- 离开插件撤销标记 ---------------- */
  console.log('\n===== 离开插件 =====')
  api.switch.args.enter({}, collect)
  await tick(260)
  const beforeOut = fixTitlesInDom().length
  if (typeof pluginOutHandler === 'function') {
    pluginOutHandler(false)
    await tick(60)
    check(beforeOut > 0 && fixTitlesInDom().length === 0, 'onPluginOut 撤销全部标记', beforeOut + ' → 0')
  } else {
    console.log('  ! 未注册 onPluginOut，跳过')
  }

  console.log('')
  if (failures.length === 0) {
    console.log('OK: 修复类条目的红色标识逻辑全部通过。')
    process.exit(0)
  }
  console.error('FAIL: ' + failures.length + ' 项未通过：' + failures.join('；'))
  process.exit(1)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => {
    cp.execFileSync = realExecFileSync
    try {
      fs.rmSync(fakeRoot, { recursive: true, force: true })
    } catch (err) {
      /* 临时目录清理失败可忽略 */
    }
  })
