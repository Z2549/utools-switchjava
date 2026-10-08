/**
 * 本地自检脚本：不需要安装 uTools 即可验证 preload.js 的核心逻辑。
 *
 * 用法：node test/local-check.js
 *
 * 原理：mock 掉全局 utools 对象与 window.utools，然后加载 preload.js，
 * 手动触发 window.exports 中的 enter / search 回调，打印生成的列表。
 */
'use strict'

const os = require('os')
const path = require('path')

const store = new Map()

global.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  },
  showNotification: (message) => console.log('[notification]', message),
  showOpenDialog: () => undefined,
}

global.window = {
  utools: {
    hideMainWindow: () => {},
    outPlugin: () => {},
  },
}

require(path.join(__dirname, '..', 'preload.js'))

const api = global.window.exports

function render(keyword) {
  let items = null
  const collect = (list) => {
    items = list
  }

  api.switch.args.enter({}, collect)
  if (keyword !== undefined) {
    api.switch.args.search({}, keyword, collect)
  }

  const title = keyword === undefined ? 'enter（无关键词）' : 'search("' + keyword + '")'
  console.log('\n===== ' + title + ' =====')
  for (const item of items) {
    console.log('  [' + item._kind + '] ' + item.title)
    console.log('        ' + item.description)
  }
  return items
}

if (!api || api.switch.mode !== 'list') {
  console.error('FAIL: preload.js 未正确导出列表模式')
  process.exit(1)
}

const all = render()
const jdks = all.filter((item) => item._kind === 'jdk')

console.log('\n共识别到 ' + jdks.length + ' 个 JDK：')
for (const jdk of jdks) {
  console.log('  - ' + jdk._path)
}

render('17')

if (jdks.length === 0) {
  console.error('\nFAIL: 未识别到任何 JDK。若本机确实没有安装 JDK，可忽略此提示。')
  process.exit(1)
}

console.log('\nOK: 扫描与列表生成正常。')
