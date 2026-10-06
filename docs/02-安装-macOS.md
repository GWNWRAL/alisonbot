# 02 · 在 macOS 上安装 AlisonBot

本文覆盖 macOS 上的两种安装方式（发行包、源码运行）、启动与验证、卸载与排错。安装完成后请继续阅读 [03-首次部署与对话引导.md](03-首次部署与对话引导.md)。

## 一、选择安装包

按芯片架构选择：

| 机器 | 安装包 |
| --- | --- |
| Apple Silicon（M 系列） | `Alison-macOS-arm64-0.0.1.zip` |
| Intel | `Alison-macOS-x64-0.0.1.zip` |

不确定自己是哪种芯片时，可在「关于本机」中查看「芯片」或「处理器」一栏。

## 二、方式一：发行包安装

以 Apple Silicon 为例：

```bash
curl -L -o Alison-macOS-arm64-0.0.1.zip \
  https://github.com/GWNWRAL/alisonbot/releases/download/v0.0.1/Alison-macOS-arm64-0.0.1.zip
unzip Alison-macOS-arm64-0.0.1.zip -d Alison && cd Alison
chmod +x install-mac.sh "启动 Alison.command"
./install-mac.sh && ./"启动 Alison.command"
```

Intel 机器把第一行的文件名换成 `Alison-macOS-x64-0.0.1.zip` 即可：

```bash
curl -L -o Alison-macOS-x64-0.0.1.zip \
  https://github.com/GWNWRAL/alisonbot/releases/download/v0.0.1/Alison-macOS-x64-0.0.1.zip
unzip Alison-macOS-x64-0.0.1.zip -d Alison && cd Alison
chmod +x install-mac.sh "启动 Alison.command"
./install-mac.sh && ./"启动 Alison.command"
```

三步的含义：

1. `curl`：下载发行包；
2. `unzip`：解压到 `Alison/` 目录并进入；
3. `chmod +x`：赋予脚本与启动器可执行权限（从压缩包解压出来的文件默认没有执行位）；
4. `./install-mac.sh`：安装依赖与运行环境；
5. `./"启动 Alison.command"`：启动 Alison。

首次安装需要联网。安装完成后，日常启动只需要双击 `启动 Alison.command`。

## 三、方式二：源码运行

需要 Node.js **20 或更高版本**。

```bash
# 在仓库根目录执行
chmod +x install-mac.sh "启动 Alison.command"
./install-mac.sh
./"启动 Alison.command"
```

## 四、启动与验证

1. 打开浏览器，访问 <http://127.0.0.1:5140/alison>。
2. 看到聊天页面即表示网页平台插件已就绪。
3. 还没有 API Key 时，**Alison 会主动开口**引导你配置模型，流程见 [03-首次部署与对话引导.md](03-首次部署与对话引导.md)。

## 五、常见问题

**系统提示「无法验证开发者」或无法打开**
这是 macOS 对未公证应用的常见拦截。请按系统提示在「系统设置 → 隐私与安全性」中允许打开；具体文案随系统版本不同。若仍然无法打开，可在终端中直接运行 `./"启动 Alison.command"`，报错信息会显示在终端里。

**双击 `.command` 一闪而过**
`.command` 文件双击运行结束后窗口会关闭。要看清错误，请改为在终端里执行 `./"启动 Alison.command"`。

**提示权限不足 / 无法执行**
重新执行 `chmod +x install-mac.sh "启动 Alison.command"`。如果文件带有隔离属性，也可在确认文件来源可信后移除该属性。

**端口 5140 被占用**
在 `workspace/alison.yml` 中修改网页平台端口后重启服务，或直接在对话里让 Alison 帮你改。随后访问 `http://127.0.0.1:<新端口>/alison`。

**Apple Silicon 上运行了 x64 包**
会通过 Rosetta 运行，性能与兼容性都非最佳。请改用 `arm64` 包。

**Python 插件不生效**
确认本机已安装 **Python 3.9 或更高版本**，并且插件放在 `workspace/plugins/py/<框架>/<插件名>/` 下。该目录的含义见 [05-插件体系与多平台兼容.md](05-插件体系与多平台兼容.md)。

## 六、工作区与卸载

工作区目录（`workspace/`）保存配置、插件与数据：主配置是 `workspace/alison.yml`。修改后无需重启，热更新会进程内生效。

卸载方式：删除解压出来的 `Alison/` 目录，以及你另行指定的工作区目录。删除前请备份想保留的内容。
