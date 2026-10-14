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


@pytest.fixture(scope='module')
def preview():
    return read('frontend/preview.js')


@pytest.fixture(scope='module')
def statemachine():
    return read('frontend/statemachine.js')


@pytest.fixture(scope='module')
def css():
    return read('frontend/plugin.css')


@pytest.fixture(scope='module')
def routes_source():
    return read('backend/routes.py')


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


def test_still_frame_carries_its_own_size(animation):
    """★ 标准图像的几何要**跟着它自己那条 sheet** 走。

    这是「标准图像」与「逐动作尺寸」合到一起才暴露的问题：标准图像可以取自
    任意一条 sheet（例如躺姿 `sleep.png` 的某一帧），而那条 sheet 的比例
    可能与当前动作完全不同。不带尺寸的话，`drawStill()` 只能用当前动作的
    `width` / `height` 去铺它——横构图的图被按竖构图拉伸（实测失真 62%）。
    """
    assert 'size: still.size || undefined' in animation, (
        'stillFrame 必须透传 size'
    )


def test_still_getter_exposes_size(petview):
    """诊断句柄要能读到标准图像的尺寸。

    几何算错时界面**看着有图**，只是显示的是被拉伸的那一张——
    没有这个值就只能靠量像素去猜（实测踩过：`viewStillSize` 读出来是
    `undefined`，于是「后端对了没有、前端用了没有」两件事分不清）。
    """
    body = petview[petview.index('get still()'):]
    body = body[:body.index('\n    },')]
    assert 'size: still.size' in body, '标准图像的 size 要能被读到'


def test_draw_still_applies_its_own_geometry(petview):
    """★ `drawStill()` 要**先切几何再绘制**，并在尺寸变化时重算位移。

    只写 `background-size` 而不改 `width` / `height` 是不够的：
    那两处同时进了「包围盒中心 → 左上角」的换算，不重算宠物会偏出去一段。
    """
    body = petview[petview.index('function drawStill()'):]
    body = body[:body.index('\n  }')]
    assert 'applyFrameSize(' in body, '要先应用标准图像自己的几何'
    assert 'drawPosition()' in body, '尺寸变了要立刻重算位移'
    # 顺序：几何必须在写 background-size 之前
    assert body.index('applyFrameSize(') < body.index('backgroundSize'), (
        '几何必须在写 background-size 之前切好，否则会按旧尺寸铺一帧'
    )


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


# ==================================================== 2. 预览框比例


def test_panel_applies_geometry_to_every_small_preview(panel):
    """★ 小预览框的几何必须覆盖**动作网格**，不能只覆盖卡片缩略图。

    真实 bug（在真实浏览器里截图看出来的）：`renderActionTile()` 老老实实写了
    `data-frames` / `data-layout` / `data-has-image`（注释还写着
    「按帧数放大 + 左对齐」），但 `applyThumbGeometry()` 只查
    `.pet-card-thumb` —— 于是动作网格里的小图停在 `background-size: auto`，
    只露出整条 spritesheet 左上角那 56×56 的一块（在 1536×576 的 idle 上
    正好落在**空白区域**），整个动作区只剩文字、没有一个预览图。

    这与「卡片缩略图只有第一张有几何」是**同一个成因**：加了一处预览框，
    忘了加进选择器。所以这里同时钉住「选择器覆盖两处」与
    「动作网格确实写了那三个 data- 属性」。
    """
    body = panel[panel.index('function applyThumbGeometry()'):]
    body = body[:body.index('\n  }')]
    assert '.pet-card-thumb' in body, '卡片缩略图要处理'
    assert '.pet-action-preview' in body, '动作网格的小图也要处理'
    assert 'dataset.frames' in body and 'dataset.layout' in body, (
        '几何要按每个框自己的帧数与排布算'
    )
    # 动作网格侧：三个 data- 属性都要写（几何applier 靠它们工作）
    tile = panel[panel.index('function renderActionTile(entry)'):]
    tile = tile[:tile.index('\n  }')]
    for hook in ('preview.dataset.frames', 'preview.dataset.layout', 'preview.dataset.hasImage'):
        assert hook in tile, f'{hook} 是几何契约，不能丢'


def test_panel_preview_geometry_runs_after_dom_is_attached(panel):
    """几何必须在 DOM 挂上之后算（否则 `clientWidth` 是 0，全按兜底值铺）。"""
    body = panel[panel.index('    root.appendChild(body);'):]
    body = body[:body.index('function renderPetCard')]
    assert 'applyThumbGeometry()' in body, '挂上 DOM 之后要立刻算几何'


def test_panel_preserves_scroll_across_rebuilds(panel):
    """★ 全量重建时必须**保留滚动位置**，否则每次切动作都被弹回顶部。

    用户报障：「我在切换动画预览项时页面每次都会自动滚动到顶部，不方便使用」。

    根因：`render()` 是**全量重建**（`root.textContent = ''`），两个滚动容器
    （左栏 `.pet-panel-list`、右栏 `.pet-panel-detail`）都是新节点，
    `scrollTop` 自然从 0 开始。而预览项一点就 `render()`，
    于是右栏每次都被弹回顶部——想接着看下面的「预览速度」「动作网格」
    就得重新往下滚，改一个参数要滚一次。

    修法是「重建前记下、挂上后还原」。这里用静态检查守住三件事：
    顺序、位置、以及**必须夹到新上限**（重建后内容可能变矮）。
    """
    assert 'function captureScroll()' in panel, '必须能记录滚动位置'
    assert 'function restoreScroll(saved)' in panel, '必须能还原滚动位置'
    # 两个滚动容器都要照顾到
    assert "querySelector('.pet-panel-list')" in panel, '左栏列表的滚动也要保留'
    assert "querySelector('.pet-panel-detail')" in panel, '右栏详情的滚动也要保留'
    # 顺序：捕获必须在清空 DOM 之前。
    # ⚠️ 锚点要带缩进与分号：`captureScroll` 的文档注释里也提到了
    # `root.textContent = ''`，用裸字符串会先匹配到注释（假失败）。
    capture_at = panel.index('const savedScroll = captureScroll();')
    wipe_at = panel.index("\n    root.textContent = '';\n")
    assert capture_at < wipe_at, '必须在清空 DOM **之前**记录滚动位置'
    # 还原必须在挂上 DOM 之后（游离节点的 scrollTop 无效）
    append_at = panel.index('    root.appendChild(body);')
    restore_at = panel.index('    restoreScroll(savedScroll);')
    assert restore_at > append_at, '必须在 DOM 挂上**之后**还原滚动位置'
    # 夹到新上限：重建后内容高度可能变矮
    assert 'scrollHeight - node.clientHeight' in panel, '还原时要夹到新的滚动上限'


def test_panel_passes_frame_size_into_the_preview(preview):
    """★ 预览必须知道**单帧的真实尺寸**，否则横构图动作会被压扁。

    用户报障：「预览动画框应该根据动作的比例来自动变化……否则看起来会很奇怪
    （点名小卡的睡觉动作）」。

    小卡的睡觉是躺姿、横构图（627×353），旧实现强行把一帧拉到框宽，
    于是人物被压扁。修法是让 `applyFrameGeometry` 按真实比例做 `contain`，
    而它需要尺寸——所以面板必须把尺寸一路传下去。
    """
    # 几何函数必须接受并使用尺寸参数（末位 `dpr` 是可选的，只给单测用）
    assert 'export function applyFrameGeometry(box, frames, layout, index, size, layer, dpr)' in preview, (
        'applyFrameGeometry 必须接收单帧尺寸与内层'
    )
    assert 'boxWidth / frameWidth' in preview, '必须按真实宽高比做 contain 缩放'
    # 底边对齐：用户明确要求「预览动画底部和预览框对齐」
    assert 'boxHeight - shownHeight' in preview, '必须底边对齐（不是垂直居中）'
    # 播放器要把变体尺寸喂给几何函数
    assert 'variant ? variant.size : null' in preview, '播放器必须把尺寸传给几何函数'


def test_preview_geometry_snaps_to_device_pixels(preview):
    """★ 帧尺寸要**对齐到整数设备像素**，否则内层边缘会出现半像素细缝。

    帧的显示尺寸常常是小数（400×300 装进 166px 方框 → 高正好 124.5px），
    这时内层边缘落在半个设备像素上，那一行会被画成「本帧颜色 + 外框底色」
    各一半的混合。实测：不对齐 → 内层边缘 208 个混合像素；对齐后 → 42 个
    （只剩外框圆角那一块）。

    注意这与「邻帧泄漏」是两件事：邻帧由内层裁切解决（见下一条）。
    """
    assert 'function snapToDevicePixels(' in preview, '必须有对齐到设备像素的辅助函数'
    assert 'function currentDpr(' in preview, '必须读取真实设备像素比'
    assert 'window.devicePixelRatio' in preview, '对齐要按真实设备像素比算'
    assert 'snapToDevicePixels(known ? frameWidth * fit' in preview, '帧宽要对齐'
    assert 'snapToDevicePixels(known ? frameHeight * fit' in preview, '帧高要对齐'
    # 纯计算层：Node 测试里没有 window，必须做存在性判断
    assert "typeof window === 'undefined'" in preview, '没有 window 时要能退回 1'


def test_preview_geometry_uses_an_inner_frame_layer(preview):
    """★ 背景必须铺在「一帧大小」的**内层**上，否则留白处会露出邻帧。

    按比例装入必然留白（横构图左右留、竖构图上下留），而 `background-image`
    是按**整条** spritesheet 铺的——铺在外框上时，留白处露出来的正是
    **相邻的帧**。实测：睡觉的预览框左边缘飘着一个「z」、右边缘挂着半个人影
    （都是隔壁帧的内容），比原来的「压扁」更怪。

    单个元素解决不了：`background-clip` 裁不了「背景里的某一块」，
    而 `mask` / `clip-path` 会连**边框**一起裁掉（框就残缺了）。
    因此改成「外框 + 内层」，内层只有一帧大小，邻帧物理上漏不出来。
    """
    # 播放器要创建内层
    assert 'function createAnimationPlayer(options = {})' in preview
    assert "layer.className = 'pet-preview-frame-layer'" in preview, '内层要有自己的类名'
    assert 'box.appendChild(layer)' in preview, '内层要挂进外框'
    # 背景图必须挂在**内层**上（而不是外框）
    load = preview[preview.index('    load(spec, opts = {})'):]
    load = load[:load.index('    /** 从头播。')]
    assert 'layer.style.backgroundImage' in load, '背景图要挂在内层'
    # 几何要写内层的尺寸与位置
    body = preview[preview.index('export function applyFrameGeometry'):]
    body = body[:body.index('\n}')]
    assert 'target.style.width' in body and 'target.style.height' in body, (
        '内层尺寸必须写成「一帧的大小」'
    )
    assert 'target.style.left' in body and 'target.style.top' in body, '内层要摆到居中 + 贴底'
    # 内层是自己造的，必须自己回收（否则每次重渲染都堆一层）
    dispose = preview[preview.index('    dispose() {'):]
    dispose = dispose[:dispose.index('\n    },')]
    assert 'removeChild' in dispose, 'dispose 要摘掉内层'


def test_preview_payload_carries_frame_size(routes_source):
    """`/preview` 必须下发单帧尺寸（否则面板拿不到横构图的真实比例）。"""
    body = routes_source[routes_source.index('def preview_pet('):]
    # 变体级与动作级都要有
    assert body.count("'size'") >= 2, '变体与动作条目都要带 size'
    assert "'size': variant.get('size')" in body, '变体级尺寸'
    assert "'size': entry.get('size')" in body, '动作级尺寸（变体缺失时的回落）'


def test_panel_resolves_preview_frame_size_with_the_shared_priority(panel):
    """面板取单帧尺寸的优先级必须与桌面宠物**同源**（`frameSizeOf`）。"""
    assert 'frameSizeOf' in panel, '必须复用 animation.js 的尺寸解析'
    assert "import { DEFAULT_SCHEDULE_MS, frameSizeOf } from './animation.js'" in panel
    body = panel[panel.index('function previewSpec()'):]
    body = body[:body.index('\n  /**')]
    assert 'frameSizeOf(base, entry, detail && detail.size)' in body, (
        '优先级必须是 变体 > 动作条目 > 包级'
    )
    assert 'size:' in body, '解析出来的尺寸要挂进预览 spec'


# ==================================================== 3. 空中不串动作


def test_petview_lands_on_touch_down_not_only_on_hard_impact(petview):
    """★ 落地判定必须用 `touchedDown`（状态翻转），不能只用 `justLanded`。

    用户报障的衍生现象：「如果不是以坠落动画落得地，那么就不会出现落地动画」。

    根因：`justLanded` 要求冲击 > 60px/s。从很低的地方放下（或贴着地面松手）
    冲击不足，于是状态机永远停在 `fall`——既没有落地动作，rAF 也永远停不下来
    （`fall` 属于「必须继续跑」的状态），表现为「宠物贴着地面一直播下落动画」。
    """
    body = petview[petview.index('function updateStateFromPhysics'):]
    body = body[:body.index('\n  }')]
    assert 'physics.touchedDown' in body, '必须用 touchedDown 判落地'
    assert 'machine.land(' in body, '触地要进 land 态'


def test_petview_blocks_ground_behaviors_while_airborne(petview):
    """★ 空中不允许推进漫游 / 打盹 / idle 触发。

    用户报障：「拖拽和坠落动画有时会被其他动画打断，然后在空中播放其他动画，
    例如左右移动，例如闲置，甚至还出现了在空中多个动画交替出现的情况」。

    根因：这些计时器都在 rAF 里按 dt 推进，而 `fall` 期间 rAF **正好在跑**
    （它是「必须继续跑」的状态）。于是坠落途中漫游到点就去 `startWalk()`、
    打盹到点就去 `sleep()`、idle 触发到点就直接改动作名。
    """
    body = petview[petview.index('function updateStateFromPhysics'):]
    body = body[:body.index('\n  }')]
    assert 'const airborne = !physics.grounded && !physics.dragging' in body, (
        '必须有明确的「空中」判定'
    )
    assert 'cancelIdleWake()' in body, '空中要撤掉已排好的 idle 触发'
    # 护栏必须**早于**漫游 / 打盹的推进（否则拦不住）
    assert body.index('if (airborne)') < body.index('walkTimer -= dt * 1000'), (
        '空中护栏必须挡在漫游倒计时之前'
    )
    assert body.index('if (airborne)') < body.index('lastSleepCheck = now'), (
        '空中护栏必须挡在打盹计时之前'
    )


def test_petview_idle_trigger_requires_being_grounded(petview):
    """idle 随机触发必须要求「站在地上」。

    点击后的小弹跳刻意**不**进 `fall` 态（否则落地动作会打断点击动画），
    于是弹跳期间状态是 idle 而宠物在空中。少了这条时，它会满足
    「idle 且无占用」并排下一次小动作，在**空中**播起待机动画。
    """
    body = petview[petview.index('function idleTriggerEnabled()'):]
    body = body[:body.index('\n  }')]
    assert 'physics.grounded' in body, 'idle 触发必须要求站在地上'


def test_petview_keeps_running_while_airborne(petview):
    """空中必须继续跑 rAF，否则宠物会**悬在半空不动**。

    点击弹跳期间状态是 idle/react 而 `physics.grounded` 为假。若循环
    直接返回 `!physics.resting`，它会在弹到最高点时停掉——宠物卡在空中，
    直到下一次交互才继续下落。
    """
    body = petview[petview.index('function shouldKeepRunning()'):]
    body = body[:body.index('\n  }')]
    assert 'if (!physics.grounded) return true' in body, '空中必须继续跑'


def test_statemachine_has_no_fall_to_idle_escape(statemachine):
    """★ `FALL` 的出口只有 `land` 与 `drag`——**没有** `idle`。

    那个 `IDLE` 正是「在空中播放其他动画」的入口：坠落期间任何**过期的
    定时器**只要调到 `settle()`，就能把宠物从 `fall` 直接拽进 `idle`，
    接着还能从 `idle` 走去 `walk` / `sleep`——看起来就是空中好几个动画轮流播。
    """
    assert '[STATES.FALL]: [STATES.LAND, STATES.DRAG]' in statemachine, (
        'FALL 的出口只能是 LAND / DRAG'
    )


def test_statemachine_semantic_entries_are_atomic(statemachine):
    """语义化入口必须**先确认迁移合法、再写动作名**。

    旧写法是「先写 `currentAction`、再 `transition`」：迁移被拒绝时动作名
    照样被改掉了，于是 `machine.state` 与 `machine.action` 脱节——状态还停在
    `fall`，动作名已经是 `idle`。读取 `machine.action` 的地方会得到
    自相矛盾的答案，而症状离原因非常远。
    """
    assert 'function enter(target, action, reason, meta)' in statemachine, (
        '必须有统一的原子入口'
    )
    body = statemachine[statemachine.index('function enter(target, action, reason, meta)'):]
    body = body[:body.index('\n  }')]
    # 顺序：先查合法性，再写动作名
    assert body.index('canTransition(state, target)') < body.index('currentAction = action'), (
        '必须先校验再改动作名'
    )
    # 所有语义化入口都要走它
    for name in ('beginDrag', 'release', 'land', 'settle', 'startWalk', 'stopWalk', 'sleep'):
        assert f'{name}(meta)' in statemachine, f'{name} 必须存在'
    assert statemachine.count('return enter(') >= 7, '语义化入口都应走 enter()'


def test_statemachine_react_queues_while_airborne(statemachine):
    """空中播报必须排队，不能在半空中抢动作名。"""
    body = statemachine[statemachine.index('react(action, meta = {})'):]
    body = body[:body.index('\n    },')]
    assert 'state === STATES.FALL' in body, 'fall 期间也要排队（与 drag 同等对待）'
    assert 'pendingReaction = name' in body, '要记下排队的播报'


def test_petview_guards_the_land_timer(petview):
    """落地动作的收尾定时器必须复核当前状态。

    它跨越了 `duration` 毫秒，期间用户完全可能又把它抓起来
    （`land` → `drag` 是合法迁移）。不复核的话，定时器随后仍会执行
    `settle()`——把**正在被拖拽**的宠物从 `drag` 拽进 `idle`，
    于是松手时它不进入 `fall`，直接在半空中播待机动画。
    """
    body = petview[petview.index('function updateStateFromPhysics'):]
    body = body[:body.index('\n  }')]
    timer = body[body.index('actionTimer = setTimeout('):]
    timer = timer[:timer.index('}, duration);')]
    assert 'machine.state !== STATES.LAND' in timer, '收尾前必须复核状态'


def test_petview_restores_idle_schedule_after_landing(petview):
    """空中撤掉的 idle 排期要在回到地面时补回来。

    点击弹跳**不产生任何状态迁移**（状态一直是 idle），而 `scheduleIdleWake()`
    只在状态迁移时重排。不补的话，宠物从此再也不自己动一下，直到用户点它。
    """
    assert 'let wasAirborne = false' in petview, '要记住上一帧是否在空中'
    body = petview[petview.index('function updateStateFromPhysics'):]
    body = body[:body.index('\n  }')]
    assert 'if (wasAirborne)' in body, '回到地面要识别这个边沿'
    assert 'scheduleIdleWake()' in body, '并把排期补回来'


# ==================================================== 4. 滑块与数字输入


def test_panel_sliders_accept_direct_number_input(panel):
    """★ 每个调节条都要能**直接输入数字**。

    用户报障：「目前的数字调节不够方便，通过拖拽有时难以精确调整，
    请同步支持直接选择数字部分进行输入修改，只要限制好输入数据的范围即可」。
    """
    assert 'function createSliderRow(' in panel, '必须有统一的「滑块 + 数字框」'
    assert 'function attachNumberBox(' in panel, '数字框要能挂到既有滑块上'
    assert "el('input', 'pet-slider-number')" in panel, '数字框要有自己的类名'
    assert "number.type = 'number'" in panel, '必须是 number 输入'


def test_panel_slider_row_wires_both_the_slider_and_the_number_box(panel):
    """★ 滑块**自己**的回调也必须接上，不能只给数字框接线。

    这个坑真实发生过：重构时只给数字框接了回调，把滑块的 `input`/`change`
    忘掉了——表现是「拖滑块完全没反应，数字框却好用」。
    由 `tools/verify-upload.mjs` 的 ⑲（拖滑块 → 宠物立刻变大）抓出来。
    """
    body = panel[panel.index('function createSliderRow(options)'):]
    body = body[:body.index('\n  /**')]
    assert "slider.addEventListener('input'" in body, '滑块自己的 input 必须接线'
    assert "slider.addEventListener('change'" in body, '滑块自己的 change 必须接线'
    # 两边共用同一份 push 逻辑，避免只有一边能用
    assert 'box.push(slider.value, false)' in body, '拖动只回显'
    assert 'box.push(slider.value, true)' in body, '松手才提交'


def test_panel_number_input_clamps_to_the_same_range(panel):
    """数字框与滑块必须共享**同一套夹取**，否则两边会给出不同的合法值。"""
    body = panel[panel.index('function createSliderRow(options)'):]
    body = body[:body.index('\n  /**')]
    assert 'Math.min(Math.max(base, min), max)' in body, '必须夹到区间内'
    # 数字框的 min/max 直接沿用滑块的，不另写一份
    attach = panel[panel.index('function attachNumberBox('):]
    attach = attach[:attach.index('\n  /**')]
    assert 'number.min = slider.min' in attach, '范围要与滑块一致'
    assert 'number.max = slider.max' in attach
    assert 'number.step = slider.step' in attach


def test_panel_number_input_commits_on_change_not_per_keystroke(panel):
    """数字框要**失焦 / 回车才提交**。

    每次按键都夹取的话，用户想输 `10000` 时打完 `1` 就被夹成下限，
    后面几位根本输不进去（真实踩过的输入框体验问题）。
    """
    attach = panel[panel.index('function attachNumberBox('):]
    attach = attach[:attach.index('\n  /**')]
    assert "number.addEventListener('change'" in attach, '失焦 / 回车才提交'
    assert "event.key === 'Enter'" in attach, '回车要能直接提交'
    # `input` 里绝不能发请求（只做视觉回显）
    handler = attach[attach.index("number.addEventListener('input'"):]
    handler = handler[:handler.index('});')]
    assert 'updateAppearance' not in handler, 'input 里不能提交'
    assert 'updateSchedule' not in handler, 'input 里不能提交'


def test_panel_slider_rows_keep_the_existing_dom_contract(panel):
    """新增的数字框不能破坏既有的 `data-` 契约（验收脚本靠它们定位）。"""
    for hook in (
        'slider.dataset.scheduleBehavior',
        'slider.dataset.scheduleBound',
        'slider.dataset.createSchedule',
        'slider.dataset.createScheduleBound',
    ):
        assert hook in panel, f'{hook} 是既有契约，不能丢'
    assert "speed.slider.dataset.previewSpeed = 'true'" in panel, '预览速度的标记不能丢'


def test_panel_schedule_slider_helpers_are_wired(panel):
    """触发时间的两个滑块各自都要配上数字框。"""
    body = panel[panel.index('function renderSchedule()'):]
    body = body[:body.index('\n  /**')]
    assert 'attachNumberBox(slider' in body, '触发时间滑块要有数字框'
    assert "el('div', 'pet-slider-row')" in body, '滑块与数字框要包成一行'
    create = panel[panel.index('function renderCreateSchedule()'):]
    create = create[:create.index('\n  /**')]
    assert 'attachNumberBox(slider' in create, '新建表单的滑块同样要有数字框'


def test_panel_scale_and_speed_use_the_shared_slider_row(panel):
    """倍率与预览速度要走统一的 `createSliderRow`（而不是各写一份）。"""
    appearance = panel[panel.index('function renderAppearance()'):]
    appearance = appearance[:appearance.index('\n  /**')]
    assert 'createSliderRow({' in appearance, '大小倍率要用统一的行'
    preview = panel[panel.index('function renderPreview()'):]
    preview = preview[:preview.index('\n  /**')]
    assert 'createSliderRow({' in preview, '预览速度要用统一的行'


def test_panel_slider_progress_variable_is_set(panel):
    """色带进度靠 `--pet-slider-progress`，必须由 JS 写入。

    原生 `input[type=range]` 没有「已选比例」这个可样式化的部分，
    只能由 JS 算出来交给 `linear-gradient`（与宿主的
    `--preset-editor-range-progress` 同一手法）。
    """
    assert 'function syncSliderProgress(' in panel
    assert "'--pet-slider-progress'" in panel, '变量名要与 CSS 对得上'
    body = panel[panel.index('function syncSliderProgress('):]
    body = body[:body.index('\n  }')]
    assert 'slider.style.setProperty' in body
    # 非法区间要给 0 而不是 NaN——NaN% 会让整条渐变失效（滑块看起来像坏了）
    assert 'span > 0' in body, '区间非法时要给 0'


def test_css_styles_the_slider_like_the_host_preset_editor(css):
    """调节条样式要与宿主「预设全屏编辑器」对齐（用户明确点名）。"""
    assert '.plugin-stm-pet .pet-slider {' in css, '滑块主规则必须在'
    assert 'appearance: none' in css, '必须自己画，否则各浏览器外观不一致'
    assert 'var(--pet-slider-progress, 0%)' in css, '色带要按进度变量绘制'
    # 宿主用的是 --accent-action；插件曾经写 --accent-color（宿主根本没定义）
    assert 'var(--accent-action, #7c5cff)' in css, '要用宿主真正存在的强调色变量'
    assert '--accent-color' not in css, '宿主没有定义 --accent-color，用了必然回落'
    # 手柄：`appearance: none` 之后不给形状的话手柄会整个消失
    assert '::-webkit-slider-thumb' in css, 'WebKit 手柄必须自己画'
    assert '::-moz-range-thumb' in css, 'Gecko 手柄必须自己画'
    assert ':focus-visible' in css, '键盘可达性不能丢'


def test_css_styles_the_card_selection_state(css):
    """★ 左侧卡片的**选中态**必须有样式。

    用户报障：「插件页面选中某个形象时，右侧已经发生了变化，但是左侧选中态
    却不跟着走，始终选中的是当前使用中的形象」。

    根因就是这里：`renderPetCard()` 两种类都加了（`is-selected` = 正在看、
    `is-active` = 正在用），但 CSS 里**只定义了 `.is-active`**，
    `.is-selected` 一条规则都没有——于是「正在看的」完全没有视觉反馈。
    """
    assert '.plugin-stm-pet .pet-card.is-selected' in css, '选中态必须有样式'
    assert '.plugin-stm-pet .pet-card.is-active' in css, '使用中的样式要保留'
    # 两者要能区分：选中态用 inset 色条（不占布局，不会让卡片抖）
    selected = css[css.index('.plugin-stm-pet .pet-card.is-selected'):]
    selected = selected[:selected.index('}')]
    assert 'box-shadow' in selected, '选中态要有明确的视觉记号'
    # 「当前使用中」的文字标记要显眼
    assert '.plugin-stm-pet .pet-card-meta.is-current' in css


def test_panel_marks_the_current_pet_meta(panel):
    """「当前使用中」的文字标记要带上 `is-current`（CSS 靠它上色）。"""
    assert "'pet-card-meta is-current'" in panel
    body = panel[panel.index('function renderPetCard(pet)'):]
    body = body[:body.index('\n  }')]
    assert "if (pet.id === selectedId) card.classList.add('is-selected')" in body, (
        '选中态要按 selectedId 打（不是 activeId）'
    )
    assert "if (pet.id === activeId) card.classList.add('is-active')" in body
    assert "'当前使用中'" in body


def test_css_preview_box_is_a_large_square(css):
    """预览框要是**正方形**——横竖构图都不偏袒。

    旧框是 112×168 的 2:3 竖框，恰好与站立动作同比例，所以一直没人发现问题；
    而躺姿睡觉是横构图（小卡是 627×353），横图被强行拉进竖框就压扁了。
    """
    body = css[css.index('.plugin-stm-pet .pet-preview-box {'):]
    body = body[:body.index('}')]
    assert 'width: 168px' in body, '要更大（用户要求「大一些的正方形框」）'
    assert 'height: 168px' in body, '必须是正方形'
    assert 'max-width: 100%' in body, '窄屏下不能撑破容器'
    # 内层是绝对定位的，外框必须是它的定位基准
    assert 'position: relative' in body, '外框要作为内层的定位基准'
    # 内层是直角矩形，不裁会盖住外框的圆角
    assert 'overflow: hidden' in body, '要裁掉内层溢出（保住圆角）'


def test_css_defines_the_preview_frame_layer(css):
    """内层必须有样式：它是「一帧的窗口」，背景铺在它身上。"""
    assert '.plugin-stm-pet .pet-preview-frame-layer' in css, '内层样式不能少'
    body = css[css.index('.plugin-stm-pet .pet-preview-frame-layer'):]
    body = body[:body.index('}')]
    assert 'position: absolute' in body, '内层靠绝对定位摆在框内'
    assert 'background-repeat: no-repeat' in body, '不能平铺（否则邻帧会重复出现）'
