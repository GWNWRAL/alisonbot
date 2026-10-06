# -*- coding: utf-8 -*-
"""
多框架 Python 插件兼容桥

支持把其它机器人平台的 Python 插件，以「命令 → 文本回复」的粒度接进 Alison：

    框架        entry 入口             元数据文件        说明
    astrbot     main.py                 metadata.yaml     命令装饰器 @filter.command
    nonebot2    __init__.py / main.py   -                 on_command / on_keyword / on_startswith …
    maibot      plugin.py / main.py     manifest.json     @Command / @Action / @Tool
    langbot     main.py                 manifest.yaml     组件式（需要 Plugin Runtime，本桥尽力而为）

用法：
    python pyplugin-bridge.py <framework> <plugin_dir> list
    python pyplugin-bridge.py <framework> <plugin_dir> run <command> [args...]
    python pyplugin-bridge.py <plugin_dir> list            # 兼容旧用法，按 astrbot 处理

设计：
    · 只精确实现"注册命令"这一层 API（各框架的装饰器/注册函数）
    · 其余 API 用**宽容桩**自动兜底：任何未实现的模块/属性/调用都返回可用对象并记录，
      插件因此能加载到注册阶段，而不是在 import 处直接炸掉
    · 记录插件实际用到的 API 名，返回给上层展示"兼容到什么程度"（used/unsupported）
"""

import asyncio
import importlib.util
import inspect
import json
import os
import sys
import traceback
import types
from typing import Any, Callable, Dict, List

MAX_LOGS = 60


def run_coro(coro):
    """跑一个协程：有运行中的 loop 就排进去，否则新建临时 loop（避免 get_event_loop 弃用告警）"""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        return asyncio.ensure_future(coro)
    new = asyncio.new_event_loop()
    try:
        return new.run_until_complete(coro)
    finally:
        try:
            new.close()
        except Exception:
            pass


def drain_generator(event: 'Event', gen) -> List[str]:
    """把生成器 / 异步生成器 yield 出来的消息收集起来（AstrBot、NoneBot 都常见）"""
    if isinstance(gen, types.AsyncGeneratorType):
        async def drain():
            out = []
            async for item in gen:
                if item is not None:
                    out.append(str(item))
            return out
        try:
            items = run_coro(drain())
        except Exception:
            # 不能悄悄吞掉：插件崩了要让调用方看见
            items = ['[桥接] 生成器执行出错：' + traceback.format_exc().strip().splitlines()[-1]]
    else:
        items = [str(x) for x in gen if x is not None]
    items = [i for i in items if i]
    event.outputs.extend(items)
    return items


def dedupe(items: List[str]) -> List[str]:
    """同一个回复常既被 plain_result 记录又被 yield 收一次，这里按顺序去重"""
    seen = set()
    out = []
    for i in items:
        if i in seen:
            continue
        seen.add(i)
        out.append(i)
    del items[:]
    items.extend(out)
    return items


# --------------------------------------------------------------------------- #
# 宽容桩：未实现的 API 一律返回"能用"的占位对象，并记录被访问的名字
# --------------------------------------------------------------------------- #
class MagicStub:
    def __init__(self, name: str, impl: Callable | None = None):
        self.__name__ = name
        self._impl = impl

    def __call__(self, *args, **kwargs):
        if self._impl is not None:
            return self._impl(*args, **kwargs)
        # 当装饰器用：@something(...)  → 返回的函数原样通过
        if len(args) == 1 and not kwargs and callable(args[0]):
            return args[0]
        return MagicStub(self.__name__)

    def __getattr__(self, item):
        if item.startswith('__'):
            raise AttributeError(item)
        return MagicStub(f'{self.__name__}.{item}')

    def __mro_entries__(self, bases):
        return (object,)

    def __repr__(self):
        return f'<stub {self.__name__}>'


class StubModule(types.ModuleType):
    def __init__(self, name: str, usage: List[str] | None = None):
        super().__init__(name)
        self.__dict__['_usage'] = usage if usage is not None else []
        self.__dict__['_impls'] = {}

    def define(self, attr: str, impl: Callable):
        """精确实现一个 API"""
        self.__dict__['_impls'][attr] = impl
        setattr(self, attr, impl)
        return impl

    def __getattr__(self, item):
        if item.startswith('__'):
            raise AttributeError(item)
        if item in self.__dict__['_impls']:
            return self.__dict__['_impls'][item]
        self.__dict__['_usage'].append(f'{self.__name__}.{item}')
        stub = MagicStub(f'{self.__name__}.{item}')
        setattr(self, item, stub)
        return stub


class Box:
    """插件与桥之间的共享状态"""

    def __init__(self, framework: str, plugin_dir: str):
        self.framework = framework
        self.plugin_dir = plugin_dir
        self.commands: Dict[str, Callable] = {}
        self.aliases: Dict[str, str] = {}
        self.logs: List[str] = []
        self.usage: List[str] = []
        self.errors: List[str] = []
        self.modules: Dict[str, StubModule] = {}
        self.classes: List[Any] = []

    def log(self, level: str, *parts):
        self.logs.append('[%s] %s' % (level, ' '.join(str(p) for p in parts)))
        if len(self.logs) > MAX_LOGS:
            del self.logs[0]

    def module(self, name: str) -> StubModule:
        mod = StubModule(name, self.usage)
        sys.modules[name] = mod
        self.modules[name] = mod
        # 让父包能拿到子模块
        if '.' in name:
            parent, child = name.rsplit('.', 1)
            pmod = sys.modules.get(parent)
            if pmod is not None:
                setattr(pmod, child, mod)
        return mod

    def register(self, name: str, fn: Callable, aliases=None):
        if not name:
            return fn
        self.commands[str(name)] = fn
        for a in aliases or []:
            self.aliases[str(a)] = str(name)
        return fn


class Message:
    """最小消息对象（AstrBot / NoneBot 都用得上）"""

    def __init__(self, text: str = '', segments=None):
        self.text = text or ''
        self.segments = segments or []

    def message(self, text):
        self.text = (self.text + str(text)) if self.text else str(text)
        return self

    def extract_plain_text(self):
        return self.text

    def __str__(self):
        return self.text

    @staticmethod
    def chain(*parts):
        return Message(''.join(str(p) for p in parts))


class Event:
    """最小事件对象：命令、参数、以及"插件发出来的消息"收集"""

    def __init__(self, command: str, args: List[str], framework: str):
        self.command = command
        self.args = args
        self.framework = framework
        self.outputs: List[str] = []
        self.message_str = ' '.join([command] + list(args))
        self.plain_text = ' '.join(args)
        self.unified_msg_origin = 'ice:bridge'
        self.session_id = 'ice:bridge'
        self.is_at = True
        self.message_obj = types.SimpleNamespace(
            message_str=self.message_str, self_id='ice',
            sender=types.SimpleNamespace(user_id='bridge', nickname='bridge'))
        self.get_user_id = lambda: 'bridge'
        self.get_session_id = lambda: 'ice:bridge'
        self.get_plaintext = lambda: self.plain_text
        self.get_message = lambda: Message(self.message_str)

    # AstrBot 事件上最常用的取值方法（缺了插件会 AttributeError）
    def get_sender_name(self):
        return 'bridge'

    def get_sender_id(self):
        return 'bridge'

    def get_group_id(self):
        return 'ice:bridge'

    def get_self_id(self):
        return 'ice'

    def get_platform_name(self):
        return 'alison-bridge'

    def get_message_str(self):
        return self.message_str

    def get_messages(self):
        return [Message(self.message_str)]

    # 常见发消息接口
    def plain_result(self, text):
        self.outputs.append(str(text))
        return Message(str(text))

    def make_result(self, message=None):
        return Message(str(message) if message is not None else '')

    async def send(self, message=None):
        if message is not None:
            self.outputs.append(str(message))

    async def finish(self, message=None):
        if message is not None:
            self.outputs.append(str(message))

    def __str__(self):
        return self.message_str


# --------------------------------------------------------------------------- #
# 各框架适配器
# --------------------------------------------------------------------------- #
def build_astrbot(box: Box):
    api = box.module('astrbot.api')
    event_mod = box.module('astrbot.api.event')
    star_mod = box.module('astrbot.api.star')
    box.module('astrbot.api.message_components')
    box.module('astrbot')

    class _Filter:
        def command(self, name, *a, **k):
            def deco(fn):
                box.register(name, fn)
                return fn
            return deco

        def command_group(self, *a, **k):
            return MagicStub('filter.command_group')

        def keyword(self, word, *a, **k):
            def deco(fn):
                box.register(word, fn)
                return fn
            return deco

        def regex(self, pattern, *a, **k):
            def deco(fn):
                box.register(str(pattern), fn)
                return fn
            return deco

        def __getattr__(self, item):
            return MagicStub(f'filter.{item}')

    event_mod.define('filter', _Filter())
    event_mod.define('AstrMessageEvent', Event)
    api.define('AstrBotConfig', dict)
    star_mod.define('Star', type('Star', (), {'__init__': lambda self, *a, **k: None}))
    star_mod.define('register', lambda *a, **k: (lambda cls: cls))
    return ['main.py']


def build_nonebot2(box: Box):
    nb = box.module('nonebot')
    adapters = box.module('nonebot.adapters')
    ob11 = box.module('nonebot.adapters.onebot.v11')
    params = box.module('nonebot.params')
    box.module('nonebot.rule')
    box.module('nonebot.plugin')
    box.module('nonebot.permission')
    box.module('nonebot.matcher')

    class Matcher:
        def __init__(self, kind, name):
            self.kind = kind
            self.name = name
            self.handlers = []
            self.state = {}
            self._event = None

        def handle(self, *a, **k):
            def deco(fn):
                self.handlers.append(fn)
                box.register(self.name, self._invoke)
                return fn
            return deco

        async def _invoke(self, event, *args, **kwargs):
            self._event = event
            for fn in self.handlers:
                # 处理器自己的参数要按签名注入（CommandArg / Message / event …）
                hargs, hkwargs = make_args(box, fn, event)
                res = fn(*hargs, **hkwargs)
                # 这里本身就在协程里，直接 await，别把 Task 当结果
                if inspect.isawaitable(res):
                    res = await res
                if isinstance(res, types.AsyncGeneratorType) or inspect.isgenerator(res):
                    drain_generator(event, res)
                elif res is not None:
                    event.outputs.append(str(res))
            return event.outputs

        async def send(self, message):
            if self._event is not None:
                self._event.outputs.append(str(message))

        async def finish(self, message=None):
            if message is not None and self._event is not None:
                self._event.outputs.append(str(message))

        async def pause(self, *a, **k):
            return None

        async def reject(self, *a, **k):
            return None

        def got(self, key, prompt=None, *a, **k):
            def deco(fn):
                self.handlers.append(fn)
                return fn
            return deco

        def __getattr__(self, item):
            return MagicStub(f'Matcher.{item}')

    def make_matcher(kind, name, aliases=None):
        m = Matcher(kind, str(name))
        box.register(str(name), m._invoke, aliases)
        return m

    def pick(kws):
        """关键字/前缀可以传 str 或 list/tuple/set，统一取第一个"""
        if isinstance(kws, str):
            return kws
        if isinstance(kws, (list, tuple)):
            return kws[0] if kws else ''
        if isinstance(kws, (set, frozenset)):
            return next(iter(kws)) if kws else ''
        return kws

    nb.define('on_command', lambda cmd, aliases=None, **k: make_matcher('command', cmd, aliases or ()))
    nb.define('on_keyword', lambda kws, **k: make_matcher('keyword', pick(kws)))
    nb.define('on_startswith', lambda prefix, **k: make_matcher('startswith', pick(prefix)))
    nb.define('on_endswith', lambda suffix, **k: make_matcher('endswith', pick(suffix)))
    nb.define('on_fullmatch', lambda words, **k: make_matcher('fullmatch', pick(words)))
    nb.define('on_regex', lambda pattern, **k: make_matcher('regex', str(pattern)))
    nb.define('on_message', lambda *a, **k: make_matcher('message', '__message__'))
    nb.define('on_notice', lambda *a, **k: make_matcher('notice', '__notice__'))
    nb.define('on_request', lambda *a, **k: make_matcher('request', '__request__'))
    nb.define('require', lambda *a, **k: MagicStub('require'))
    nb.define('get_driver', lambda: MagicStub('driver'))
    nb.define('get_bot', lambda *a, **k: MagicStub('bot'))
    nb.define('get_loaded_plugins', lambda: [])

    ob11.define('Message', Message)
    adapters.define('Message', Message)
    adapters.define('MessageSegment', MagicStub('MessageSegment'))
    adapters.define('Event', Event)
    adapters.define('Bot', MagicStub('Bot'))
    ob11.define('MessageSegment', MagicStub('MessageSegment'))
    ob11.define('Event', Event)
    ob11.define('Bot', MagicStub('Bot'))
    ob11.define('GroupMessageEvent', Event)
    ob11.define('PrivateMessageEvent', Event)
    ob11.define('GroupMessageSegment', MagicStub('GroupMessageSegment'))

    # 参数依赖注入的哨兵
    params.define('CommandArg', lambda: MagicStub('CommandArg'))
    params.define('ArgPlainText', lambda key=None: MagicStub('ArgPlainText'))
    params.define('Arg', lambda key=None: MagicStub('Arg'))
    params.define('ArgStr', lambda key=None: MagicStub('ArgStr'))
    params.define('EventMessage', lambda: MagicStub('EventMessage'))
    params.define('EventToMe', lambda: MagicStub('EventToMe'))
    params.define('Bot', lambda: MagicStub('Bot'))
    params.define('Event', lambda: MagicStub('Event'))
    params.define('State', lambda: MagicStub('State'))
    return ['__init__.py', 'main.py']


def build_maibot(box: Box):
    """MaiBot：官方 SDK 是 maibot_sdk（PyPI）。这里实现常见的注册装饰器名。"""
    sdk = box.module('maibot_sdk')
    box.module('maibot_sdk.plugin')
    box.module('src.plugin_system')
    box.module('src.plugin_system.base')
    box.module('src.plugin_system.apis')

    class BasePlugin:
        def __init__(self, *a, **k):
            pass

        def get_plugin_config(self, *a, **k):
            return {}

        async def send_text(self, *a, **k):
            return None

    def registrar(*names):
        def deco_factory(name=None, *a, **k):
            def deco(fn):
                box.register(name or getattr(fn, '__name__', 'command'), fn)
                return fn
            return deco
        return deco_factory

    for mod in (sdk, sys.modules['src.plugin_system'], sys.modules['src.plugin_system.base']):
        mod.define('BasePlugin', BasePlugin)
        for attr in ('Command', 'Action', 'Tool', 'Component', 'command', 'action', 'tool', 'register_command'):
            mod.define(attr, registrar())
        mod.define('PluginConfig', dict)
        mod.define('ComponentType', MagicStub('ComponentType'))
    return ['plugin.py', 'main.py', '__init__.py']


def build_langbot(box: Box):
    """
    LangBot 4.0 的插件靠 Plugin Runtime（stdio/websocket 协议）驱动，组件是类 + yaml 清单。
    本桥做"尽力而为"：能列出组件、能加载模块收集类，但完整的运行时语义需要官方 Runtime。
    """
    root = box.module('langbot_plugin')
    box.module('langbot_plugin.api')
    api_def = box.module('langbot_plugin.api.definition')
    plugin_mod = box.module('langbot_plugin.api.definition.plugin')
    comp = box.module('langbot_plugin.api.definition.components')
    cmd_mod = box.module('langbot_plugin.api.definition.components.command')
    box.module('langbot_plugin.api.definition.components.event')
    box.module('langbot_plugin.api.entities')
    box.module('langbot_plugin.api.entities.events')
    box.module('langbot_plugin.api.entities.builtin')

    class BasePlugin:
        def __init__(self, *a, **k):
            pass

    api_def.define('BasePlugin', BasePlugin)
    plugin_mod.define('BasePlugin', BasePlugin)
    root.define('BasePlugin', BasePlugin)

    def registrar(name=None, *a, **k):
        def deco(fn):
            box.register(name or getattr(fn, '__name__', 'command'), fn)
            return fn
        return deco

    for attr in ('Command', 'CommandHandler', 'command_handler', 'handler', 'EventHandler'):
        comp.define(attr, registrar)
        cmd_mod.define(attr, registrar)
    comp.define('BaseComponent', MagicStub('BaseComponent'))
    cmd_mod.define('Command', registrar)
    return ['main.py']


FRAMEWORKS: Dict[str, Dict[str, Any]] = {
    'astrbot': {'title': 'AstrBot', 'build': build_astrbot, 'meta': 'metadata.yaml',
                'desc': 'AstrBot 插件（Python），command 子集', 'glob': '**/*.py'},
    'nonebot2': {'title': 'NoneBot2', 'build': build_nonebot2, 'meta': None,
                 'desc': 'NoneBot2 插件（Python），on_command/on_keyword 子集', 'glob': '**/*.py'},
    'maibot': {'title': 'MaiBot', 'build': build_maibot, 'meta': 'manifest.json',
               'desc': 'MaiBot 插件（maibot_sdk），命令/动作子集', 'glob': '**/*.py'},
    'langbot': {'title': 'LangBot', 'build': build_langbot, 'meta': 'manifest.yaml',
                'desc': 'LangBot 4.x 插件（组件式，完整语义需要官方 Plugin Runtime）', 'glob': '**/*.py'},
}


# --------------------------------------------------------------------------- #
# 加载与调用
# --------------------------------------------------------------------------- #
def read_meta(plugin_dir: str, meta_name: str | None) -> Dict[str, Any]:
    if not meta_name:
        return {}
    path = os.path.join(plugin_dir, meta_name)
    if not os.path.exists(path):
        return {}
    try:
        text = open(path, 'r', encoding='utf-8', errors='replace').read()
    except Exception:
        return {}
    if meta_name.endswith('.json'):
        try:
            data = json.loads(text)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}
    out: Dict[str, Any] = {}
    for line in text.splitlines():
        if not line.strip() or line.startswith('#') or line.startswith(' '):
            continue
        if ':' in line:
            k, v = line.split(':', 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def find_entries(plugin_dir: str, entries: List[str]) -> List[str]:
    found = []
    for name in entries:
        p = os.path.join(plugin_dir, name)
        if os.path.exists(p):
            found.append(p)
    if not found:  # 退而求其次：目录下任意 .py
        for f in sorted(os.listdir(plugin_dir)):
            if f.endswith('.py'):
                found.append(os.path.join(plugin_dir, f))
                break
    return found


def load_plugin(box: Box, entries: List[str]):
    cwd = os.getcwd()
    sys.path.insert(0, box.plugin_dir)
    os.chdir(box.plugin_dir)
    try:
        for path in entries:
            mod_name = 'alison_plugin_%s_%s' % (box.framework, os.path.basename(path).replace('.py', ''))
            spec = importlib.util.spec_from_file_location(mod_name, path)
            if spec is None or spec.loader is None:
                continue
            mod = importlib.util.module_from_spec(spec)
            try:
                spec.loader.exec_module(mod)
                # 收集插件里定义的类：处理器常写成类方法，装饰器拿到的是未绑定函数
                for val in list(vars(mod).values()):
                    if inspect.isclass(val) and val.__module__ == mod_name:
                        box.classes.append(val)
            except SyntaxError as e:
                box.errors.append('语法错误 %s: %s' % (os.path.basename(path), e))
            except Exception as e:
                box.errors.append('加载 %s 失败: %s' % (os.path.basename(path), e))
                box.errors.append(traceback.format_exc()[-600:])
    finally:
        os.chdir(cwd)
        try:
            sys.path.remove(box.plugin_dir)
        except ValueError:
            pass


def _coerce(raw: str, ann: str):
    """按注解把命令行字符串转成插件期望的类型（转不动就原样给）"""
    a = (ann or '').lower()
    try:
        if 'int' in a:
            return int(float(raw))
        if 'float' in a:
            return float(raw)
        if 'bool' in a:
            return str(raw).lower() in ('1', 'true', 'yes', 'on', '是')
    except Exception:
        return raw
    return raw


def make_args(box: Box, fn: Callable, event: Event):
    """按签名给处理函数喂参数：event 位置给 event，其余位置参数按顺序吃命令行参数
    （之前一律塞 event.plain_text，导致 int/str 参数全错、插件静默失败）"""
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return (), {}
    args = []
    kwargs = {}
    cli = list(getattr(event, 'args', None) or [])
    cli_i = 0
    for p in sig.parameters.values():
        if p.kind == inspect.Parameter.VAR_KEYWORD:
            kwargs.update({'state': {}, 'matcher': None, 'bot': None, 'event': event})
            continue
        if p.kind == inspect.Parameter.VAR_POSITIONAL:
            for rest in cli[cli_i:]:
                args.append(rest)
            cli_i = len(cli)
            continue
        default = p.default
        ann = str(p.annotation)
        if 'Event' in ann:
            args.append(event)
            continue
        if isinstance(default, MagicStub) or 'never' in str(default) or 'CommandArg' in str(default) or 'ArgPlainText' in str(default):
            name = str(getattr(default, '__name__', ''))
            if 'Message' in ann or 'CommandArg' in name:
                args.append(Message(event.plain_text))
            elif cli_i < len(cli):
                args.append(_coerce(cli[cli_i], ann))
                cli_i += 1
            else:
                args.append(event.plain_text)
            continue
        if cli_i < len(cli):
            args.append(_coerce(cli[cli_i], ann))
            cli_i += 1
            continue
        if p.default is inspect.Parameter.empty and box.framework in ('astrbot', 'nonebot2'):
            # 没有更多命令行参数：第一个必需位置参数当成 event
            args.append(event)
            continue
        # 有默认值且没有多余参数 → 交给默认值
    return tuple(args), kwargs


def run_handler(box: Box, fn: Callable, event: Event) -> Any:
    args, kwargs = make_args(box, fn, event)
    last = None
    for call in (
        lambda: fn(*args, **kwargs),
        lambda: fn(event, *args[1:], **kwargs) if args else fn(event),
        lambda: fn(event),
    ):
        try:
            res = call()
            if inspect.isawaitable(res):
                res = run_coro(res)
            if isinstance(res, types.AsyncGeneratorType) or inspect.isgenerator(res):
                drain_generator(event, res)
                res = None
            if isinstance(res, (list, tuple, set, frozenset)):
                # 有界迭代：shim 里有的"消息对象"伪装成 list，直接 for 会无限展开（MemoryError）
                try:
                    taken = 0
                    for x in res:
                        if x is not None and taken < 50:
                            event.outputs.append(str(x))
                            taken += 1
                        if taken >= 50:
                            break
                except Exception:
                    event.outputs.append(str(res))
            elif isinstance(res, Message):
                event.outputs.append(str(res))
            elif res is not None:
                event.outputs.append(str(res))
            break
        except TypeError as e:
            last = e
            continue
        except Exception as e:
            last = e
            box.errors.append(traceback.format_exc()[-600:])
            break
    dedupe(event.outputs)
    if not event.outputs and last is not None:
        box.errors.append(str(last))
    return event.outputs


def resolve_command(box: Box, command: str):
    if command in box.commands:
        return command, box.commands[command]
    if command in box.aliases:
        real = box.aliases[command]
        return real, box.commands[real]
    for name, fn in box.commands.items():
        if name.startswith(command) or command.startswith(name):
            return name, fn
    return None, None


def rebind_methods(box: Box):
    """把注册进来的"未绑定类方法"换成绑定到实例的方法（AstrBot / MaiBot 常见写法）
    插件类几乎都要构造参数（AstrBot 是 __init__(self, context)），所以按"越来越宽松"的顺序试构造，
    实在构造不出来才退化成 stub —— 并且即使退化成 stub 也要保证命令仍能调用真实函数。"""
    for cls in box.classes:
        inst = None
        ctor_tries = (
            lambda: cls(),
            lambda: cls(MagicStub('context')),
            lambda: cls(MagicStub('ctx'), MagicStub('config')),
            lambda: cls(MagicStub('context'), MagicStub('config'), MagicStub('event')),
        )
        for ctor in ctor_tries:
            try:
                inst = ctor()
                break
            except Exception:
                continue
        if inst is None:
            inst = MagicStub('instance.' + getattr(cls, '__name__', 'Plugin'))
        for attr in list(vars(cls).keys()):
            try:
                raw = vars(cls)[attr]
            except Exception:
                continue
            for name, fn in list(box.commands.items()):
                if fn is not raw:
                    continue
                bound = None
                try:
                    bound = getattr(inst, attr)
                except Exception:
                    bound = None
                # stub 实例上取到的不是真方法（会输出 <stub ...>），这时手动把 self 绑上真实函数
                if bound is None or isinstance(bound, MagicStub):
                    def make(raw_fn=raw, self_obj=inst):
                        def caller(*a, **k):
                            return raw_fn(self_obj, *a, **k)
                        return caller
                    bound = make()
                box.commands[name] = bound


def do_list(framework: str, plugin_dir: str):
    box = Box(framework, plugin_dir)
    spec = FRAMEWORKS[framework]
    entries = find_entries(plugin_dir, spec['build'](box))
    load_plugin(box, entries)
    rebind_methods(box)
    return {
        'ok': True,
        'framework': framework,
        'dir': plugin_dir,
        'metadata': read_meta(plugin_dir, spec['meta']),
        'entries': [os.path.basename(e) for e in entries],
        'commands': sorted(box.commands.keys()),
        'aliases': box.aliases,
        # 插件用到但本桥未精确实现的 API（供上层展示兼容程度）
        'unsupported': sorted(set(u for u in box.usage if not u.endswith(('__all__',)))),
        'log': box.logs,
        'errors': box.errors,
    }


def do_run(framework: str, plugin_dir: str, command: str, args: List[str]):
    box = Box(framework, plugin_dir)
    spec = FRAMEWORKS[framework]
    entries = find_entries(plugin_dir, spec['build'](box))
    load_plugin(box, entries)
    rebind_methods(box)
    if not box.commands:
        return {'ok': False, 'error': '插件没有注册任何命令（可能依赖完整运行时）',
                'log': box.logs, 'errors': box.errors, 'unsupported': sorted(set(box.usage))}
    real, fn = resolve_command(box, command)
    if fn is None:
        return {'ok': False, 'error': '没有命令 %s（可用：%s）' % (command, ', '.join(sorted(box.commands))),
                'commands': sorted(box.commands), 'log': box.logs, 'errors': box.errors}
    event = Event(command, args, framework)
    outputs = run_handler(box, fn, event)
    return {
        'ok': bool(outputs),
        'framework': framework,
        'command': real,
        'outputs': outputs,
        'error': None if outputs else ('插件没有产生输出' + ('（%s）' % box.errors[-1] if box.errors else '')),
        'log': box.logs,
        'errors': box.errors,
        'unsupported': sorted(set(box.usage)),
    }


def main():
    argv = sys.argv[1:]
    if not argv:
        print(json.dumps({'ok': False, 'error': '用法: pyplugin-bridge.py <framework> <plugin_dir> list|run ...'}))
        return
    # 兼容旧用法：第一个参数就是目录 → 按 astrbot 处理
    if os.path.isdir(argv[0]):
        framework = 'astrbot'
    else:
        framework = argv.pop(0)
    if framework not in FRAMEWORKS:
        print(json.dumps({'ok': False, 'error': '不支持的框架 %s（可用：%s）' % (framework, ', '.join(FRAMEWORKS))}))
        return
    if not argv:
        print(json.dumps({'ok': False, 'error': '缺少插件目录'}))
        return
    plugin_dir = os.path.abspath(argv.pop(0))
    action = argv.pop(0) if argv else 'list'
    try:
        if action == 'list':
            out = do_list(framework, plugin_dir)
        elif action == 'run':
            out = do_run(framework, plugin_dir, argv[0] if argv else '', argv[1:])
        elif action == 'frameworks':
            out = {'ok': True, 'frameworks': {k: {'title': v['title'], 'desc': v['desc'], 'meta': v['meta']} for k, v in FRAMEWORKS.items()}}
        else:
            out = {'ok': False, 'error': '未知动作 ' + action}
    except Exception as e:
        out = {'ok': False, 'error': str(e), 'trace': traceback.format_exc()[-1000:]}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
