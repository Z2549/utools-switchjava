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
- **自动修复 PATH**：确保 `%JAVA_HOME%\bin` 位于 PATH **最前**，避免被 Oracle 的 `javapath` 抢先（详见下文）。
- **诊断项**（按需出现）：PATH 缺失条目、被其他 java 目录抢先、两个作用域中互相冲突的 `JAVA_HOME`、当前 `JAVA_HOME` 是无效的间接引用。
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
✓ JDK 21.0.6                    Oracle · C:\Program Files\Java\jdk-21 · 当前 JAVA_HOME
  JDK 17.0.3.1                  Oracle · C:\Program Files\Java\jdk-17.0.3.1
  ⚙ 写入范围：用户级             点击切换为「系统级」：需 UAC，对全部用户生效
  ＋ 手动添加 JDK 目录            扫描不到时手动指定 JDK 根目录
  ⟳ 重新扫描本机 JDK             忽略缓存立即重新扫描
  ☑ 切换时自动修复 PATH          确保 %JAVA_HOME%\bin 位于 PATH 最前
```

选中某个版本后按回车即可完成切换。子输入框中可输入版本号或厂商名进行筛选。

## 关于 PATH 与 Oracle javapath

这是原版本最容易踩的坑：即使 `JAVA_HOME` 已正确切换，`java -version` 仍可能显示旧版本。

原因是 Oracle 安装器会在 PATH 中写入 `C:\Program Files\Common Files\Oracle\Java\javapath`，该目录下的 `java.exe` 是一个**启动器**，它读取注册表里「最后一次安装的 JRE」来决定运行哪个 Java，**完全不看 `JAVA_HOME`**。只要它排在 `%JAVA_HOME%\bin` 之前，就会被优先命中。

因此本插件在切换时会（可在列表中关闭）：

1. 读取 PATH 的**原始未展开值**（避免 PowerShell 展开 `%VAR%` 导致 PATH 被写坏）；
2. 若 `%JAVA_HOME%\bin` 不存在，则把它**插到最前**；
3. 以 `REG_EXPAND_SZ` 类型写回，保证 `%JAVA_HOME%` 能被系统展开。

该操作是幂等的：重复执行不会改变已有内容，也不会移除 PATH 中的其他条目。

## 为什么环境变量写完要重开终端

Windows 的进程环境块是进程启动时复制的一份快照。修改注册表后，**已经运行**的终端 / IDE / 编辑器不会自动更新，需要重启这些程序；新启动的进程才会读到新值。

插件在写入后会广播环境变更通知，`explorer.exe` 重新读取后，从桌面 / 开始菜单新启动的程序通常能立即拿到新值。

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
node test/local-check.js
```

该脚本会 mock 掉 `utools` 对象，直接调起 `enter` / `search` 回调并打印生成的列表，用于确认 JDK 扫描与过滤是否正常。

## 已知限制

- 仅支持 Windows（`plugin.json` 已声明 `platform: ["win32"]`，运行时也会二次校验）。
- 写入系统级环境变量必须获得管理员权限；取消 UAC 会得到明确提示，不会静默失败。
- 若系统级与用户级同时存在 `JAVA_HOME`，用户级的优先级更高。列表中的「⚠ 清理冲突的 JAVA_HOME」可用于消除歧义。
- `description.png` 为 v1 时期的手工配置说明图，与 v2 无关，保留仅作历史记录。

## License

见 [LICENSE](./LICENSE)。
