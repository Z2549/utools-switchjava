const fs = require('fs');
// 这里是预加载列表的配置
window.exports = {
    "switch": {
        mode: "list",
        args: {
            // 用户进入时被调用
            enter: (action, callbackSetList) => {
                if (!utools.isWindows()) {
                    window.tools.showNotification('请在windows系统下使用')
                    window.utools.outPlugin()
                }
                // 这里可以进行列表的设置
                callbackSetList([
                    {
                        title: '8',
                        description: '切换到java 8',
                        icon: '',
                    },
                    {
                        title: '11',
                        description: '切换到java 11',
                        icon: ''
                    },
                    {
                        title: '17',
                        description: '切换到java 17',
                        icon: ''
                    },
                    {
                        title: '18',
                        description: '切换到java 18',
                        icon: ''
                    }
                ])
            },
            // 用户搜索时被调用
            search: (acton, searchWord, callbackSetList) => {
                decPath = utools.getPath('userData')
                if (!fs.existsSync(decPath + '\\switchjava')) {
                    fs.mkdirSync(decPath + '\\switchjava')
                }
                if(searchWord.title=='8'){
                    window.utools.hideMainWindow()
                        fs.writeFileSync(decPath+'\\switchjava\\j8.vbs','Set WshShell = WScript.CreateObject("WScript.Shell") \r\nIf WScript.Arguments.Length = 0 Then \r\nSet ObjShell = CreateObject("Shell.Application") \r\nObjShell.ShellExecute "wscript.exe" _ \r\n, """" & WScript.ScriptFullName & """ RunAsAdministrator", , "runas", 1 \r\nWScript.Quit \r\nEnd if \r\nSet pSysEnv = CreateObject("WScript.Shell").Environment("System")\r\npSysEnv("%JAVA_HOME%")="%JAVA8_HOME%" \r\nMsgBox "已切换至java8",,"SwitchJava"')
                    utools.shellOpenPath(decPath+'\\switchjava\\j8.vbs')
                } 
                if(searchWord.title=='11'){
                    window.utools.hideMainWindow()
                    fs.writeFileSync(decPath+'\\switchjava\\j11.vbs','Set WshShell = WScript.CreateObject("WScript.Shell") \r\nIf WScript.Arguments.Length = 0 Then \r\nSet ObjShell = CreateObject("Shell.Application") \r\nObjShell.ShellExecute "wscript.exe" _ \r\n, """" & WScript.ScriptFullName & """ RunAsAdministrator", , "runas", 1 \r\nWScript.Quit \r\nEnd if \r\nSet pSysEnv = CreateObject("WScript.Shell").Environment("System")\r\npSysEnv("%JAVA_HOME%")="%JAVA11_HOME%" \r\nMsgBox "已切换至java11",,"SwitchJava"')
                    utools.shellOpenPath(decPath+'\\switchjava\\j11.vbs')
                }
                if(searchWord.title=='17'){
                    window.utools.hideMainWindow()
                    fs.writeFileSync(decPath+'\\switchjava\\j17.vbs','Set WshShell = WScript.CreateObject("WScript.Shell") \r\nIf WScript.Arguments.Length = 0 Then \r\nSet ObjShell = CreateObject("Shell.Application") \r\nObjShell.ShellExecute "wscript.exe" _ \r\n, """" & WScript.ScriptFullName & """ RunAsAdministrator", , "runas", 1 \r\nWScript.Quit \r\nEnd if \r\nSet pSysEnv = CreateObject("WScript.Shell").Environment("System")\r\npSysEnv("%JAVA_HOME%")="%JAVA17_HOME%" \r\nMsgBox "已切换至java17",,"SwitchJava"')
                    utools.shellOpenPath(decPath+'\\switchjava\\j17.vbs')
                }
                if(searchWord.title=='18'){
                    window.utools.hideMainWindow()
                    fs.writeFileSync(decPath+'\\switchjava\\j18.vbs','Set WshShell = WScript.CreateObject("WScript.Shell") \r\nIf WScript.Arguments.Length = 0 Then \r\nSet ObjShell = CreateObject("Shell.Application") \r\nObjShell.ShellExecute "wscript.exe" _ \r\n, """" & WScript.ScriptFullName & """ RunAsAdministrator", , "runas", 1 \r\nWScript.Quit \r\nEnd if \r\nSet pSysEnv = CreateObject("WScript.Shell").Environment("System")\r\npSysEnv("%JAVA_HOME%")="%JAVA18_HOME%" \r\nMsgBox "已切换至java18",,"SwitchJava"')
                    utools.shellOpenPath(decPath+'\\switchjava\\j18.vbs')
                }
                window.utools.outPlugin()
            },
            select: (action,itemData,callbackSetList) => {
                decPath = utools.getPath('userData')
                if (!fs.existsSync(decPath + '\\switchjava')) {
                    fs.mkdirSync(decPath + '\\switchjava')
                }
                if(itemData.title=='8'){
                    window.utools.hideMainWindow()
                        fs.writeFileSync(decPath+'\\switchjava\\j8.vbs','Set WshShell = WScript.CreateObject("WScript.Shell") \r\nIf WScript.Arguments.Length = 0 Then \r\nSet ObjShell = CreateObject("Shell.Application") \r\nObjShell.ShellExecute "wscript.exe" _ \r\n, """" & WScript.ScriptFullName & """ RunAsAdministrator", , "runas", 1 \r\nWScript.Quit \r\nEnd if \r\nSet pSysEnv = CreateObject("WScript.Shell").Environment("System")\r\npSysEnv("%JAVA_HOME%")="%JAVA8_HOME%" \r\nMsgBox "已切换至java8",,"SwitchJava"')
                    utools.shellOpenPath(decPath+'\\switchjava\\j8.vbs')
                } 
                if(itemData.title=='11'){
                    window.utools.hideMainWindow()
                    fs.writeFileSync(decPath+'\\switchjava\\j11.vbs','Set WshShell = WScript.CreateObject("WScript.Shell") \r\nIf WScript.Arguments.Length = 0 Then \r\nSet ObjShell = CreateObject("Shell.Application") \r\nObjShell.ShellExecute "wscript.exe" _ \r\n, """" & WScript.ScriptFullName & """ RunAsAdministrator", , "runas", 1 \r\nWScript.Quit \r\nEnd if \r\nSet pSysEnv = CreateObject("WScript.Shell").Environment("System")\r\npSysEnv("%JAVA_HOME%")="%JAVA11_HOME%" \r\nMsgBox "已切换至java11",,"SwitchJava"')
                    utools.shellOpenPath(decPath+'\\switchjava\\j11.vbs')
                }
                if(itemData.title=='17'){
                    window.utools.hideMainWindow()
                    fs.writeFileSync(decPath+'\\switchjava\\j17.vbs','Set WshShell = WScript.CreateObject("WScript.Shell") \r\nIf WScript.Arguments.Length = 0 Then \r\nSet ObjShell = CreateObject("Shell.Application") \r\nObjShell.ShellExecute "wscript.exe" _ \r\n, """" & WScript.ScriptFullName & """ RunAsAdministrator", , "runas", 1 \r\nWScript.Quit \r\nEnd if \r\nSet pSysEnv = CreateObject("WScript.Shell").Environment("System")\r\npSysEnv("%JAVA_HOME%")="%JAVA17_HOME%" \r\nMsgBox "已切换至java17",,"SwitchJava"')
                    utools.shellOpenPath(decPath+'\\switchjava\\j17.vbs')
                }
                if(itemData.title=='18'){
                    window.utools.hideMainWindow()
                    fs.writeFileSync(decPath+'\\switchjava\\j18.vbs','Set WshShell = WScript.CreateObject("WScript.Shell") \r\nIf WScript.Arguments.Length = 0 Then \r\nSet ObjShell = CreateObject("Shell.Application") \r\nObjShell.ShellExecute "wscript.exe" _ \r\n, """" & WScript.ScriptFullName & """ RunAsAdministrator", , "runas", 1 \r\nWScript.Quit \r\nEnd if \r\nSet pSysEnv = CreateObject("WScript.Shell").Environment("System")\r\npSysEnv("%JAVA_HOME%")="%JAVA18_HOME%" \r\nMsgBox "已切换至java18",,"SwitchJava"')
                    utools.shellOpenPath(decPath+'\\switchjava\\j18.vbs')
                }
                window.utools.outPlugin()
            },
            placeholder: "选择或输入版本数字"
        }
    }
}