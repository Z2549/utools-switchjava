# utools-switchjava

在 uTools 中一键切换 Windows 的 `JAVA_HOME` 环境变量。

> **v2.0.0 为完全重写版本。** 不再需要预先手工配置 `JAVA8_HOME` / `JAVA11_HOME` 之类的中间变量，插件会自行扫描本机已安装的 JDK。

---

## 功能

- **自动识别本机 JDK**，数据来源按优先级合并去重：
  1. 手动添加过的目录（会被记住）
  2. 常见厂商安装目录：`Program Files\Java`、`Eclipse Adoptium`、`Microsoft`、`Zulu`、`Amazon Corretto`、`BellSoft`、`Semeru`、`SapMachine`、`JetBrains` 等，覆盖所有盘符，以及 `~/.jdks`、`%LOCALAPPDATA%\Programs\...`
  3. 注册表 `HKLM\SOFTWARE\JavaSoft\JDK\<版本>\JavaHome`（安装器写入的权威记录）
  4. 已存在的 `JAVA*_HOME` 环境变量
  5. `PATH` 中形如 `xxx\bin` 的条目反推
- **版本信息来自 JDK 自带的 `release` 文件**，不启动 `java` 进程，速度快且无副作用。
- 列表展示版本 / 厂商 / 路径，当前生效的一项打勾并标注。
- 支持搜索过滤：输入 `17`、`oracle`、`adoptium` 或路径片段均可。
- **写入范围可选**：
  - 用户级（默认）：免管理员，只对当前用户生效，改完立即可用；
  - 系统级：弹一次 UAC，对全部用户生效。
- **自动修复 PATH**：判断哪个作用域在真正卡住你，把 `%JAVA_HOME%\bin` 前置到**那个作用域**的最前面（可能是**系统** PATH，此时弹一次 UAC），避免被 Oracle 的 `javapath` 抢先（详见下文）。
- **诊断项**（按需出现）：PATH 被其他 java 目录抢先（含在**另一个作用域**里抢先的情形）、PATH 缺少 `%JAVA_HOME%\bin`、两个作用域中互相冲突的 `JAVA_HOME`、当前 `JAVA_HOME` 是无效的间接引用。
- **写入后自检**：每次写入都「写 → 回读比对 → 实跑一次 `java -version`」，把真实版本号写进通知，不再有「不知道到底成没成功」。
- **修复类条目红色高亮**：凡是「点一下就能修好」的诊断项，标题与说明会显示为红色并带左侧红条，与普通选项一眼区分（实现原理见下文）。
- 直接输入版本号即可切换：在 uTools 搜索框输入 `8` / `11` / `17` / `21` 等，选择「按版本号切换 Java」即完成，无需进入列表。

## 安装

**方式一（本地开发）**

1. 安装 [uTools](https://www.u-tools.cn/download/) 与 uTools 开发者工具；
2. 打开开发者工具 → 「选择 plugin.json」→ 指向本目录的 `plugin.json`；
3. 直接运行调试。

**方式二（打包安装）**

在开发者工具中打包为 `.upx`，双击安装。打包内容只需：`plugin.json`、`preload.js`、`logo.png`。

## 使用

在 uTools 搜索框输入 `switchjava`（也支持 `java` / `javahome` / `切换java`），进入列表：

```
✓ JDK 21.0.6                    Oracle · C:\Program Files\Java\jdk-21
  JDK 17.0.3.1                  Oracle · C:\Program Files\Java\jdk-17.0.3.1 · 当前 JAVA_HOME
  ⚙ 写入范围：用户级             点击切换为「系统级」：需 UAC，对全部用户生效
  ＋ 手动添加 JDK 目录            扫描不到时手动指定 JDK 根目录
  ⟳ 重新扫描本机 JDK             忽略缓存立即重新扫描
  ☑ 切换时自动修复 PATH          只在抢占确实存在时修复对应作用域
  ⚠ 修复 PATH 抢占（改系统级）     ← 修复类条目：红色标题 + 左侧红条
```

选中某个版本后按回车即可完成切换。子输入框中可输入版本号或厂商名进行筛选。

## 修复类条目的红色高亮是怎么实现的

先说结论：**不能在 `title` 里写 HTML 来变色。**

uTools 模板列表的 `title` / `description` 是按纯文本渲染的。uTools 7.8.0 客户端（`resources/app.asar` 内的列表组件）渲染代码为：

```js
createElement('div', { className: 'list-item' + (isSelected ? ' list-item-selected' : '') }, …)
createElement('div', { className: 'list-item-title' }, item.title)
createElement('div', { className: 'list-item-description' }, item.description)
```

`title` 是作为 React 的**文本子节点**插入的，标签会被转义；官方也没有开放 item 的样式字段。写 `<span style="color:red">` 只会把标签原样显示出来。

可行的做法是利用一个事实：**模板插件的 `preload` 与列表界面处于同一个渲染进程、同一个 DOM 中**（列表组件直接调用 `window.exports[code].args.enter / search`）。因此本插件：

1. 往 `document.head` 注入一段样式（`#switchjava-fix-style`，含深/浅色两套配色）；
2. 刷新列表后，给「修复类」条目的 `.list-item` 节点补上 `switchjava-fix` 类 —— 呈现**红色标题 + 红色说明 + 左侧红色竖条**，选中时底色也变红；
3. 列表节点由 React 管理，鼠标移动导致选中态变化时 React 会重写 `className` 抹掉这个类，所以用一个**幂等的 `MutationObserver`** 把标记补回来；
4. 离开插件时通过 `utools.onPluginOut` 撤销全部标记，不在其他插件的列表里残留样式。

全部只是配色：注入失败、DOM 拿不到、uTools 改了内部结构，都只影响颜色，不影响切换功能——条目标题仍保留 `⚠` 前缀作为兜底标识。

## 关于 PATH 与 Oracle javapath

这是原版本最容易踩的坑：即使 `JAVA_HOME` 已正确切换，`java -version` 仍可能显示旧版本。

原因是 Oracle 安装器会在 PATH 中写入 `C:\Program Files\Common Files\Oracle\Java\javapath`，该目录下的 `java.exe` 是一个**启动器**，它读取注册表里「最后一次安装的 JRE」来决定运行哪个 Java，**完全不看 `JAVA_HOME`**。只要它排在 `%JAVA_HOME%\bin` 之前，就会被优先命中。

因此本插件在切换时会（可在列表中关闭）：

1. 读取 PATH 的**原始未展开值**（避免 PowerShell 展开 `%VAR%` 导致 PATH 被写坏）；
2. 判断**哪个作用域在真正卡住你** —— 也就是哪个 PATH 里存在排在 `%JAVA_HOME%\bin` 之前、且自带 `java.exe` 的目录；
3. 把 `%JAVA_HOME%\bin` **插到那个作用域的最前面**（若在系统 PATH，会弹一次 UAC）；
4. 以 `REG_EXPAND_SZ` 类型写回，保证 `%JAVA_HOME%` 能被系统展开。

该操作是幂等的：重复执行不会改变已有内容，也不会移除 PATH 中的其他条目（`javapath` 只是被排到后面，不会被删掉）。

### 为什么修复目标必须看「系统 PATH」

Windows 合并 PATH 的顺序是 **系统 PATH 在前 + 用户 PATH 追加在后**。本机用 `CreateEnvironmentBlock` 取到的合并结果：

```
  [ 3] C:\Program Files\Common Files\Oracle\Java\javapath   ← 抢占项，在系统 PATH 里
  [11] C:\Program Files\Git\cmd                             ← 机器独有项
  [12] C:\Program Files\Java\jdk-17.0.3.1\bin               ← 用户 PATH 的 %JAVA_HOME%\bin 展开而来
  [13] C:\Program Files (x86)\pcsuite\                      ← 用户独有项
```

机器独有项（索引 11）排在用户独有项（索引 13）之前 —— 这就是「系统 PATH 在前」的直接证据。

所以当 `javapath` 位于**系统** PATH 时，只在**用户** PATH 里前置 `%JAVA_HOME%\bin` 是徒劳的；插件会把修复目标自动定为系统 PATH（这也解释了此前的「点了修复却没变化」，其根因还有一处：提权脚本误用了不存在的 `HKLM\Environment` 键，已修正为 `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`）。

修复一次之后就不用再管：系统 PATH 里的 `%JAVA_HOME%` 同样会用**合并后**的 JAVA_HOME 展开（用户级覆盖系统级），所以之后无论写用户级还是系统级，`java` 都会跟着变。

### 写入后如何确认

每次写入都会「写 → 回读比对 → 实跑一次 `java -version`」，结果直接显示在通知里，例如：

```
JAVA_HOME → JDK 21.0.6（用户级）；新进程实测 java -version → openjdk version "21.0.6" 2025-01-21 LTS
```

如果 `java -version` 仍与所选版本不符，通知里会带上实际命中的 `java.exe` 路径，便于定位。

## 为什么环境变量写完要重开终端

Windows 的进程环境块是进程启动时复制的一份快照。修改注册表后，**已经运行**的终端 / IDE / 编辑器不会自动更新。

插件在写入后会显式广播 `WM_SETTINGCHANGE`（`lParam = "Environment"`），让资源管理器等已运行的进程重新读取环境块。这一步是必要的：直接写注册表（.NET `RegistryKey.SetValue`、`[Environment]::SetEnvironmentVariable`）**不会**自动广播，只有 `setx.exe` 会。少了它，「新开的窗口仍是旧值」就会频频出现。

即便如此，**已经打开的终端窗口永远不会刷新**（它继承的是自己启动时的环境块），在旧终端里再敲 `cmd` 也只是继承同一个旧块。所以请**新开**一个终端窗口（从开始菜单 / 桌面 / 任务栏）。

或者直接看 uTools 通知末尾的 `java -version` 实测值 —— 插件是在**独立进程**里按最新注册表重新拼出合并 PATH 后再运行的，不依赖任何窗口刷新，因此它就是「新进程会看到什么」的权威答案。

## 从 v1 迁移

| | v1 | v2 |
|---|---|---|
| 前置条件 | 必须手工新建 `JAVA8_HOME` ~ `JAVA21_HOME` | 无需任何前置配置 |
| 支持的版本 | 固定 8 / 11 / 17 / 18 / 21 | 扫描到什么就支持什么 |
| `JAVA_HOME` 的值 | `%JAVA8_HOME%`（变量的变量） | JDK 真实绝对路径 |
| 临时文件 | 写在 uTools 程序目录 | 不产生持久文件 |
| 切换脚本 | 运行时生成 `.vbs` 并执行 | 直接由 PowerShell 完成 |

**关于 `%JAVA8_HOME%` 这种间接引用**：Windows 只在 `REG_EXPAND_SZ` 类型的值上做展开，而多数工具（IDEA、Maven、Gradle、各类构建脚本）直接读取 `JAVA_HOME` 的字符串，不会二次展开。因此 v1 写入的 `JAVA_HOME=%JAVA8_HOME%` 在这些工具眼中就是一个无效路径。v2 写入真实路径。插件也不会删除你原有的 `JAVAxx_HOME` 变量，只是把它们当作「JDK 位置提示」读取。

## 开发与自检

插件逻辑全部在 `preload.js`（CommonJS，无构建步骤、无依赖）。它遵循 uTools 的「模板插件应用」规范：`plugin.json` 不含 `main` 字段，通过 `window.exports` 声明列表模式与无 UI 模式。

不安装 uTools 也能验证核心逻辑：

```bash
node test/local-check.js        # 用本机真实环境跑一遍扫描与列表生成
node test/list-style-check.js   # 在 jsdom 里复刻客户端列表 DOM，验证红色高亮（需 jsdom）
```

`test/local-check.js` 会 mock 掉 `utools` 对象，直接调起 `enter` / `search` 回调并打印生成的列表，用于确认 JDK 扫描与过滤是否正常。

`test/list-style-check.js` 需要 `jsdom`（`npm i -D jsdom`，或设置 `NODE_PATH` 指向已安装目录）。它把 `reg.exe` 的查询结果替换成脚本自己构造的桩，因此环境变量场景完全可控，断言与本机装了什么无关。覆盖：标记与 `_fix` 标志一一对应、React 重写 `className` 后标记自动补回、列表切换不残留标记、`onPluginOut` 撤销标记、`title` 内嵌 HTML 不被解析、跨作用域冲突的判定方向、以及**修复目标是否落在真正抢先的那个作用域**（场景 A 即复刻「抢占项在系统 PATH」这一真实情形）。

## 已知限制

- 仅支持 Windows（`plugin.json` 已声明 `platform: ["win32"]`，运行时也会二次校验）。
- 写入系统级环境变量必须获得管理员权限；取消 UAC 会得到明确提示，不会静默失败。
- **`JAVA_HOME` 的作用域优先级**：它是普通变量，同名的**用户级变量会覆盖系统级变量**。所以「写系统级 + 用户级已有值」会让本次设置失效，插件会红字提示并支持一键清除；反过来「写用户级」是能盖住系统级的，不算冲突，不会报警。
- **PATH 是拼接而非覆盖，且系统 PATH 在前**：该顺序由插件自动识别，并把 `%JAVA_HOME%\bin` 前置到**真正卡住的那个作用域**（可能是系统 PATH，需 UAC）。列表里的红字项会写明修复目标。
- 修复只做「重排」，不会删除 `javapath` 等条目。若你想彻底移除它，请在「系统变量」里自行删除。
- 红色高亮依赖 uTools 列表组件的内部 DOM 结构（类名 `list-item` / `list-item-title`）。若未来版本改结构，最坏情况只是高亮失效，条目仍带有 `⚠` 前缀。
- `description.png` 为 v1 时期的手工配置说明图，与 v2 无关，保留仅作历史记录。

## License

见 [LICENSE](./LICENSE)。
