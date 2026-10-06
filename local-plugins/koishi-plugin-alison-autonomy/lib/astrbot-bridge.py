# -*- coding: utf-8 -*-
"""
AstrBot 插件兼容桥（最小实现）

用法:
    python astrbot-bridge.py <plugin_dir> list
    python astrbot-bridge.py <plugin_dir> run <command> [args...]

原理:
    AstrBot 插件是 Python 包（metadata.yaml + main.py），通过装饰器
    @filter.command("xxx") 注册命令处理函数。这里用一个最小 shim 提供
    astrbot.api.* 的常用符号（logger / event / star / filter / message 组件），
    加载 main.py、收集注册的命令、构造一个假的 event 调用处理器，
    并把插件发出去的消息收集成 JSON 返回。

限制（v0.0.1，如实说明）:
    * 只支持"命令 → 文本回复"这一子集；依赖 AstrBot 完整运行时
      （上下文、会话持久化、LLM 调用、WebUI 配置）的插件无法工作。
    * 需要本机有 Python 3.9+。
"""
import importlib.util
import json
import os
import sys
import types
import traceback
from typing import Any, Dict, List


class _Logger:
    def __init__(self):
        self.lines: List[str] = []

    def _log(self, level, *args):
        self.lines.append("[%s] %s" % (level, " ".join(str(a) for a in args)))

    def info(self, *a): self._log("info", *a)
    def warning(self, *a): self._log("warn", *a)
    def warn(self, *a): self._log("warn", *a)
    def error(self, *a): self._log("error", *a)
    def debug(self, *a): self._log("debug", *a)
    def critical(self, *a): self._log("error", *a)


class _Message:
    """最小消息对象：记录文本，也支持 AstrBot 常见的链式写法。"""

    def __init__(self, text: str = ""):
        self.text = text or ""

    def message(self, text: str):
        self.text = (self.text + str(text)) if self.text else str(text)
        return self

    def __str__(self):
        return self.text

    @staticmethod
    def chain(*parts):
        return _Message("".join(str(p) for p in parts))


class _Event:
    def __init__(self, command: str, args: List[str]):
        self.command = command
        self.args = args
        self.outputs: List[str] = []
        self.message_str = " ".join([command] + args)
        self.unified_msg_origin = "ice:bridge"
        self.session_id = "ice:bridge"
        self.is_at = True
        # AstrBot 常见字段
        self.message_obj = types.SimpleNamespace(message_str=self.message_str,
                                                 self_id="ice", sender=types.SimpleNamespace(user_id="bridge", nickname="bridge"))

    # 插件常用的发消息接口
    def plain_result(self, text):
        self.outputs.append(str(text))
        return _Message(str(text))

    async def send(self, message=None):
        if message is not None:
            self.outputs.append(str(message))
        return None

    def make_result(self, message=None):
        return _Message(str(message) if message is not None else "")

    def __str__(self):
        return self.message_str


def _install_shim(plugin_dir: str) -> Dict[str, Any]:
    """把 astrbot.api.* 换成最小实现，返回收集容器。"""
    box: Dict[str, Any] = {"commands": {}, "logger": _Logger(), "errors": []}

    astrbot = types.ModuleType("astrbot")
    api = types.ModuleType("astrbot.api")

    # logger
    api.logger = box["logger"]

    # event / star
    event_mod = types.ModuleType("astrbot.api.event")
    star_mod = types.ModuleType("astrbot.api.star")

    class AstrBotConfig(dict):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)

    class Star:
        def __init__(self, context=None, config=None):
            self.context = context or types.SimpleNamespace()
            self.config = config or AstrBotConfig()

    def register(*_a, **_k):
        def deco(cls):
            return cls
        return deco

    star_mod.Star = Star
    star_mod.register = register
    star_mod.Context = type("Context", (), {})

    class Filter:
        def __init__(self):
            self.commands = box["commands"]
            self.regexes = []
            self.on_llm = []

        def command(self, name, *a, **k):
            def deco(fn):
                box["commands"][name] = fn
                return fn
            return deco

        def regex(self, pattern, *a, **k):
            def deco(fn):
                try:
                    import re as _re
                    self.regexes.append((_re.compile(pattern), fn))
                except Exception:
                    pass
                return fn
            return deco

        def llm_tool(self, *a, **k):
            def deco(fn):
                self.on_llm.append(fn)
                return fn
            return deco

        def event_message_type(self, *a, **k):
            def deco(fn):
                return fn
            return deco

        def platform_adapter_type(self, *a, **k):
            def deco(fn):
                return fn
            return deco

    event_mod.filter = Filter()
    event_mod.AstrMessageEvent = _Event
    event_mod.EventMessageType = type("EventMessageType", (), {"ALL": 0})

    api.event = event_mod
    api.star = star_mod

    # message 组件
    msg_mod = types.ModuleType("astrbot.api.message_components")
    for comp in ["Plain", "Image", "At", "Reply", "Face", "Record", "Video", "File"]:
        setattr(msg_mod, comp, type(comp, (), {"__init__": lambda self, *a, **k: None}))
    api.message_components = msg_mod

    # 常用工具
    api.AstrBotConfig = AstrBotConfig
    api.Persona = type("Persona", (), {})
    api.Provider = type("Provider", (), {})

    util_mod = types.ModuleType("astrbot.api.provider")
    util_mod.ProviderRequest = type("ProviderRequest", (), {"__init__": lambda self, *a, **k: None})
    api.provider = util_mod

    astrbot.api = api
    sys.modules["astrbot"] = astrbot
    sys.modules["astrbot.api"] = api
    sys.modules["astrbot.api.event"] = event_mod
    sys.modules["astrbot.api.star"] = star_mod
    sys.modules["astrbot.api.message_components"] = msg_mod
    sys.modules["astrbot.api.provider"] = util_mod
    return box


def _metadata(plugin_dir: str) -> Dict[str, Any]:
    meta: Dict[str, Any] = {}
    path = os.path.join(plugin_dir, "metadata.yaml")
    if not os.path.exists(path):
        return meta
    try:
        text = open(path, "r", encoding="utf-8", errors="replace").read()
    except Exception:
        return meta
    # 极简 YAML 解析：只取顶层 key: value
    for line in text.splitlines():
        if not line.strip() or line.startswith("#") or line.startswith(" "):
            continue
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip().strip('"').strip("'")
    return meta


def _load(plugin_dir: str):
    box = _install_shim(plugin_dir)
    main_py = os.path.join(plugin_dir, "main.py")
    if not os.path.exists(main_py):
        raise RuntimeError("插件目录里没有 main.py")
    spec = importlib.util.spec_from_file_location("astrbot_plugin_under_test", main_py)
    mod = importlib.util.module_from_spec(spec)
    cwd = os.getcwd()
    os.chdir(plugin_dir)  # 有些插件用相对路径读自己的资源
    try:
        spec.loader.exec_module(mod)
    except Exception as e:
        box["errors"].append("加载 main.py 失败: %s" % e)
        box["errors"].append(traceback.format_exc()[-800:])
    finally:
        os.chdir(cwd)
    # 兼容 filter 写在模块级或类属性上的写法
    return box, mod


def cmd_list(plugin_dir: str):
    meta = _metadata(plugin_dir)
    box, _ = _load(plugin_dir)
    return {
        "ok": True,
        "dir": plugin_dir,
        "metadata": meta,
        "commands": sorted(box["commands"].keys()),
        "regexes": len(box["regexes"] if False else []) ,
        "llm_tools": len(box["commands"]) and 0 or 0,
        "log": box["logger"].lines[-40:],
        "errors": box["errors"],
    }


def cmd_run(plugin_dir: str, command: str, args: List[str]):
    box, _ = _load(plugin_dir)
    fn = box["commands"].get(command)
    if fn is None:
        # 前缀匹配，便于 "帮助" 命中 "帮助xxx"
        for name, f in box["commands"].items():
            if name.startswith(command) or command.startswith(name):
                fn = f
                break
    if fn is None:
        return {"ok": False, "error": "插件没有注册命令 %s（可用：%s）" % (command, ", ".join(sorted(box["commands"])) or "无"),
                "log": box["logger"].lines[-40:], "errors": box["errors"]}

    event = _Event(command, args)
    last_error = None
    for call in (
        lambda: fn(event),
        lambda: fn(event, AstrBotConfig()),
        lambda: fn(_FakeStar(), event),
    ):
        try:
            result = call()
            if hasattr(result, "__await__"):
                import asyncio
                result = asyncio.get_event_loop().run_until_complete(result)
            if result is not None:
                event.outputs.append(str(result))
            break
        except TypeError as e:
            last_error = e
            continue
        except Exception as e:
            last_error = e
            box["errors"].append(traceback.format_exc()[-800:])
            break

    return {
        "ok": len(event.outputs) > 0,
        "command": command,
        "outputs": event.outputs,
        "error": None if event.outputs else (str(last_error) if last_error else "插件没有产生输出"),
        "log": box["logger"].lines[-40:],
        "errors": box["errors"],
    }


class _FakeStar:
    def __init__(self):
        self.context = types.SimpleNamespace()
        self.config = {}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "用法: astrbot-bridge.py <plugin_dir> list|run ..."}))
        return
    plugin_dir = os.path.abspath(sys.argv[1])
    action = sys.argv[2]
    try:
        if action == "list":
            out = cmd_list(plugin_dir)
        elif action == "run":
            out = cmd_run(plugin_dir, sys.argv[3] if len(sys.argv) > 3 else "", sys.argv[4:])
        else:
            out = {"ok": False, "error": "未知动作 " + action}
    except Exception as e:
        out = {"ok": False, "error": str(e), "trace": traceback.format_exc()[-1000:]}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
