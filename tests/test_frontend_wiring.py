"""前端**接线**的契约测试：本轮四项诉求在 `petview.js` / `panel.js` / `plugin.js`
里必须真的接上，而不只是后端算好了。

为什么需要这一层：后端把 `still` / `schedule` 算好并下发，只证明「数据对」；
**前端有没有用它**是另一件事。而漏用的表现非常隐蔽——
宠物照样跑、面板照样开，只是「静止时仍然卡在抬头帧」或「拖了滑块没反应」。

这些检查是**对源码文本的静态检查**（与 `test_css_contracts.py` 同一个思路），
补的是真实浏览器验收覆盖不到的部分（例如「有没有调这个方法」）。
"""

import os
import re

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(relative):
    with open(os.path.join(REPO_ROOT, relative), encoding='utf-8') as handle:
        return handle.read()


@pytest.fixture(scope='module')
def petview():
    return read('frontend/petview.js')


@pytest.fixture(scope='module')
def panel():
    return read('frontend/panel.js')


@pytest.fixture(scope='module')
def plugin():
    return read('frontend/plugin.js')


@pytest.fixture(scope='module')
def animation():
    return read('frontend/animation.js')


# ==================================================== 1. 标准图像接线


def test_petview_draws_the_still_image_when_static(petview):
    """★ 宠物在**静止**时必须画标准图像，而不是「上一次抽到的变体的第 0 帧」。

    这是本轮修的核心。旧实现里 `finishIdleBurst()` 只把时钟钉成单帧、
    保留当前变体的贴图——于是随机播到「张望」之后就卡在抬头看那一帧上。
    """
    assert 'stillFrame' in petview, '必须用 animation.js 的标准图像解析'
    assert 'function drawStill()' in petview, '必须有把标准图像写进 sprite 的函数'
    # 收尾必须回到标准图像
    finish = petview[petview.index('function finishIdleBurst'):]
    finish = finish[:finish.index('\n  }')]
    assert 'drawStill()' in finish, (
        'idle 小动作播完必须回到**标准图像**，否则会卡在刚播过的那一套上'
    )


def test_petview_uses_still_for_idle_in_random_mode(petview):
    """`random` 模式下 idle 平时就是标准图像（不是 idle 首帧）。

    两者在作者只给一套 idle 时长得一样，但在挂了第二套时完全不同——
    这正是内置形象的情况。
    """
    assert "next === 'idle' && !idleLoops && !idleBurst" in petview, (
        'idle 的静止态要切到标准图像'
    )


def test_petview_does_not_clear_the_sprite_when_still_is_missing(petview):
    """没有标准图像时**保持当前绘制**，而不是清空背景。

    清空的表现是「宠物凭空消失」——比画错一帧糟得多。
    """
    body = petview[petview.index('function drawStill()'):]
    body = body[:body.index('\n  }')]
    assert 'if (!still) return;' in body, '没有图时应直接返回，不动 sprite'


def test_petview_exposes_still_for_verification(petview):
    """暴露 `still`（含「当前画的是不是它」），否则「静止画面对不对」无法自动验证。

    它是**渲染结果**，源码里看不出来，因此必须有运行期读数。
    """
    assert 'get still()' in petview
    assert 'showing:' in petview, '要能读出「当前 sprite 上是不是标准图像」'


# ==================================================== 2. 触发时间接线


def test_petview_uses_the_scheduler_for_roam(petview):
    """★ 自动漫游的间隔必须来自后端下发的节奏，而不是写死的随机数。

    旧实现是 `walkTimer = 3000 + Math.random() * 6000`——写死的话
    「调整漫游触发时间」这个诉求就落不了地。
    """
    body = petview[petview.index('function scheduleWalk()'):]
    body = body[:body.index('\n  }')]
    assert "scheduler.reschedule('roam')" in body, (
        '漫游间隔要抽自调度器（可按形象配置）'
    )
    assert '3000 + Math.random() * 6000' not in body, '写死的间隔必须去掉'


def test_petview_uses_the_scheduler_for_idle(petview):
    body = petview[petview.index('function scheduleIdleWake()'):]
    body = body[:body.index('\n  }')]
    assert "scheduler.reschedule('idle')" in body


def test_petview_reads_the_schedule_from_the_pack(petview):
    """节奏的权威值来自后端（用户设置 > 包内声明 > 默认），前端只取用。"""
    assert 'scheduler.setSchedule(pack.schedule)' in petview, (
        '必须从形象定义里读节奏，而不是自己写一份默认值'
    )


def test_petview_can_update_the_schedule_in_place(petview):
    """★ 面板改完节奏要**立刻生效**（不必刷新页面）。

    而且要**重排**当前等待中的定时器：用户把间隔从 18 秒调到 2 秒，
    若还等完那 18 秒才看到效果，看起来就像没生效。
    """
    assert 'setSchedule(schedule)' in petview, '视图要暴露就地更新节奏的入口'
    body = petview[petview.index('    setSchedule(schedule) {'):]
    body = body[:body.index('\n    },')]
    assert 'cancelIdleWake()' in body, '改完要重排 idle 定时器'
    assert 'walkTimer' in body, '改完要重排漫游定时器'


def test_plugin_pushes_the_schedule_to_the_running_pet(plugin):
    """`plugin.js` 要在**视图重建后**把节奏重新灌进去。

    新建的视图拿的是构造时的 `pack.schedule`，而用户可能刚改过节奏、
    这次重建是改倍率触发的——不重灌就会静默回到旧节奏。
    """
    assert 'function applySchedule(pack)' in plugin
    assert 'applySchedule(pack)' in plugin
    # 重建与「重新显示」共用同一条挂载路径，节奏在这条路径上灌
    body = plugin[plugin.index('async function mountPetView'):]
    body = body[:body.index('\n  }')]
    assert 'applySchedule(pack)' in body, '视图挂载后必须灌节奏'
    # `applyPack`（重建）必须走这条路径，而不是自己 createPetView
    repack = plugin[plugin.index('async function applyPack(pack)'):]
    repack = repack[:repack.index('\n  }')]
    assert 'await mountPetView(container, pack, position)' in repack, (
        'applyPack 必须复用 mountPetView（否则两条路径会各自漂移）'
    )
    assert 'createPetView' not in repack, (
        'applyPack 不该自己建视图——那样「重新显示」那条路径的修复不会生效'
    )


def test_plugin_exposes_schedule_for_diagnostics(plugin):
    assert 'schedule: state.petView ? state.petView.schedule : null' in plugin


# ==================================================== 3. 作者署名接线


def test_panel_has_an_author_input_for_user_pets(panel):
    """★ 自定义宠物要能设作者名（用户要求：方便其他人制作宠物发布）。"""
    assert 'function renderAuthorRow()' in panel
    assert "data-author-input" in panel or 'authorInput' in panel
    # 内置形象只读：不给输入框
    body = panel[panel.index('function renderAuthorRow()'):]
    body = body[:body.index('\n  }')]
    assert 'detail.writable' in body, '内置形象不该给可编辑的作者框'


def test_panel_create_form_collects_the_author(panel):
    """新建表单也要能填作者（发布前就署好名，而不是建完再补）。"""
    assert 'draftAuthor' in panel
    body = panel[panel.index('function renderCreate()'):]
    body = body[:body.index('\n  function renderCreateRow')]
    assert 'draftAuthor' in body, '新建表单里要有作者输入'
    assert "form.append('author'" in panel, '提交时要把作者带上'


def test_panel_shows_the_author_on_every_card_or_detail(panel):
    """作者要显示出来——否则「这是谁做的」无从得知，署名就没意义。"""
    assert 'renderAuthorRow()' in panel
    assert "'作者'" in panel


# ==================================================== 4. 触发时间接线


def test_panel_renders_schedule_sliders_for_both_behaviors(panel):
    """面板要渲染**两个**行为的滑块（idle 小动作 / 自动漫游）。"""
    assert 'function renderSchedule()' in panel
    assert 'SCHEDULE_BEHAVIORS' in panel
    # DOM 的 `dataset.scheduleBehavior` 在 HTML 上就是 `data-schedule-behavior`
    assert 'slider.dataset.scheduleBehavior' in panel
    assert "updateSchedule(behavior.key" in panel


def test_panel_schedule_commits_on_release_not_on_input(panel):
    """★ 滑块要**松手才提交**，不能在 `input` 里提交。

    一次拖动会触发几十个 `input` 事件，每次都发请求 = 打爆后端。
    这与倍率滑块的既有做法一致。
    """
    body = panel[panel.index('function renderSchedule()'):]
    body = body[:body.index('\n  /**')]
    assert "slider.addEventListener('change'" in body, '松手（change）才提交'
    # `input` 只更新读数（`live`），而 `live` 里不能发请求
    assert "slider.addEventListener('input', live)" in body, (
        '`input` 应绑定到一个只更新读数的函数'
    )
    live = body[body.index('const live = () => {'):]
    live = live[:live.index('\n        };')]
    assert 'updateSchedule' not in live, '`input` 的处理里绝不能发请求'
    assert 'readout.textContent' in live, '`input` 只更新读数'


def test_panel_offers_reset_for_schedule(panel):
    """要能恢复默认（用户试了一圈之后总得有条退路）。"""
    assert 'function resetSchedule()' in panel
    assert "reset: true" in panel
    assert 'detail.scheduleOverridden' in panel, '只在真的改过时才显示恢复按钮'


def test_panel_create_form_can_set_initial_schedule(panel):
    """新建表单也要能设初始节奏（作者在包里声明「建议值」）。"""
    assert 'draftSchedule' in panel
    assert 'function renderCreateSchedule()' in panel
    assert "form.append('schedule'" in panel


def test_panel_create_form_can_pick_a_still(panel):
    """新建表单要能选标准图像（这是修「卡在抬头帧」的入口）。"""
    assert 'draftStill' in panel
    assert 'function renderCreateStill()' in panel
    assert 'renderCreateStill()' in panel
    assert "form.append('still'" in panel


def test_no_markdown_asterisks_in_ui_strings(panel):
    """★ 用户可见的文案里不能出现 markdown 的 `**`。

    实测踩到过：注释与文档里习惯性写 `**强调**`，抄进面向用户的字符串之后，
    面板上就真的显示「这两项是**按形象**记住的」——两个星号原样露在界面上。
    注释里随便写，但**字符串字面量**里不行。
    """
    offenders = []
    for number, line in enumerate(panel.splitlines(), 1):
        code = line.strip()
        if code.startswith(('*', '//', '/*')):
            continue  # 注释：允许（而且本来就该写 markdown）
        # 找单/双引号字符串里的 **
        for match in re.finditer(r"""(['"])((?:[^'"]|\\.)*?)\1""", line):
            if '**' in match.group(2):
                offenders.append((number, match.group(2)[:60]))
    assert offenders == [], f'用户可见文案里出现了 markdown 星号: {offenders}'


def test_panel_indexes_schedule_by_behavior_key(panel):
    """★ 必须用 `behavior.key` 取值，不能用 `behavior` 对象本身。

    实测踩到过：`effective[behavior]` 里 `behavior` 是 `{key, label, hint}` 对象，
    索引恒为 `undefined` → 滑块渲染成**极值**（200 / 3600000），
    读数显示「0.2~3600 秒」。滑块看着在、也能拖，只是初值是错的——
    比直接报错难查得多（用户会以为「这个形象就是 1 小时动一次」）。
    """
    for line in panel.splitlines():
        code = line.split('//')[0]
        for name in ('effective', 'declared', 'draftSchedule'):
            assert f'{name}[behavior]' not in code, (
                f'必须用 behavior.key 索引：{line.strip()}'
            )
    assert 'effective[behavior.key]' in panel
    assert 'declared[behavior.key]' in panel


def test_panel_schedule_sliders_use_the_behavior_defaults(panel):
    """滑块初值要按**该行为自己的**默认区间夹，而不是全局的 200~3600000。

    用全局区间夹的后果与上一条一样：初值跑到极值上。
    """
    body = panel[panel.index('function renderSchedule()'):]
    body = body[:body.index('\n  /**')]
    assert 'DEFAULT_SCHEDULE_MS[behavior.key]' in body, (
        '要取该行为的默认区间作为夹取与回落的基准'
    )
    assert 'clampScheduleMs(current.minIntervalMs, preset.min)' in body
    assert 'clampScheduleMs(current.maxIntervalMs, preset.max)' in body


def test_panel_schedule_labels_are_human_readable(panel):
    """滑块旁边要有中文标签与提示——只有 `idle` / `roam` 的话用户看不懂。"""
    for label in ('待机小动作', '自动漫游'):
        assert label in panel, f'缺少「{label}」的标签'


# ================================================ 5. 关闭宠物（显示开关）


def test_plugin_reads_hidden_state_before_registering_ambient(plugin):
    """★ 显示开关必须在 `registerAmbient()` **之前**读到。

    宿主的 ambient 是「注册即挂载」，晚一步就会**先闪出一只宠物再把它收掉**
    ——那正是「明明是关着的，怎么还闪了一下」这类报障的成因。
    """
    body = plugin[plugin.index('async function loadConfig()'):]
    body = body[:body.index('\n  }')]
    assert 'state.hidden' in body, '必须在这里读初值'

    startup = plugin[plugin.index('// ------------------------------------------------------------ 启动'):]
    assert startup.index('await loadConfig()') < startup.index('registerAmbient()'), (
        'loadConfig 必须在 registerAmbient 之前'
    )


def test_plugin_keeps_ambient_container_empty_when_hidden(plugin):
    """★ 关掉时**不创建视图**，而不是「建完再藏」。

    后者留着 rAF、定时器与全局监听在空转，而用户关掉宠物的意图正是
    「让它彻底安静下来」。这里也顺带保证了一点：关掉 = 真的关掉。
    """
    body = plugin[plugin.index("state.surfaceKey = api.surfaces.register('pet'"):]
    body = body[:body.index('\n    });')]
    assert 'if (state.hidden)' in body, '挂载时要判断隐藏状态'
    hidden_branch = body[body.index('if (state.hidden)'):body.index('// 挂载期先把宠物画出来')]
    assert 'createPetView' not in hidden_branch, (
        '隐藏时绝不能建视图——那会留下一堆在空转的资源'
    )
    # 但**要记住容器**，否则「显示宠物」时没有地方可挂
    assert 'state.container = container' in body


def test_plugin_hide_disposes_the_view(plugin):
    """隐藏要真的销毁视图（连带 rAF / 定时器 / 监听一起回收）。"""
    body = plugin[plugin.index('function hidePet()'):]
    body = body[:body.index('\n  }')]
    assert 'state.petView.dispose()' in body
    assert 'state.petView = null' in body


def test_plugin_show_rebuilds_the_view(plugin):
    """显示要重建视图，并且**重新取一次形象数据**。

    关掉期间用户可能在面板里换过形象，用旧数据重建会显示出上一个形象。
    """
    body = plugin[plugin.index('async function showPet()'):]
    body = body[:body.index('\n  }')]
    assert 'fetchRuntime()' in body, '要重新取形象数据'
    assert 'mountPetView(' in body, '要重建视图'


def test_plugin_hide_is_idempotent(plugin):
    """重复关闭 / 重复显示都不该出问题（面板可能连点）。"""
    for name in ('function hidePet()', 'async function showPet()'):
        body = plugin[plugin.index(name):]
        body = body[:body.index('\n  }')]
        assert 'if (state.hidden) return;' in body or 'if (!state.hidden && state.petView) return;' in body, (
            f'{name} 缺少幂等守卫'
        )


def test_plugin_does_not_reapply_pack_when_hidden(plugin):
    """★ 宠物关着时，形象变化**不该**让它冒出来。

    `onPetChanged` 会被「新建形象」等操作触发，而新建形象会顺手把新形象
    设为当前形象——不挡的话，用户关掉宠物后建一个形象，宠物就又出现了。
    """
    body = plugin[plugin.index('onPetChanged: async (petId) => {'):]
    body = body[:body.index('\n    },')]
    assert 'if (state.hidden) return;' in body, (
        '关着的时候不能在形象变化后重建视图'
    )


def test_plugin_toggle_saves_to_backend_and_rolls_back(plugin):
    """★ 开关要：① 先改本地（立刻有反应）② 存后端 ③ 失败时回滚。

    只做前两步的话，网络失败会留下「界面说关了、其实没关」的不一致；
    只做第 ② 步的话，用户点了开关要等一次网络往返才看到反应
    （那正是「点了没反应」这类报障的常见成因）。
    """
    body = plugin[plugin.index('async function setHidden(hidden)'):]
    body = body[:body.index('\n  }')]
    assert 'hidePet()' in body and 'showPet()' in body, '先改本地状态'
    assert "api.api('/visibility'" in body, '要持久化到后端'
    assert 'catch' in body and '回滚' in body, '失败时要回滚'
    # 回滚的两条路都要有
    rollback = body[body.index('catch'):]
    assert 'showPet()' in rollback and 'hidePet()' in rollback


def test_plugin_exposes_hide_and_show_on_the_debug_handle(plugin):
    """诊断句柄要能关闭 / 显示宠物（也让验收脚本能驱动它）。"""
    assert 'hide: () => setHidden(true)' in plugin
    assert 'show: () => setHidden(false)' in plugin
    assert 'hidden: state.hidden' in plugin


def test_panel_renders_the_visibility_toggle(panel):
    """★ 面板要有显眼的开关，而且放在最上面。

    藏进「设置 → 插件」两层里就等于没有——想安静一会儿还要翻半天，
    用户会继续用「卸载插件」那个笨办法（这正是用户报障的痛点）。
    """
    assert 'function renderVisibility()' in panel
    assert 'renderVisibility()' in panel
    # 必须挂在工具栏之后、形象列表之前（也就是最显眼的位置）
    body = panel[panel.index('function render() {'):]
    body = body[:body.index('const body = el(')]
    assert 'renderVisibility()' in body, '开关要渲染在顶部区域'
    assert "toggle.dataset.visibilityToggle = 'true'" in panel, '要能被验收脚本定位'
    assert 'toggle.dataset.visibilityHidden' in panel, '要能读出当前状态'


def test_panel_visibility_toggle_calls_back_to_plugin(panel):
    """开关的实际动作要交给 `plugin.js`（它是显示状态的权威来源）。"""
    assert 'onHiddenChange' in panel
    assert 'function toggleVisibility(' in panel
    assert 'await onHiddenChange(hidden)' in panel


def test_panel_visibility_copy_explains_it_is_not_a_disable(panel):
    """文案要说清「关掉的是宠物，不是插件」——否则用户不敢点。"""
    body = panel[panel.index('function renderVisibility()'):]
    body = body[:body.index('\n  }')]
    assert '插件仍然启用' in body, '要明确说插件没被停用'
    assert '不必卸载或停用插件' in body, '要点出这个开关的用途'
    # 关掉之后要告诉用户怎么开回来
    assert '显示宠物' in body


def test_panel_hidden_state_is_the_plugin_s_authority(panel):
    """面板的显示状态是**镜像**，初值与刷新都要问 `plugin.js`。

    面板可能在宠物已被关闭的情况下才第一次打开（用户先关掉、再点面板），
    那时靠自己的默认值就会显示成「显示中」。
    """
    assert 'getHidden' in panel
    body = panel[panel.index('onOpen() {'):]
    body = body[:body.index('\n    },')]
    assert 'getHidden()' in body, '每次打开都同步一次'
    # 回灌入口
    assert 'setHiddenState' in panel
    assert 'setHiddenState,' in panel, '要作为公开方法暴露给 plugin.js'


def test_plugin_feedback_loop_uses_setHiddenState(plugin):
    """`plugin.js` 改完状态要回灌面板，否则后台改状态时面板显示会过期。"""
    body = plugin[plugin.index('async function setHidden(hidden)'):]
    body = body[:body.index('\n  }')]
    assert 'panel.setHiddenState(' in body


# ==================================================== 纯逻辑层的边界


def test_animation_module_still_has_no_dom_or_timers(animation):
    """`animation.js` 是纯逻辑层：不得碰 DOM，也不得自己起定时器。

    这一条是既有契约（见 README §10）。本轮往里加了标准图像解析与
    通用调度器，很容易顺手写一个 `setTimeout` 进去——
    而 `random` 模式下 rAF 是停着的，纯逻辑层里的倒计时永远不会前进。

    注释要剥掉：本文件的注释里**故意**提到 `setTimeout` 来解释「为什么不用它」，
    不剥离的话检查会把文档当成违规（与 `test_css_contracts.py` 同一个坑）。
    """
    code = re.sub(r'/\*.*?\*/', '', animation, flags=re.DOTALL)
    code = re.sub(r'^\s*//.*$', '', code, flags=re.MULTILINE)
    for forbidden in (
        'document.', 'window.', 'requestAnimationFrame', 'setTimeout', 'setInterval',
    ):
        assert forbidden not in code, f'animation.js 的代码里不该出现 {forbidden}'


def test_schedule_keys_are_shared_between_panel_and_animation(panel, animation):
    """面板与调度器认的行为名单必须同源（都来自 `SCHEDULE_BEHAVIORS`）。"""
    assert 'SCHEDULE_BEHAVIORS' in panel
    assert 'SCHEDULE_BEHAVIORS' in animation
    # 面板导入的是 animation.js 的那一份，而不是自己再写一遍
    assert "from './animation.js'" in panel
