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


def strip_js_comments(source):
    """剥掉 JS 的块注释与行注释（**字符串里的 `//` 不处理**，够用即可）。

    为什么要它：本文件里好几条断言查的是「代码里**不能**出现某个写法」，
    而解释「为什么不能这么写」的注释里**必然**会出现那个写法本身。
    不剥离的话这些断言会把文档当成违规——与 `test_css_contracts.py`
    里 `strip_comments` 记的是同一个坑。
    """
    code = re.sub(r'/\*.*?\*/', '', source, flags=re.DOTALL)
    code = re.sub(r'^\s*//.*$', '', code, flags=re.MULTILINE)
    return code


def test_petview_uses_the_scheduler_for_roam(petview):
    """★ 自动漫游的间隔必须来自后端下发的节奏，而不是写死的随机数。

    旧实现是 `walkTimer = 3000 + Math.random() * 6000`——写死的话
    「调整漫游触发时间」这个诉求就落不了地。
    """
    body = petview[petview.index('function scheduleRoamWake()'):]
    body = body[:body.index('\n  }')]
    assert "scheduler.reschedule('roam')" in body, (
        '漫游间隔要抽自调度器（可按形象配置）'
    )
    assert '3000 + Math.random() * 6000' not in petview, '写死的间隔必须去掉'


def test_roam_countdown_is_not_driven_by_raf(petview):
    """★★ 漫游的倒计时**必须**走 `setTimeout`，不能挂在 rAF 上。

    这是用户报的「漫游调到 200-300ms 结果半天触发不了」的根因：

    - 早先的实现在 `updateStateFromPhysics()` 里 `walkTimer -= dt * 1000`，
      而那个函数只在 rAF 循环运行时才跑；
    - 默认 idle 模式（`random`）下 `shouldKeepRunning()` 在「idle + 物理静止」
      时返回 false，**rAF 真的停掉**（省电契约，README §4.5）。

    两者合起来 → 倒计时永远不前进 → **漫游从不触发**。
    实测：漫游间隔设成 200~300ms，12 秒每 100ms 采样一次，状态全程停在
    `idle`、水平位移 0.0px。

    而 idle 的小动作走 `setTimeout`，所以它一切正常——「闲置看起来正常」
    正好掩盖了同一条路径上的漫游问题。

    这条测试因此要钉死两件事：倒计时**不在** rAF 里，且漫游有独立的定时器。

    注释要剥掉：解释这个 bug 的注释里**必然**会出现 `walkTimer -= dt` 本身。
    """
    code = strip_js_comments(petview)
    assert 'walkTimer -= dt' not in code, (
        '漫游倒计时不能放在 rAF 的 tick 里——rAF 在 idle 静止时是停的'
    )
    assert 'walkTimer = 2000' not in code, '那个写死的初始倒计时同样是 rAF 驱动的'
    assert 'roamWakeTimer' in code, '漫游要有自己的 setTimeout 定时器'
    body = code[code.index('function scheduleRoamWake()'):]
    body = body[:body.index('\n  }')]
    assert 'setTimeout(' in body, '漫游的排期必须走 setTimeout'
    # 与 idle 的定时器**分开**：两条路子互不排斥，共用会互相清掉排期
    assert 'idleWakeTimer' not in body, '漫游不能用 idle 的定时器变量'


def test_roam_wake_is_rescheduled_on_every_path_back_to_idle(petview):
    """★ 每一条「回到 idle」的路径都要重排漫游。

    漏掉任何一条的表现都是「走了一趟之后就再也不走了」——
    而它不会报错、也不会让任何功能测试失败，只会让宠物变呆。
    """
    # 状态迁移的集中钩子
    body = petview[petview.index('function onStateEnter(next)'):]
    body = body[:body.index('\n  }')]
    assert 'scheduleRoamWake()' in body, '进入 idle 要排漫游'
    assert 'cancelRoamWake()' in body, '离开 idle 要撤掉漫游'
    # 三条「不产生状态迁移 / 状态已被清掉」的补充路径
    assert 'scheduleRoamWake();' in petview
    assert petview.count('scheduleRoamWake()') >= 5, (
        '进入 idle / 小动作播完 / 落地补排 / 降频恢复 / 播报结束 都要重排'
    )
    assert 'cancelRoamWake();' in petview[petview.index('dispose() {'):], (
        '销毁时必须回收漫游定时器（它独立于 rAF，不回收会在视图销毁后触发）'
    )


def test_roam_wake_rearms_when_blocked_by_a_transient_reason(petview):
    """★ 到点但被**瞬时**原因挡住时要补排，否则那一趟永远丢了。

    与 `wasAirborne` 那条注释记的是同一个坑：手势没结束 / 小动作正在播
    都不会产生状态迁移，因此没有人会来重排。而「已经不在 idle」时**不**补排
    （那些路径回到 idle 时会由 `onStateEnter` 重排），免得睡着时还挂着定时器。
    """
    body = petview[petview.index('function scheduleRoamWake()'):]
    body = body[:body.index('\n  }\n')]
    assert 'machine.state === STATES.IDLE' in body, (
        '只在「还在 idle」时补排——已经离开 idle 的交给状态迁移'
    )


def test_roam_target_must_be_reachable(petview):
    """★★ 漫游目标必须落在宠物**够得着**的范围里。

    这是修好漫游之后立刻暴露出来的第二个 bug（比第一个更严重）。

    `physics.js` 把 x 夹在 `[半宽, 世界宽 - 半宽]` 里，撞到侧壁时把水平速度
    清零；而状态机退出 WALK 的条件是 `|x - walkTargetX| < 6`。
    早先的目标是 `40 + random * (宽 - 80)`——它假定宠物很窄，
    于是目标落在夹取范围之外时宠物**永远走不到**：

    - 卡在 WALK 态（看起来停在墙边不动）；
    - `shouldKeepRunning()` 对 WALK 恒返回 true → **rAF 永远跑着**，
      省电契约被破坏（最要紧的一条）；
    - `roamTriggerEnabled()` 要求 `state === IDLE` → **漫游再也不触发**。

    实测够不着的比例（世界宽 900，目标区间 [40, 860]）：

    | 宠物宽度 | 半宽 | 够不着的目标 |
    |---|---|---|
    | 64px | 32 | 0% |
    | 173px（内置形象 0.45 倍） | 86.5 | **11.3%** |
    | 384px（1 倍） | 192 | **37.1%** |
    | 768px（2 倍） | 384 | **83.9%** |

    **宠物越大越容易卡死**，而「放大宠物」正是用户最常调的一项。
    """
    code = strip_js_comments(petview)
    assert '40 + Math.random() * Math.max(1, world.width - 80)' not in code, (
        '不能再用写死的 40 / 80——它假定宠物很窄'
    )
    body = code[code.index('function pickWalkTarget('):]
    body = body[:body.index('\n  }')]
    assert 'physics.size' in body or 'size.width' in body, (
        '目标必须按宠物的**半宽**收窄'
    )
    assert 'WALK_TARGET_MARGIN' in body, '两侧要留余量，免得目标压在墙上抖动'
    # 宠物比屏幕还宽时不能返回一个够不着的目标（那正是卡死）
    assert 'worldWidth / 2' in body, '走不动时该停在中间'


def test_walk_state_has_a_stall_safety_net(petview):
    """★ 走不动时要能**自己结束**这一趟（兜底，保护省电契约）。

    正常路径是「走到目标附近就停」，但宠物可能永远走不到：撞墙时物理层
    把速度清零，而目标若够不着就再也不会满足 `|x - walkTargetX| < 6`。
    `pickWalkTarget()` 修的是根因，这里是兜底——屏幕尺寸变化、
    用户中途改大小、浮点边界都可能让它再次停住。

    卡在 WALK 的代价不只是「看起来不动了」：`shouldKeepRunning()` 对 WALK
    恒返回 true，于是 **rAF 永远跑着**（省电契约被破坏），而且漫游再也不触发。
    """
    code = strip_js_comments(petview)
    body = code[code.index('if (state === STATES.WALK) {'):]
    body = body[:body.index('\n    }')]
    assert 'WALK_STALL_SPEED' in body, (
        '要按「速度掉到接近 0」判定走不动，而不是只看「到没到目标」'
    )
    assert 'stopWalk' in body, '走不动时要真的退出 WALK 态'


def test_sleep_is_not_driven_by_raf(petview):
    """★★ 打盹判定**必须**走 `setTimeout`，不能只靠 rAF 里的低频轮询。

    与漫游那个 bug 是**同一类**：「时间驱动的行为，唯一的驱动源却是 rAF」。

    早先的实现只在 `updateStateFromPhysics()` 里查一次
    （`if (idleFor > sleepAfterMs()) machine.sleep()`），而那段代码只在
    rAF 循环运行时才跑、rAF 在 idle 静止时是停的。于是「到点睡着」实际靠
    **别的原因把 rAF 唤醒**才碰巧发生——通常是 idle 小动作（每 6~18 秒）。

    把 idle 间隔调大就会露出来。实测：idle 间隔 1 小时 + 打盹阈值 10 秒，
    22 秒后状态仍然是 `idle`（**永远不睡**）。而这条路径很常见：
    用户想让宠物安静就把 idle 调长，结果它连睡都不睡了。

    注释要剥掉：解释这个 bug 的注释里必然会出现旧写法本身。
    """
    code = strip_js_comments(petview)
    assert 'lastSleepCheck' not in code, (
        '那个低频轮询变量必须去掉——它只在 rAF 跑的时候才被检查'
    )
    assert 'sleepWakeTimer' in code, '打盹要有自己的 setTimeout 定时器'
    body = code[code.index('function scheduleSleepWake()'):]
    body = body[:body.index('\n  }')]
    assert 'setTimeout(' in body, '打盹的排期必须走 setTimeout'
    # 与另外两个定时器**分开**：三条路子互不排斥，共用会互相清掉排期
    assert 'idleWakeTimer' not in body and 'roamWakeTimer' not in body, (
        '打盹不能用 idle / 漫游的定时器变量'
    )
    # 到点时要**再查一次**阈值：等待期间可能有过交互（计时该被推后）
    assert 'lastInteractionAt' in body, (
        '到点时要复核「距上次交互多久」，否则交互过的宠物还是会按旧时间睡'
    )
    assert 'cancelSleepWake' in code[code.index('dispose() {'):], (
        '销毁时必须回收打盹定时器（它独立于 rAF，不回收会在视图销毁后触发）'
    )


def test_every_interaction_reschedules_sleep(petview):
    """★ 每一处「用户碰过它」都要把打盹计时推后。

    漏掉任何一条路径的表现都是「刚点完它，过一会儿它还是按原来的时间
    睡着了」——看起来像没理会用户的交互。
    """
    code = strip_js_comments(petview)
    body = code[code.index('function noteInteraction()'):]
    body = body[:body.index('\n  }')]
    assert 'lastInteractionAt = performance.now();' in body
    assert 'scheduleSleepWake()' in body
    # 除了 `noteInteraction()` **自己**那一次，别处不许直接赋值
    #（直接赋值不会重排打盹判定，表现为「刚点完它却还是按旧时间睡」）。
    assert code.count('lastInteractionAt = performance.now();') == 1, (
        '只能有一处直接赋值（noteInteraction 内部），其余都要走 noteInteraction()'
    )
    # 确实有多条交互路径（拖拽、点击、react、touch…）
    assert code.count('noteInteraction()') >= 5, (
        '交互路径有好几条（按下 / 拖拽 / 点击 / 播报 / touch），都要接上'
    )


def test_walk_target_biases_away_from_the_nearest_edge(petview):
    """★ 漫游目标要按**当前位置**偏置：越靠边越倾向于往回走。

    用户要求：「如果形象越偏向屏幕左侧，那么触发动画时有更高的概率往右走，
    反之亦然……这样可以避免总往一个方向走，更加符合随意走动的感觉」。

    纯均匀随机（原来的做法）的问题是宠物会**贴着某一侧反复挪**：
    它站在左边时，均匀随机给的目标有一半还在它左边，于是它一路蹭到墙上
    再蹭回来，看起来像被边缘吸住。

    实测（真实浏览器，384px 的宠物，跨度 500px）：
    - 最左边：80 次抽样 **100%** 的目标在右侧；最右边 99% 在左侧；
    - 正中：45~54%（仍接近 50/50——**不能**变成「永远回中间」，那就不随意了）；
    - 长程游走：边缘 10% 区间停留 **0~16%**（均匀随机对照 ~19%），
      中间 50% 区域 53~88%（对照 ~50%）；
    - 逐趟方向翻转率 58%，左右大致均衡。
    """
    code = strip_js_comments(petview)
    body = code[code.index('function pickWalkTarget('):]
    body = body[:body.index('\n  }')]
    assert 'bias' in body and 'physics.x' in body, (
        '目标要按当前位置（physics.x）算偏侧度'
    )
    # 往右的概率必须随「偏右」单调下降
    assert '(1 - bias) / 2' in body.replace(' ', '').replace('(1-bias)/2', '(1 - bias) / 2'), (
        '往右的概率应为 (1 - bias) / 2：最左 100% 往右，最右 0%'
    )


def test_walk_step_never_crosses_to_the_far_edge(petview):
    """★ 单步上限必须明显小于整个跨度。

    一步能从最左跨到最右的话，宠物会在两个边缘之间来回弹——实测那样
    「待在边缘 10% 区间」的时间反而升到 **38.8%**（比均匀随机的 20% 还差）。
    上限也不能太小，否则单步短到看不出在「走」，更像原地抖动。

    实测 0.10~0.35 在四种体型（64 / 173 / 384 / 768px）下表现一致。
    """
    code = strip_js_comments(petview)
    assert 'WALK_STEP_MIN_RATIO' in code and 'WALK_STEP_MAX_RATIO' in code
    # 常量本身要在合理区间里
    module = petview[:petview.index('export function createPetView')]
    for name, low, high in (
        ('WALK_STEP_MIN_RATIO', 0.05, 0.15),
        ('WALK_STEP_MAX_RATIO', 0.25, 0.45),
    ):
        match = re.search(rf'{name}\s*=\s*([0-9.]+)', module)
        assert match, f'找不到 {name}'
        value = float(match.group(1))
        assert low <= value <= high, (
            f'{name} = {value} 超出合理区间 [{low}, {high}]——'
            f'太大宠物会在边缘之间弹，太小看不出在走'
        )
    assert (
        float(re.search(r'WALK_STEP_MIN_RATIO\s*=\s*([0-9.]+)', module).group(1))
        < float(re.search(r'WALK_STEP_MAX_RATIO\s*=\s*([0-9.]+)', module).group(1))
    ), '下限必须小于上限'


def test_roam_exposes_its_target_for_verification(petview):
    """★ 目标 x 要能被外部读到（验收要靠它）。

    「目标选得对不对」是漫游观感的核心（方向偏置、够不够得着），
    而它无法从外部观测——只能看宠物走过去的结果，那既慢又受物理影响。
    """
    assert 'roamTarget' in petview, '视图要暴露 roamTarget'
    assert 'walkTargetX' in petview


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
    assert 'scheduleRoamWake()' in body, (
        '改完要重排漫游定时器（只改一个倒计时变量没用——那个变量挂在 rAF 上）'
    )


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
    # 几何函数必须接受并使用尺寸参数（末位 `dpr` 是可选的，只给单测用）。
    # 第二个参数是**网格几何** `{cols, rows}`（见 `animation.js:frameGrid`）——
    # 帧数不再单独传，它与网格形状一起决定「第 n 帧在哪一格」。
    assert 'export function applyFrameGeometry(box, grid, frames, index, size, layer, dpr)' in preview, (
        'applyFrameGeometry 必须接收网格几何、帧数、单帧尺寸与内层'
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
    # 背景图必须挂在**内层**上（而不是外框）。
    #
    # ⚠️ 它现在由 `draw()` 铺而不是 `load()`：多页时「第 0 帧在哪一页」
    # 要先算出来才知道该铺哪张图，而 `load()` 里还没有那个结论。
    # 因此判据是「铺图这件事发生在 draw 里、且写的是 layer」——
    # 钉死 `load()` 会把这次正确的搬移判成失败。
    draw = preview[preview.index('  function draw() {'):]
    draw = draw[:draw.index('\n  }')]
    assert 'node.style.backgroundImage' in draw, '背景图要在 draw 里铺（多页要先算页号）'
    assert 'layer || box' in draw, '背景图要优先挂在内层'
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
    # 导入行会随新增的导出而变，因此只查「从 animation.js 导入了 frameSizeOf」，
    # 不钉死整行——钉死整行会让每次加一个导出都要改这条测试
    # （而它真正要保护的是「尺寸解析同源」这件事）。
    match = re.search(r"import\s*\{([^}]*)\}\s*from\s*'\./animation\.js'", panel)
    assert match, '找不到从 animation.js 的导入'
    names = {name.strip() for name in match.group(1).split(',') if name.strip()}
    assert 'frameSizeOf' in names, '必须从 animation.js 导入 frameSizeOf'
    assert 'frameGrid' in names, '必须从 animation.js 导入 frameGrid'
    body = panel[panel.index('function previewSpec()'):]
    body = body[:body.index('\n  /**')]
    assert 'frameSizeOf(base, entry, detail && detail.size)' in body, (
        '优先级必须是 变体 > 动作条目 > 包级'
    )
    assert 'size:' in body, '解析出来的尺寸要挂进预览 spec'


def test_panel_normalizes_motion_before_reading_it(panel):
    """★ 面板读 `motion` 前必须**先规范化**。

    `entry.motion` / `spec.motion` 是后端下发的**原始形状**
    （`{breathe: {amplitude, periodMs}}`），而 `motionBreathes` /
    `motionBlinks` 吃的是**规范化后**的形状（`{amplitude, periodMs}`）。
    直接喂原始形状会恒为假——表现是「面板既不显示『程序化运动』那一条、
    预览器也不挂呼吸动画」，而桌面宠物一切正常（第一版就错在这里，
    真实浏览器验收当场抓到）。
    """
    assert 'normalizeMotion' in panel, '面板必须导入 normalizeMotion'
    # 每一处读 motion 的地方都要先规范化
    for match in re.finditer(r'(motionBreathes|motionBlinks)\((\w+)\)', panel):
        assert match.group(2) == 'motion', (
            f'{match.group(1)} 的入参必须是规范化后的 motion，实际是 {match.group(2)}'
        )
    assert panel.count('normalizeMotion(') >= 2, (
        'describeEntry 与预览元信息两处都要规范化'
    )


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

    ⚠️ 现在漫游与打盹都改走**各自的 `setTimeout`**（rAF 在 idle 静止时
    是停的，挂在它上面的倒计时永远不前进）。因此护栏不能只留在 rAF 那段
    代码里——**必须**同时写进各自的 `*TriggerEnabled()`，否则定时器到点时
    宠物可能正在空中（坠落中），照样会串动作。
    """
    body = petview[petview.index('function updateStateFromPhysics'):]
    body = body[:body.index('\n  }')]
    assert 'const airborne = !physics.grounded && !physics.dragging' in body, (
        '必须有明确的「空中」判定'
    )
    assert 'cancelIdleWake()' in body, '空中要撤掉已排好的 idle 触发'
    # 空中还要撤掉漫游与打盹的排期（它们现在走定时器，不撤就照样会到点）
    assert 'cancelRoamWake()' in body, '空中要撤掉已排好的漫游'
    assert 'cancelSleepWake()' in body, '空中要撤掉已排好的打盹判定'

    # ★ 关键：三个触发门都必须要求「站在地上」——定时器到点时再查一次，
    # 这才是真正的护栏（rAF 那段只是顺手撤排期）。
    for name in ('idleTriggerEnabled', 'roamTriggerEnabled', 'sleepTriggerEnabled'):
        guard = petview[petview.index(f'function {name}()'):]
        guard = guard[:guard.index('\n  }')]
        assert 'physics.grounded' in guard, (
            f'{name}() 必须要求站在地上，否则坠落途中定时器到点会串动作'
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
    assert "if (pet.id === selectedId && !creating) card.classList.add('is-selected')" in body, (
        '选中态要按 selectedId 打（不是 activeId），且**新建中不高亮任何形象**'
    )
    assert "if (pet.id === activeId) card.classList.add('is-active')" in body
    assert "'当前使用中'" in body


def test_panel_new_pet_does_not_leave_a_stale_selection(panel):
    """★ 新建形象时左侧不能还高亮着上一个形象。

    用户报障：「我点击新建形象后，右侧的内容已经变为新建的页面了，
    但是此时左侧还是选中之前的形象，而且我甚至可以选择别的形象，
    而右侧却没有任何变化，这个操作逻辑有点问题」。

    三件事缺一不可：
    1. 新建中**不**给任何已有形象打选中态；
    2. 列表最前面插一张「新建形象」的占位卡并选中它（让左右一致）；
    3. 切走时若填过内容要**问一句**（`confirmDiscardCreate`）。
    """
    # 1. 选中态带 `!creating` 守卫
    assert "pet.id === selectedId && !creating" in panel, '新建中不该高亮已有形象'
    # 2. 占位卡
    assert 'function renderCreatingCard' in panel, '缺少「新建形象」占位卡'
    assert "if (creating) {" in panel and 'renderCreatingCard()' in panel, (
        '占位卡要插进列表'
    )
    assert "card.dataset.petId = '__creating__'" in panel, '占位卡要有可识别的 id'
    # 3. 切走要确认（而不是静默丢掉或静默无视）
    assert 'function confirmDiscardCreate' in panel
    assert 'function hasDraftContent' in panel, '要知道「填过东西没有」才谈得上问不问'
    assert 'if (creating && hasDraftContent())' in panel, '切形象时没有走确认分支'
    # 用面板内的确认条，**不用**原生对话框（无头浏览器里它恒为 false，
    # 验收脚本会因此永远走不到确认那条路）
    for native in ('window.confirm', 'window.alert', 'window.prompt'):
        assert native not in panel, f'不要用原生 {native}（无头浏览器里没法点）'


def test_panel_create_form_has_an_abandon_button(panel):
    """★ 新建表单要有**放弃**入口，且放弃前问一句（填过内容时）。

    用户：「我如果不想新建形象了，那还必须得先关闭模态框，然后重新打开
    才能访问已有形象」。因此必须有一个**不用关面板**就能退出的按钮。
    """
    assert "button('放弃新建'" in panel, '缺少「放弃新建」按钮'
    body = panel[panel.index('function renderCreate'):]
    assert 'abandonCreate()' in body, '放弃要走统一的清理函数'
    assert 'if (!hasDraftContent())' in body, '空表单应当直接丢（省一次点击）'
    assert 'pendingConfirm' in body, '填过内容时要走确认'


def test_panel_abandon_create_clears_every_draft_field(panel):
    """`abandonCreate` 必须把**所有**草稿字段清干净。

    漏一个的表现：下次点「新建形象」时表单里还留着上次填的名字/图，
    而用户以为那是新的空表单——上传时才发现「怎么已经有一张图了」。
    """
    body = panel[panel.index('function abandonCreate'):]
    body = body[:body.index('\n  }')]
    for field in ('draftName', 'draftAuthor', 'draftStill', 'draftSchedule',
                  'draftScale', 'draftPixelated', 'pendingConfirm', 'notice'):
        assert f'{field} =' in body, f'abandonCreate 没有清理 {field}'
    assert 'creating = false' in body


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
