"""本轮四项诉求的契约：**标准图像**、**重名**、**作者署名**、**触发时间**。

逐条对应：

1. **标准图像**——不播动画时显示的那一帧。内置形象的 idle 挂了两套动画
   （待机 + 张望），而「静止」原本沿用「上一次抽到的变体的第 0 帧」，
   于是随机播到张望之后就卡在**抬头看**的姿势上。修法是引入独立的标准图像。
2. **重名**——内置形象与用户形象同名时怎么办。
3. **作者署名**——自定义宠物要能设作者名，方便发布。
4. **触发时间**——只有**由时间驱动**的行为能设间隔（idle / roam）。

这些是前后端之间的契约，因此每一项都要有测试钉住。
"""

import io
import json
import os
import shutil
import sys
import zipfile

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from backend.core.pack import (  # noqa: E402
    ACTION_FALLBACKS,
    BEHAVIOR_FIELDS,
    DEFAULT_SCHEDULE_MS,
    SCHEDULE_BEHAVIORS,
    SLEEP_AFTER_RANGE,
    STILL_ACTION,
)
from backend.core.errors import PetError  # noqa: E402
from backend.core.store import PetStore  # noqa: E402
from fake_api import FakeApi, build_app  # noqa: E402
from pet_test_support import make_image_bytes, write_pack  # noqa: E402


def json_of(response):
    return json.loads(response.data.decode('utf-8'))


@pytest.fixture
def env(tmp_path):
    """一个带**双套 idle 动画**的形象（正是「卡在抬头帧」的场景）。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)

    write_pack(builtin, 'posed', payload={
        'id': 'posed',
        'name': '双套待机',
        'size': {'w': 64, 'h': 64},
        'still': {'sheet': 'idle.png', 'frames': 4, 'frame': 0},
        'animations': {
            'idle': {'variants': [
                {'sheet': 'idle.png', 'frames': 4, 'weight': 5},
                # 第二套：首帧是个抬头姿势（原来是内置形象的「张望」），
                # 绝不该被当成静止画面。文件名按多套命名规范写。
                {'sheet': 'idle-v2.png', 'frames': 4, 'weight': 2},
            ]},
        },
    }, sheets={'idle.png': 4, 'idle-v2.png': 4})

    store = PetStore(str(data), str(builtin))
    api = FakeApi(data_dir=str(data))
    app = build_app(api, store)
    return app, store, app.test_client(), api


# ============================================================ 1. 标准图像


def test_still_is_not_the_last_played_variant(env):
    """★ 标准图像必须是**固定的一帧**，与「这次抽到哪一套」无关。

    这条是本轮的核心：旧实现里「静止」=「上一次抽到的变体的第 0 帧」，
    于是随机播到「张望」之后就卡在抬头看那一帧上（用户报的「看起来怪怪的」）。
    """
    _app, store, _client, _api = env
    payload = store.runtime_pack('posed')
    still = payload['still']

    idle_variants = payload['actions']['idle']['variants']
    assert len(idle_variants) == 2, '这个形象必须有两套 idle 动画才算覆盖到场景'

    # URL 是**不透明**的（`/frame/<pet>/<action>?vi=n`），因此要验的是它
    # 背后解析到的文件，而不是 URL 文本里有没有文件名。
    second_path, _source = store.resolve_frame_path('posed', 'idle', variant=1)
    still_path, _source = store.resolve_frame_path('posed', STILL_ACTION)
    assert second_path.endswith('idle-v2.png'), '第二套确实是那套抬头动画'
    assert still_path.endswith('idle.png'), (
        '标准图像绝不能是第二套那套——那正是卡在抬头帧的成因'
    )
    assert still['declared'] is True
    assert still['source'] == STILL_ACTION


def test_still_falls_back_when_not_declared(tmp_path):
    """没声明 `still` 的包仍然能用（回落 idle 首帧），但要标明是回落的。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    write_pack(builtin, 'plain', payload={
        'id': 'plain',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 2}},
    }, sheets={'idle.png': 2})
    store = PetStore(str(data), str(builtin))

    still = store.runtime_pack('plain')['still']
    assert still['url'], '回落后仍要有可画的图'
    assert still['declared'] is False, '必须标明这是回落值，面板要据此提示'
    assert still['frames'] == 2
    assert still['source'] == 'idle', '要标明来源是 idle'


def test_still_frame_offset_reaches_the_frontend(tmp_path):
    """`frame` 要下发到前端——它决定从 sheet 的哪一帧开始画。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 4}},
    }, sheets={'idle.png': 4})

    # 换成取第 3 帧
    store.update_pet_meta('mine', still={'sheet': 'idle.png', 'frames': 4, 'frame': 2})
    still = store.runtime_pack('mine')['still']
    assert still['frame'] == 2
    assert still['frames'] == 4


def test_effective_pixelated_survives_a_broken_pack(tmp_path):
    """★ 解析失败时 `effective_pixelated` 必须回落到默认值，而不是抛 `NameError`。

    实测（静态检查发现的）：异常分支里引用了 `DEFAULT_PIXELATED`，但它没被 import。
    这条路径平时走不到（只在包损坏时），因此单测不覆盖的话会一直藏着——
    而它一旦触发，表现是「形象列表整个打不开」。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    broken = builtin / 'broken'
    broken.mkdir(parents=True)
    (broken / 'pet.json').write_text('{ not json', encoding='utf-8')

    store = PetStore(str(data), str(builtin))
    # 不抛异常即可（值本身是默认的平滑渲染）
    assert store.effective_pixelated('broken') is False


def test_still_inherits_size_from_its_source_sheet(env):
    """★ 标准图像的**几何**必须跟着它自己那条 sheet 走。

    这是「标准图像」与「逐动作尺寸」两个特性**合到一起**才暴露的问题：
    各自单独存在时都看不出——因此它是在合并两条分支时才被发现并修掉的。

    场景：作者把躺姿（横构图 627×353）的某一帧设为标准图像。若不带尺寸，
    前端只能用**当前动作**的几何（竖构图 384×576）去铺它，横构图的图
    会被按竖构图拉伸（实测失真 62%）。

    这里验的是「作者没写 `size` 时能**从 sheet 反推**」——反推不成立的话，
    作者从横构图 sheet 里挑一帧时就必须记得再写一遍 `size`，忘了就变形，
    而那正是「逐动作尺寸」这个特性要解决的同一个问题。
    """
    _app, store, _client, _api = env
    write_pack(store.user_pets_dir(), 'cross', payload={
        'id': 'cross',
        'name': '交叉',
        'size': {'w': 384, 'h': 576},
        'animations': {
            'idle': {'sheet': 'idle.png', 'frames': 1},
            # 躺姿：横构图，且**声明了自己的尺寸**
            'sleep': {'sheet': 'sleep.png', 'frames': 1, 'size': {'w': 627, 'h': 353}},
        },
        # 标准图像取自躺姿那条 sheet，但**没写** size
        'still': {'sheet': 'sleep.png', 'frames': 1, 'frame': 0},
    }, sheets={'idle.png': 1, 'sleep.png': 1})

    runtime = store.runtime_pack('cross')
    assert runtime['still']['size'] == {'w': 627, 'h': 353}, (
        '标准图像应当从来源 sheet 反推出尺寸'
    )
    # 没有 size 的动作仍然不写字段（老行为不变）
    assert 'size' not in runtime['actions']['idle']


def test_still_explicit_size_wins_over_inference(env):
    """作者**显式**写了 `still.size` 时以它为准（反推只是兜底）。"""
    _app, store, _client, _api = env
    write_pack(store.user_pets_dir(), 'explicit', payload={
        'id': 'explicit',
        'name': '显式',
        'animations': {
            'idle': {'sheet': 'idle.png', 'frames': 1, 'size': {'w': 627, 'h': 353}},
        },
        'still': {'sheet': 'idle.png', 'frames': 1, 'size': {'w': 200, 'h': 300}},
    }, sheets={'idle.png': 1})

    runtime = store.runtime_pack('explicit')
    assert runtime['still']['size'] == {'w': 200, 'h': 300}


def test_still_fallback_inherits_idle_size(env):
    """回落路径（没声明 still）要**继承 idle 那条 sheet 的尺寸**。

    idle 声明了自己的 `size` 时，标准图像与它同源，几何必须一致——
    否则静止画面与待机动画会互相错位（一个按包级铺、一个按动作级铺）。
    """
    _app, store, _client, _api = env
    write_pack(store.user_pets_dir(), 'fallback', payload={
        'id': 'fallback',
        'name': '回落',
        'size': {'w': 384, 'h': 576},
        'animations': {
            'idle': {'sheet': 'idle.png', 'frames': 1, 'size': {'w': 500, 'h': 250}},
        },
    }, sheets={'idle.png': 1})

    runtime = store.runtime_pack('fallback')
    assert runtime['still']['declared'] is False
    assert runtime['still']['size'] == {'w': 500, 'h': 250}, (
        '回落自 idle 的标准图像要继承 idle 的尺寸'
    )


def test_still_without_any_size_stays_absent(env):
    """完全没有尺寸信息时**不写** `size` 字段（前端回落到包级）。

    凭空补一个包级尺寸进 payload 会让「作者到底声明了没有」变得不可知，
    也会让老前端的输出对比测试全部失效。
    """
    _app, store, _client, _api = env
    write_pack(store.user_pets_dir(), 'plain', payload={
        'id': 'plain',
        'name': '朴素',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 1}},
        'still': {'sheet': 'idle.png', 'frames': 1},
    }, sheets={'idle.png': 1})

    runtime = store.runtime_pack('plain')
    assert 'size' not in runtime['still']


def test_still_size_survives_pack_roundtrip(env):
    """`still.size` 要能原样写回 `pet.json`（导出形象包时不能丢）。"""
    _app, store, _client, _api = env
    write_pack(store.user_pets_dir(), 'round', payload={
        'id': 'round',
        'name': '往返',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 1}},
        'still': {'sheet': 'idle.png', 'frames': 1, 'size': {'w': 627, 'h': 353}},
    }, sheets={'idle.png': 1})

    with open(os.path.join(store.user_pets_dir(), 'round', 'pet.json'),
              encoding='utf-8') as handle:
        stored = json.load(handle)
    assert stored['still']['size'] == {'w': 627, 'h': 353}


def test_still_size_is_optional_and_validated(env):
    """`still.size` 的取值校验与动作级 `size` 一致（复用同一个解析器）。

    注意校验发生在**加载**时（`write_pack` 只写文件、不解析），
    因此这里要真的去读一次运行期定义。
    """
    _app, store, _client, _api = env
    # 非对象 → 报错
    write_pack(store.user_pets_dir(), 'bad1', payload={
        'id': 'bad1',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 1}},
        'still': {'sheet': 'idle.png', 'size': 'big'},
    }, sheets={'idle.png': 1})
    with pytest.raises(PetError) as info:
        store.runtime_pack('bad1')
    assert 'still.size' in str(info.value)

    # 超过单帧上限 → 报错（并提示「这是逻辑尺寸、不是源图像素尺寸」）
    write_pack(store.user_pets_dir(), 'bad2', payload={
        'id': 'bad2',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 1}},
        'still': {'sheet': 'idle.png', 'size': {'w': 4000, 'h': 4000}},
    }, sheets={'idle.png': 1})
    with pytest.raises(PetError) as info:
        store.runtime_pack('bad2')
    # 提示在 `hint` 里（面向作者的补充说明），不拼进 `msg`
    assert '逻辑显示尺寸' in info.value.hint
    assert '源图像素尺寸' in info.value.hint


def test_builtin_still_geometry_is_pixel_exact():
    """★ 内置形象的标准图像**切帧几何**必须精确，且不能是「张望」那一帧。

    前端 `drawStill()` 的规则是 `background-size = 单帧宽 × 帧数`、
    `background-position = -frame × 单帧宽`。这里按同一套规则裁出实际会显示的
    那一块，与「直接裁第 frame 帧」逐像素比对。

    为什么要这么验：几何算错时界面**看着有图**，只是显示的是**别的帧**——
    比空白难查得多（用户报的「卡在抬头看」本质就是「显示了不该显示的那一帧」）。
    """
    from PIL import Image

    builtin = os.path.join(REPO_ROOT, 'resources', 'pets')
    for pet_id in ('xiaoman', 'xiaoka'):
        pet_dir = os.path.join(builtin, pet_id)
        with open(os.path.join(pet_dir, 'pet.json'), encoding='utf-8') as handle:
            manifest = json.load(handle)
        still = manifest['still']
        sheet_path = os.path.join(pet_dir, still['sheet'])
        frames = int(still['frames'])
        frame = int(still.get('frame', 0))

        sheet = Image.open(sheet_path).convert('RGBA')
        single = sheet.width // frames

        def crop(at):
            return sheet.crop((at * single, 0, (at + 1) * single, sheet.height))

        shown = crop(frame)
        # 与 **idle 第二套**（原「张望」）的首帧对比：**必须不同**，否则就白修了。
        #
        # ⚠️ 这里原来读的是 `look.png`。`look` 动作已于 2026-10 删除——
        # 那个动作够不着（没有任何路径能进入它），而那张图一直是以
        # `idle` 第二套的身份在用的。现在文件叫 `idle-v2.png`，
        # 因此这条断言要跟着改（语义没变：仍然是「标准图像不能是抬头那一下」）。
        second = manifest['animations']['idle']['variants'][1]['sheet']
        other_path = os.path.join(pet_dir, second)
        assert os.path.isfile(other_path), f'{pet_id} 缺少 {second}'
        other = Image.open(other_path).convert('RGBA')
        other_single = other.width // frames
        other_first = other.crop((0, 0, other_single, other.height))
        assert shown.tobytes() != other_first.tobytes(), (
            f'{pet_id} 的标准图像与 idle 第二套（张望）首帧相同'
            '——正是要避免的抬头姿势'
        )
        # 声明的就是 idle 第 0 帧：应当逐像素相同
        assert frame == 0
        assert shown.tobytes() == crop(0).tobytes()


def test_still_url_is_served_by_the_frame_route(env):
    """★ 标准图像走**同一条**图片路由，因此缓存与路径安全都自动成立。"""
    _app, store, client, _api = env
    still = store.runtime_pack('posed')['still']
    assert f'/{STILL_ACTION}' in still['url']
    response = client.get(still['url'])
    assert response.status_code == 200
    assert len(response.data) > 0
    assert response.headers.get('X-Pet-Frame-Source') == 'builtin'


def test_still_can_be_updated_for_a_user_pet(tmp_path):
    """用户能改自己形象的标准图像（内置形象则不能，见只读契约）。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 4}},
    }, sheets={'idle.png': 4})

    # 先单独上传一张标准图像
    store.update_pet_meta('mine', still={
        'data': make_image_bytes(size=(64, 64), color=(9, 9, 9, 255)),
        'frames': 1,
    })
    pack_dir = store.user_pet_dir('mine')
    with open(os.path.join(pack_dir, 'pet.json'), encoding='utf-8') as handle:
        manifest = json.load(handle)
    assert manifest['still']['sheet'].startswith('still.')
    assert os.path.isfile(os.path.join(pack_dir, manifest['still']['sheet']))
    assert store.runtime_pack('mine')['still']['declared'] is True

    # 再清除它 → 回落到 idle 首帧
    store.update_pet_meta('mine', still={})
    with open(os.path.join(pack_dir, 'pet.json'), encoding='utf-8') as handle:
        manifest = json.load(handle)
    assert 'still' not in manifest
    assert store.runtime_pack('mine')['still']['declared'] is False


def test_overriding_idle_also_updates_a_fallen_back_still(tmp_path):
    """★ 换掉 `idle` 的图时，**回落自 idle 的标准图像**必须跟着换。

    实测踩到过：用户换掉待机图之后，面板缩略图（走标准图像）与桌面宠物
    （走 idle）显示的是**两张不同的图**——因为标准图像那条路没读覆盖目录。
    这类不一致极难查：两边都「有图」，只是不是同一张。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 2}},
    }, sheets={'idle.png': 2})

    before, before_source = store.resolve_frame_path('mine', STILL_ACTION)
    assert before_source == 'pack'

    # 覆盖 idle
    store.save_action_image('mine', 'idle', make_image_bytes(size=(64, 64), color=(3, 3, 3, 255)))

    still_path, still_source = store.resolve_frame_path('mine', STILL_ACTION)
    idle_path, idle_source = store.resolve_frame_path('mine', 'idle')
    assert still_source == 'override', '标准图像必须跟着走覆盖'
    assert still_path == idle_path, (
        '回落自 idle 的标准图像必须与 idle 解析到**同一张图**'
    )
    assert still_path != before


def test_declared_still_is_independent_of_idle_override(tmp_path):
    """★ 作者**显式声明**了标准图像时，换 idle 的图**不该**影响它。

    两者是独立的声明——这正是标准图像存在的意义（作者明确指定了「门面」）。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine',
        'still': {'sheet': 'calm.png', 'frames': 1},
        'animations': {
            'idle': {'sheet': 'idle.png', 'frames': 2},
            'click': {'sheet': 'calm.png', 'frames': 1},
        },
    }, sheets={'idle.png': 2, 'calm.png': 1})

    store.save_action_image('mine', 'idle', make_image_bytes(size=(64, 64), color=(3, 3, 3, 255)))

    still_path, still_source = store.resolve_frame_path('mine', STILL_ACTION)
    idle_path, _source = store.resolve_frame_path('mine', 'idle')
    assert still_source != 'override', '声明的标准图像不该被 idle 的覆盖带走'
    assert still_path != idle_path
    assert still_path.endswith('calm.png')


def test_still_has_its_own_override_slot(tmp_path):
    """作者声明的标准图像也支持单独换图（`overrides/still.<ext>`）。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine',
        'still': {'sheet': 'calm.png', 'frames': 1},
        'animations': {
            'idle': {'sheet': 'idle.png', 'frames': 2},
            'click': {'sheet': 'calm.png', 'frames': 1},
        },
    }, sheets={'idle.png': 2, 'calm.png': 1})

    store.save_action_image('mine', STILL_ACTION, make_image_bytes(size=(64, 64)))
    _path, source = store.resolve_frame_path('mine', STILL_ACTION)
    assert source == 'override'
    assert STILL_ACTION in store.runtime_pack('mine')['overrides']


def test_still_reuse_action_frame_writes_no_extra_file(tmp_path):
    """★ 「复用某个动作的某一帧」**不额外落盘**。

    作者常觉得「idle 的第 3 帧就是我要的姿势」，为此再存一张一模一样的图
    既费事又费空间。这条路径直接指向那个动作的 sheet。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 4}},
    }, sheets={'idle.png': 4})

    store.update_pet_meta('mine', still={'action': 'idle', 'frame': 2})
    pack_dir = store.user_pet_dir('mine')
    names = sorted(os.listdir(pack_dir))
    assert 'still.png' not in names, f'不该多出一个文件：{names}'
    still = store.runtime_pack('mine')['still']
    assert still['frame'] == 2
    assert still['frames'] == 4


def test_still_is_editable_via_the_meta_route(env):
    """面板改标准图像走 `/meta`（写进 pet.json，不是覆盖图）。"""
    _app, store, client, _api = env
    # 先把内置形象「另存」成一个可写的用户形象
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 4}},
    }, sheets={'idle.png': 4})

    response = client.post(
        '/api/plugins/stm-pet/pets/mine/meta',
        json={'still': {'action': 'idle', 'frame': 1}},
    )
    assert response.status_code == 200
    assert json_of(response)['pet']['still']['frame'] == 1

    # 内置形象仍然不可改
    refused = client.post(
        '/api/plugins/stm-pet/pets/posed/meta',
        json={'still': {'action': 'idle', 'frame': 1}},
    )
    assert refused.status_code == 403


# ================================================================ 2. 重名


def test_user_pet_may_share_a_name_with_a_builtin(tmp_path):
    """★ **允许重名**：用户形象可以与内置形象叫同一个名字。

    重名本身不是错误——两个人各自做一个「小猫」很正常，
    插件要保证的是**技术上的不冲突**（id 唯一），而不是禁止重名。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    write_pack(builtin, 'official-cat', payload={
        'id': 'official-cat',
        'name': '小猫',
        'author': '官方',
        'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'my-cat', payload={
        'id': 'my-cat',
        'name': '小猫',
        'author': '我',
        'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    items = store.list_pets()
    same_name = [item for item in items if item['name'] == '小猫']
    assert len(same_name) == 2, '同名形象应当都在列表里'
    # 靠 **id 与作者** 区分，而不是靠名字
    assert {item['id'] for item in same_name} == {'official-cat', 'my-cat'}
    assert {item['author'] for item in same_name} == {'官方', '我'}
    # 两者都可用
    for item in same_name:
        assert not item['error'], f'{item["id"]} 不该因为重名而出错'
        assert store.runtime_pack(item['id'])['id'] == item['id']


def test_importing_a_pet_whose_id_collides_gets_a_new_id(tmp_path):
    """★ 重名的**包**（连 id 都一样）导入时自动分配新 id，不覆盖。

    覆盖别人的形象是破坏性操作，绝不能默默发生。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    write_pack(builtin, 'official-cat', payload={
        'id': 'official-cat',
        'name': '官方小猫',
        'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})
    store = PetStore(str(data), str(builtin))

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('pet.json', json.dumps({
            'id': 'official-cat',  # 故意撞上内置 id
            'name': '我的小猫',
            'author': '我',
            'animations': {'idle': 'idle.png'},
        }, ensure_ascii=False))
        archive.writestr('idle.png', make_image_bytes(size=(64, 64)))

    imported = store.import_zip(buffer.getvalue())
    assert imported['id'] != 'official-cat', '撞上内置 id 时必须改名'
    assert imported['name'] == '我的小猫'
    assert imported['author'] == '我'
    # 内置那份**一个字节都没动**
    assert store.load_pack('official-cat').name == '官方小猫'


def test_import_replace_overwrites_only_a_user_pet(tmp_path):
    """`replace` 只覆盖**用户自己的**形象，绝不动内置的。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    write_pack(builtin, 'official-cat', payload={
        'id': 'official-cat', 'name': '官方小猫',
        'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})
    store = PetStore(str(data), str(builtin))

    def pack_bytes(pet_id, name):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('pet.json', json.dumps({
                'id': pet_id, 'name': name,
                'animations': {'idle': 'idle.png'},
            }, ensure_ascii=False))
            archive.writestr('idle.png', make_image_bytes(size=(64, 64)))
        return buffer.getvalue()

    # 第一次导入（id 撞内置 → 改名）
    first = store.import_zip(pack_bytes('official-cat', '我的小猫'))
    # 带 replace 再导入同名 id → 覆盖**用户**那一份
    second = store.import_zip(pack_bytes(first['id'], '我的小猫 v2'), replace=True)
    assert second['id'] == first['id']
    assert second['name'] == '我的小猫 v2'
    # 内置那份仍然完好
    assert store.load_pack('official-cat').name == '官方小猫'


def test_duplicate_names_are_reported_not_hidden(tmp_path):
    """列表要把作者一起给出来——否则重名时用户根本分不清哪个是哪个。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    write_pack(builtin, 'a', payload={
        'id': 'a', 'name': '同名', 'author': '甲',
        'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})
    write_pack(builtin, 'b', payload={
        'id': 'b', 'name': '同名', 'author': '乙',
        'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    store = PetStore(str(data), str(builtin))
    items = {item['id']: item for item in store.list_pets()}
    assert items['a']['author'] == '甲'
    assert items['b']['author'] == '乙'


# ============================================================ 3. 作者署名


def test_builtin_pets_are_authored_by_official():
    """内置形象的作者写「官方」（用户明确要求）。"""
    builtin = os.path.join(REPO_ROOT, 'resources', 'pets')
    store = PetStore(os.path.join(REPO_ROOT, 'data'), builtin)
    for pet_id in ('xiaoman', 'xiaoka'):
        pack = store.load_pack(pet_id)
        assert pack.author == '官方', f'{pet_id} 的作者应为「官方」，实际 {pack.author!r}'
        # 运行期与列表接口都要带上作者（面板要显示）
        assert store.runtime_pack(pet_id)['author'] == '官方'
        item = next(i for i in store.list_pets() if i['id'] == pet_id)
        assert item['author'] == '官方'


def test_create_pet_records_the_author(tmp_path):
    """★ 新建形象时能设作者名（用户要求：方便其他人制作宠物发布）。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))

    created = store.create_pet(
        '我的宠物',
        {'idle': {'data': make_image_bytes(size=(64, 64)), 'frames': 1}},
        author='某位作者',
    )
    assert created['author'] == '某位作者'
    # 落进 pet.json（导出时会带走，因此别人能看到）
    with open(os.path.join(store.user_pet_dir(created['id']), 'pet.json'),
              encoding='utf-8') as handle:
        manifest = json.load(handle)
    assert manifest['author'] == '某位作者'


def test_create_pet_author_is_always_written(tmp_path):
    """作者字段**总是**写出来（哪怕是空串）。

    靠字段缺失去表达「没有作者」的话，面板就没法区分
    「作者留空了」与「这个包是旧格式」。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))

    created = store.create_pet(
        '匿名宠物',
        {'idle': {'data': make_image_bytes(size=(64, 64)), 'frames': 1}},
    )
    with open(os.path.join(store.user_pet_dir(created['id']), 'pet.json'),
              encoding='utf-8') as handle:
        manifest = json.load(handle)
    assert 'author' in manifest
    assert manifest['author'] == ''


def test_author_survives_export_and_import(tmp_path):
    """★ 作者署名必须跟着**导出再导入**走。

    否则「发布宠物」这件事就断了：作者署了名，别人导入后看不到。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'name': '我的宠物', 'author': '原作者',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 2}},
    }, sheets={'idle.png': 2})

    blob = store.export_pet('mine')
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        manifest = json.loads(archive.read('pet.json').decode('utf-8'))
    assert manifest['author'] == '原作者', '导出的包里必须带作者'

    # 换一个干净的库导入
    other_data = tmp_path / 'data2'
    other_data.mkdir()
    other = PetStore(str(other_data), str(builtin))
    imported = other.import_zip(blob)
    assert imported['author'] == '原作者'


def test_author_can_be_edited_and_cleared(tmp_path):
    """作者可以改、也可以清空（`author: ''` 是合法值，不是「不改」）。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'author': '旧作者',
        'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    assert store.update_pet_meta('mine', author='新作者')['author'] == '新作者'
    assert store.update_pet_meta('mine', author='')['author'] == ''
    # `None` 表示「不改」
    assert store.update_pet_meta('mine', author='甲')['author'] == '甲'
    assert store.update_pet_meta('mine')['author'] == '甲'


def test_builtin_author_is_read_only(tmp_path):
    """内置形象的作者不可改（它是随包资源）。"""
    from backend.core.errors import CODE_BUILTIN_READONLY, PetError

    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    write_pack(builtin, 'official', payload={
        'id': 'official', 'author': '官方',
        'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})
    store = PetStore(str(data), str(builtin))

    with pytest.raises(PetError) as info:
        store.update_pet_meta('official', author='我')
    assert info.value.code == CODE_BUILTIN_READONLY


# ============================================================ 4. 触发时间


def test_schedule_covers_only_time_driven_behaviors():
    """可设置触发时间的行为只有三个（与 pack 的名单一致）。

    `sleep` 是后加的：用户要求把「睡觉」也加进触发时间设置里
    （「多长时间不管就睡觉」）。它的形状与另外两个**不同**——
    是**阈值**而不是区间（见 `BEHAVIOR_FIELDS`）。
    """
    assert list(SCHEDULE_BEHAVIORS) == ['idle', 'roam', 'sleep']
    # `sleep` 只有 `afterMs`：没有 intervalMs / mode / plays。
    assert BEHAVIOR_FIELDS['sleep'] == ('afterMs',), (
        'sleep 是阈值，不该有区间/模式/轮数字段'
    )


def test_effective_schedule_defaults_match_pack(tmp_path):
    """没配置时，生效值就是包格式的默认值（前后端共用的那一份）。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    schedule = store.effective_schedule('mine')
    for behavior, (low, high) in DEFAULT_SCHEDULE_MS.items():
        if behavior == 'sleep':
            # ★ 阈值型的**没设**就是 `None`（= 跟随宿主全局），
            # 不能填一个写死的默认值：宿主表单里那个全局 `sleep_after`
            # 正是给这种情况用的，填掉它会让全局设置永远不生效。
            assert schedule[behavior]['afterMs'] is None, (
                '没设打盹阈值时该是 None（跟随宿主全局），而不是一个默认值'
            )
            assert 'minIntervalMs' not in schedule[behavior], (
                'sleep 不该带区间字段——那会让前端以为它是区间型'
            )
            continue
        assert schedule[behavior]['minIntervalMs'] == low, behavior
        assert schedule[behavior]['maxIntervalMs'] == high, behavior


def test_sleep_threshold_override_and_round_trip(tmp_path):
    """★ `sleep` 的覆盖能存能读，且**不**回落到区间形状。

    用户要求「触发时间的选项中，睡觉是否也可以加进来，就是多长时间不管
    就睡觉这种」。它是一个阈值，因此提交的是 `afterMs`。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    # ★ 没设时是 None（= 跟随宿主的全局 `sleep_after`，默认 120 秒）
    assert store.effective_schedule('mine')['sleep']['afterMs'] is None

    store.set_pet_schedule('mine', {'sleep': {'afterMs': 45000}})
    assert store.effective_schedule('mine')['sleep']['afterMs'] == 45000

    # 越界会被**夹住**而不是抛错（与其它节奏设置同一套取舍）
    store.set_pet_schedule('mine', {'sleep': {'afterMs': 1}})
    assert store.effective_schedule('mine')['sleep']['afterMs'] == SLEEP_AFTER_RANGE[0]
    store.set_pet_schedule('mine', {'sleep': {'afterMs': 99_000_000}})
    assert store.effective_schedule('mine')['sleep']['afterMs'] == SLEEP_AFTER_RANGE[1]

    # 清掉覆盖 → 回到「没设」（跟随宿主全局）
    store.set_pet_schedule('mine', {'sleep': None})
    assert store.effective_schedule('mine')['sleep']['afterMs'] is None


def test_sleep_accepts_after_ms_from_pet_json(tmp_path):
    """`pet.json` 里也能写 `schedule.sleep.afterMs`（作者可以建议一个值）。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine',
        'schedule': {'sleep': {'afterMs': 20000}},
        'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})
    assert store.effective_schedule('mine')['sleep']['afterMs'] == 20000


def test_sleep_rejects_interval_fields(tmp_path):
    """★ 给 `sleep` 写区间字段要**报错**（它是阈值，不是区间）。

    静默忽略会让作者以为设好了——而「我明明设了 30 秒却没生效」
    是最难查的一类问题。

    ⚠️ `write_pack` 只是**写文件**，校验发生在 `load_pack`（读盘）时，
    因此这里必须真的去读一次——只写不读的话这条测试永远不会失败。
    """
    for field in ('intervalMs', 'minIntervalMs', 'maxIntervalMs', 'plays', 'mode'):
        root = tmp_path / f'bad-{field}'
        write_pack(root, 'bad', payload={
            'id': 'bad',
            'schedule': {'sleep': {field: [1000, 2000] if field == 'intervalMs' else 1}},
            'animations': {'idle': 'idle.png'},
        }, sheets={'idle.png': 1})
        store = PetStore(str(tmp_path / 'data'), str(root))
        with pytest.raises(PetError) as info:
            store.load_pack('bad')
        # 字段名在 `msg` 里，而「只能设什么」在 `hint` 里——
        # `str(PetError)` 只含 msg，因此这里要分别查（第一版只查 str，
        # 于是「提示里没告诉作者该写什么」这件事测不出来）。
        assert field in str(info.value), f'错误信息要点出是哪个字段: {info.value}'
        assert 'afterMs' in (info.value.hint or ''), (
            f'提示要告诉作者 sleep 只能设什么: {info.value.hint!r}'
        )


def test_schedule_for_a_writable_pet_is_written_into_pet_json(tmp_path):
    """★ **自建形象**的节奏写进 `pet.json`（不是本机设置）。

    用户要求：「我注意到你说这个内置形象的更新在 settings 里面……我理解
    既然是跟随形象走的，应该保存到 pet.json 里面」。

    为什么这件事重要：写进 `pet.json` 才会**随导出走**。早先一律写本机
    `settings.json`，后果是「导出形象包时这个设置丢了」——换个机器导入
    就回到默认值，而用户以为自己设过了。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine',
        'schedule': {'idle': {'intervalMs': [1000, 2000]}},
        'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    # 包内声明生效
    assert store.effective_schedule('mine')['idle']['minIntervalMs'] == 1000

    store.set_pet_schedule('mine', {'idle': {'minIntervalMs': 4000, 'maxIntervalMs': 5000}})
    # ① 生效值变了
    schedule = store.effective_schedule('mine')
    assert schedule['idle']['minIntervalMs'] == 4000
    assert schedule['idle']['maxIntervalMs'] == 5000
    # ② **写进了 pet.json**（这条是本次改动的核心）
    manifest = json.loads(
        open(os.path.join(store.user_pet_dir('mine'), 'pet.json'), encoding='utf-8').read()
    )
    # 写的是**规范形式** `minIntervalMs`/`maxIntervalMs`（`intervalMs` 也合法，
    # 但 `Trigger.to_dict()` 统一成规范形式——两种写法等价，读回来一样）
    assert manifest['schedule']['idle']['minIntervalMs'] == 4000, manifest['schedule']
    assert manifest['schedule']['idle']['maxIntervalMs'] == 5000
    # ③ **没有**留在本机设置里（一处真相，否则旧覆盖会盖住新值）
    assert not (store.get_settings().get('petSchedules') or {}).get('mine')

    # ④ 只改一项时，另一项要保住（合并而不是替换）
    store.set_pet_schedule('mine', {'roam': {'minIntervalMs': 300, 'maxIntervalMs': 600}})
    manifest = json.loads(
        open(os.path.join(store.user_pet_dir('mine'), 'pet.json'), encoding='utf-8').read()
    )
    assert manifest['schedule']['idle']['minIntervalMs'] == 4000, '改 roam 不该动 idle'
    assert manifest['schedule']['idle']['maxIntervalMs'] == 5000
    assert manifest['schedule']['roam']['minIntervalMs'] == 300
    assert manifest['schedule']['roam']['maxIntervalMs'] == 600

    # ⑤ 恢复默认 = 删掉包内声明 → 回到**内置默认值**（不是原作者的旧值）
    store.clear_pet_schedule('mine')
    manifest = json.loads(
        open(os.path.join(store.user_pet_dir('mine'), 'pet.json'), encoding='utf-8').read()
    )
    assert 'schedule' not in manifest, '清除应当删掉这个字段'
    assert store.effective_schedule('mine')['idle']['minIntervalMs'] == 6000


def test_schedule_for_a_builtin_pet_stays_in_settings(tmp_path):
    """★ **内置形象**只能写本机设置（随包文件动不了）。

    内置形象恰恰是大多数用户唯一会用的形象，因此它必须**仍然可调**。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    shutil.copytree(
        os.path.join(REPO_ROOT, 'resources', 'pets', 'xiaoka'),
        str(builtin / 'xiaoka'),
    )

    store.set_pet_schedule('xiaoka', {'idle': {'minIntervalMs': 3000, 'maxIntervalMs': 5000}})
    assert store.effective_schedule('xiaoka')['idle']['minIntervalMs'] == 3000
    # 落在本机设置里
    stored = (store.get_settings().get('petSchedules') or {}).get('xiaoka')
    assert stored and stored['idle']['minIntervalMs'] == 3000
    # 随包文件**一个字节都没动**
    manifest = json.loads(
        open(os.path.join(str(builtin), 'xiaoka', 'pet.json'), encoding='utf-8').read()
    )
    assert manifest['schedule']['idle']['intervalMs'] == [6000, 18000], '内置包不该被改'


def test_schedule_is_editable_for_builtin_pets(tmp_path):
    """★ **内置形象也能调触发时间**。

    用户要求「支持调整不同动作的触发时间」，而内置形象是只读的
    （不能改它的 pet.json）——因此节奏必须落在 `data/settings.json` 里。
    内置形象恰恰是大多数用户唯一会用的形象。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    write_pack(builtin, 'official', payload={
        'id': 'official',
        'schedule': {'idle': {'intervalMs': [6000, 18000]}},
        'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})
    store = PetStore(str(data), str(builtin))

    store.set_pet_schedule('official', {'idle': {'minIntervalMs': 1500, 'maxIntervalMs': 2500}})
    schedule = store.effective_schedule('official')
    assert schedule['idle']['minIntervalMs'] == 1500
    assert schedule['idle']['maxIntervalMs'] == 2500
    # 内置形象的 pet.json **一个字节都没改**
    assert store.load_pack('official').schedule_for('idle').min_ms == 6000


def test_roam_interval_is_editable(tmp_path):
    """★ 漫游的间隔也要能调（用户明确提到「左右移动」这个动作）。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    store.set_pet_schedule('mine', {'roam': {'minIntervalMs': 500, 'maxIntervalMs': 900}})
    schedule = store.effective_schedule('mine')
    assert schedule['roam']['minIntervalMs'] == 500
    assert schedule['roam']['maxIntervalMs'] == 900


def test_schedule_rejects_event_driven_behaviors(tmp_path):
    """给**事件驱动**的动作设触发时间是错误（那件事做不到）。

    静默忽略的后果是「我明明设了却没生效」——最难查的一类问题。
    """
    from backend.core.errors import CODE_WRITE_FAILED, PetError

    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    for behavior in ('click', 'fall', 'happy', 'land', 'walk-left'):
        with pytest.raises(PetError) as info:
            store.set_pet_schedule('mine', {behavior: {'minIntervalMs': 1000}})
        assert info.value.code == CODE_WRITE_FAILED
        assert behavior in info.value.msg


def test_schedule_intervals_are_clamped(tmp_path):
    """区间写反 / 越界都被夹住，而不是让设置文件变成脏值。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    # 写反 → 调正
    store.set_pet_schedule('mine', {'idle': {'minIntervalMs': 9000, 'maxIntervalMs': 2000}})
    schedule = store.effective_schedule('mine')
    assert schedule['idle']['minIntervalMs'] == 2000
    assert schedule['idle']['maxIntervalMs'] == 9000

    # 越界 → 夹到合法区间
    store.set_pet_schedule('mine', {'idle': {'minIntervalMs': 1, 'maxIntervalMs': 999999999}})
    schedule = store.effective_schedule('mine')
    from backend.core.pack import MAX_SCHEDULE_MS, MIN_SCHEDULE_MS
    assert schedule['idle']['minIntervalMs'] == MIN_SCHEDULE_MS
    assert schedule['idle']['maxIntervalMs'] == MAX_SCHEDULE_MS


def test_schedule_can_be_cleared(tmp_path):
    """清除覆盖 → 回落到包内声明 / 默认值。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    store.set_pet_schedule('mine', {'idle': {'minIntervalMs': 1234}})
    assert store.effective_schedule('mine')['idle']['minIntervalMs'] == 1234
    assert store.clear_pet_schedule('mine') is True
    assert store.effective_schedule('mine')['idle']['minIntervalMs'] == (
        DEFAULT_SCHEDULE_MS['idle'][0]
    )
    assert store.clear_pet_schedule('mine') is False, '第二次清除应返回 False'


def test_deleting_a_pet_clears_its_schedule(tmp_path):
    """删形象时清掉它的节奏覆盖。

    不清的后果是设置文件无限增长，而且 id 会被重新分配
    （`_allocate_pet_id` 复用 `pet`、`pet-2`…），新建的形象会莫名其妙地
    继承一个早已删除的形象的节奏。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'temp', payload={
        'id': 'temp', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    store.set_pet_schedule('temp', {'idle': {'minIntervalMs': 777}})
    assert store.delete_pet('temp') is True
    assert 'temp' not in (store.get_settings().get('petSchedules') or {})


def test_schedule_survives_a_corrupt_settings_file(tmp_path):
    """设置文件里的一项坏值不该让**所有**形象的节奏一起失效。

    ⚠️ 用**内置形象**来验：自建形象的节奏现在写在 `pet.json` 里，
    根本不碰本机设置（见 `test_schedule_for_a_writable_pet_is_written_into_pet_json`）。
    本机设置那条路是内置形象专用的，所以「设置文件脏了会怎样」要在它身上验。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    shutil.copytree(
        os.path.join(REPO_ROOT, 'resources', 'pets', 'xiaoka'),
        str(builtin / 'xiaoka'),
    )

    store.set_pet_schedule('xiaoka', {'idle': {'minIntervalMs': 1234}})
    # 手工往设置文件里塞脏值
    path = store.settings_path()
    with open(path, encoding='utf-8') as handle:
        settings = json.load(handle)
    settings['petSchedules']['bad'] = 'not-an-object'
    settings['petSchedules']['xiaoka']['idle']['minIntervalMs'] = 'oops'
    settings['petSchedules']['xiaoka']['idle']['maxIntervalMs'] = 4321
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(settings, handle, ensure_ascii=False)

    schedule = store.effective_schedule('xiaoka')
    # 脏的 min 被丢掉 → 回落包内声明（小卡是 6000）；干净的 max 保留。
    # 回落值（6000）比用户给的 max（4321）大 → 触发「调正写反的区间」，
    # 于是得到 4321~6000 这个**合法**区间（与包解析同一套宽容策略）。
    assert schedule['idle']['maxIntervalMs'] == 6000
    assert schedule['idle']['minIntervalMs'] == 4321
    assert schedule['idle']['minIntervalMs'] <= schedule['idle']['maxIntervalMs']
    # 整个设置仍然读得出来（这是「逐条清洗」的意义）
    assert store.get_settings()['petSchedules']


def test_schedule_route_accepts_patch_and_reset(env):
    """`/schedule` 接口：改一项 / 整体重置。"""
    _app, store, client, _api = env
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    response = client.post(
        '/api/plugins/stm-pet/pets/mine/schedule',
        json={'schedule': {'roam': {'minIntervalMs': 700, 'maxIntervalMs': 800}}},
    )
    assert response.status_code == 200
    assert json_of(response)['pet']['schedule']['roam']['minIntervalMs'] == 700

    reset = client.post(
        '/api/plugins/stm-pet/pets/mine/schedule', json={'reset': True},
    )
    assert reset.status_code == 200
    assert json_of(reset)['pet']['schedule']['roam']['minIntervalMs'] == (
        DEFAULT_SCHEDULE_MS['roam'][0]
    )


def test_schedule_route_rejects_event_driven_behaviors(env):
    """接口层也要挡住事件驱动的行为（UI 藏了不代表改不了）。"""
    _app, store, client, _api = env
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    response = client.post(
        '/api/plugins/stm-pet/pets/mine/schedule',
        json={'schedule': {'click': {'minIntervalMs': 1000}}},
    )
    assert response.status_code == 400
    body = json_of(response)
    assert body['success'] is False
    assert 'click' in body['msg'] or 'click' in body.get('hint', '')


def test_create_route_accepts_author_still_and_schedule(tmp_path):
    """新建接口要能一次收到作者、标准图像与触发节奏。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    api = FakeApi(data_dir=str(data))
    app = build_app(api, store)
    client = app.test_client()

    response = client.post('/api/plugins/stm-pet/pets/create', data={
        'name': '我的宠物',
        'author': '某位作者',
        'idle': (io.BytesIO(make_image_bytes(size=(64, 64))), 'idle.png'),
        'meta': json.dumps({'idle': {'frames': 1}}),
        'still': json.dumps({'action': 'idle', 'frame': 0}),
        'schedule': json.dumps({'idle': {'intervalMs': [2000, 4000]}}),
    }, content_type='multipart/form-data')

    assert response.status_code == 200, response.data
    pet = json_of(response)['pet']
    assert pet['author'] == '某位作者'
    assert pet['still']['declared'] is True
    assert pet['still']['frame'] == 0
    # 节奏写进了 pet.json（因此生效值就是它）
    assert pet['schedule']['idle']['minIntervalMs'] == 2000
    assert pet['declaredSchedule']['idle']['minIntervalMs'] == 2000


def test_create_route_accepts_a_separate_still_upload(tmp_path):
    """单独上传一张标准图像（文件字段也叫 `still`）。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    api = FakeApi(data_dir=str(data))
    app = build_app(api, store)
    client = app.test_client()

    response = client.post('/api/plugins/stm-pet/pets/create', data={
        'name': '带标准图像',
        'idle': (io.BytesIO(make_image_bytes(size=(64, 64))), 'idle.png'),
        'still': (io.BytesIO(make_image_bytes(size=(64, 64), color=(7, 7, 7, 255))), 'still.png'),
    }, content_type='multipart/form-data')

    assert response.status_code == 200, response.data
    pet = json_of(response)['pet']
    assert pet['still']['declared'] is True
    assert pet['still']['url']
    # 图真的落盘了
    assert client.get(pet['still']['url']).status_code == 200


def test_meta_route_updates_name_author_still(tmp_path):
    """`/meta` 一次可以改多项。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'name': '旧名', 'author': '旧作者',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 4}},
    }, sheets={'idle.png': 4})
    api = FakeApi(data_dir=str(data))
    app = build_app(api, store)
    client = app.test_client()

    response = client.post('/api/plugins/stm-pet/pets/mine/meta', json={
        'name': '新名',
        'author': '新作者',
        'still': {'action': 'idle', 'frame': 3},
    })
    assert response.status_code == 200
    pet = json_of(response)['pet']
    assert pet['name'] == '新名'
    assert pet['author'] == '新作者'
    assert pet['still']['frame'] == 3


def test_meta_route_rejects_empty_name(env):
    """名字不能改成空（那会让面板上出现一个没有标题的形象）。"""
    _app, store, client, _api = env
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'name': '有名字', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})
    response = client.post(
        '/api/plugins/stm-pet/pets/mine/meta', json={'name': '   '},
    )
    assert response.status_code == 400
    assert store.load_pack('mine').name == '有名字', '拒绝后不该改坏'


def test_meta_route_rejects_broken_schedule(env):
    """非法节奏要整体拒绝，而不是写出一个读不回来的包。"""
    _app, store, client, _api = env
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})
    response = client.post(
        '/api/plugins/stm-pet/pets/mine/meta',
        json={'schedule': {'click': {'intervalMs': [1, 2]}}},
    )
    assert response.status_code == 400
    # 包仍然完好可读
    assert store.load_pack('mine').animations['idle'].primary.sheet == 'idle.png'


def test_pets_list_advertises_schedule_limits(env):
    """列表接口要把节奏的合法区间与行为名单给面板（不两边写死）。"""
    _app, _store, client, _api = env
    limits = json_of(client.get('/api/plugins/stm-pet/pets'))['limits']
    from backend.core.pack import MAX_SCHEDULE_MS, MIN_SCHEDULE_MS
    assert limits['scheduleMinMs'] == MIN_SCHEDULE_MS
    assert limits['scheduleMaxMs'] == MAX_SCHEDULE_MS
    assert limits['scheduleBehaviors'] == list(SCHEDULE_BEHAVIORS)


# ============================================================ 内置形象的动作表

def test_builtin_pets_do_not_declare_unreachable_actions():
    """★ 内置形象里**不该有够不着的动作声明**。

    用户要求：「直接去掉 look 这个动作，把 look 改成 idle 的第二套动作，
    两个都统一一下，这样语义也不会有问题，图也没有白费，也不会有歧义了」。

    背景：`look`（张望）曾经在包里声明了、面板里有中文名、README 里还写着
    「指针靠近」触发 —— 但**运行期没有任何路径能进入它**：播报类动作由
    `REACT_ACTIONS` 白名单把关（只有 happy/sad/angry/click），其余动作名都由
    状态机按状态算出来。实测 `view.react('look')` 之后动作仍然是 idle。

    这条断言把「内置形象的动作必须都在词表里」钉住：以后谁再往包里塞一个
    没有触发路径的动作，这里就会失败。
    """
    builtin = os.path.join(REPO_ROOT, 'resources', 'pets')
    for pet_id in ('xiaoman', 'xiaoka'):
        with open(os.path.join(builtin, pet_id, 'pet.json'), encoding='utf-8') as handle:
            manifest = json.load(handle)
        declared = set(manifest['animations'])
        unknown = declared - set(ACTION_FALLBACKS)
        assert not unknown, (
            f'{pet_id} 声明了词表以外的动作 {sorted(unknown)}——'
            '它们没有触发路径（状态机不会进入，播报白名单也拒绝）'
        )
        assert 'look' not in declared, f'{pet_id} 不该再有 look 动作'


def test_builtin_pets_keep_the_second_idle_variant():
    """★ 去掉 `look` 动作之后，那张图要**以 idle 第二套的身份留着**。

    这是用户要求的重点：「图也没有白费」。因此不能只删动作——
    必须确认 idle 仍有两套、第二套指向那张图、权重也还在。
    """
    builtin = os.path.join(REPO_ROOT, 'resources', 'pets')
    for pet_id in ('xiaoman', 'xiaoka'):
        pet_dir = os.path.join(builtin, pet_id)
        with open(os.path.join(pet_dir, 'pet.json'), encoding='utf-8') as handle:
            manifest = json.load(handle)
        variants = manifest['animations']['idle']['variants']
        assert len(variants) == 2, f'{pet_id} 的 idle 应当有 2 套'
        # 第一套是主图，第二套是原来的「张望」
        assert variants[0]['sheet'] == 'idle.png'
        assert variants[1]['sheet'] == 'idle-v2.png', (
            f'{pet_id} 的第二套该按多套命名规范叫 idle-v2.png，'
            f'实际 {variants[1]["sheet"]}'
        )
        # 权重保持原样（5 : 2，即约 71% / 29%）
        assert variants[0]['weight'] == 5
        assert variants[1]['weight'] == 2
        # 两张图都在磁盘上（改名之后不能漏掉文件）
        for variant in variants:
            path = os.path.join(pet_dir, variant['sheet'])
            assert os.path.isfile(path), f'{pet_id} 缺少 {variant["sheet"]}'
        # 旧文件名不该还在（否则就是「改了一半」）
        assert not os.path.isfile(os.path.join(pet_dir, 'look.png')), (
            f'{pet_id} 还留着 look.png——改名应当是一次性的'
        )
