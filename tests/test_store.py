"""形象存储层：两层覆盖、导入/导出、设置持久化（§3.2 / §2.4 / 阶段 5 验收）。"""

import io
import json
import os
import zipfile

import pytest

from backend.core.errors import (
    CODE_ARCHIVE_INVALID,
    CODE_FILE_TOO_LARGE,
    CODE_IMAGE_INVALID,
    CODE_PACK_NOT_FOUND,
    PetError,
)
from backend.core.store import (
    DEFAULT_SETTINGS,
    MANIFEST_FILENAME,
    OVERRIDES_DIRNAME,
    PETS_DIRNAME,
    PetStore,
    sanitize_pet_id,
)
from pet_test_support import make_image_bytes, minimal_pack, pack, write_pack, write_sheet


# ------------------------------------------------------------------ 夹具


@pytest.fixture()
def store(tmp_path):
    """一个空的形象库：独立 data/ 与 resources/。"""
    data_dir = tmp_path / 'data'
    builtin_dir = tmp_path / 'resources' / 'pets'
    data_dir.mkdir(parents=True)
    builtin_dir.mkdir(parents=True)
    return PetStore(str(data_dir), str(builtin_dir))


@pytest.fixture()
def builtin_pet(store):
    """内置一只宠物（模拟随包资源）。"""
    write_pack(
        store.builtin_dir, 'builtin-cat',
        payload=pack(id='builtin-cat', name='内置猫'),
        sheets={'idle.png': 4, 'walk.png': 6, 'fall.png': 2, 'drag.png': 2},
    )
    return 'builtin-cat'


def zip_pack(files: dict) -> bytes:
    """把 `{相对路径: bytes}` 打成 zip。"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def sample_zip(pet_id='my-pet', *, nested=False, extra=None) -> bytes:
    prefix = f'{pet_id}/' if nested else ''
    files = {
        f'{prefix}{MANIFEST_FILENAME}': json.dumps(
            minimal_pack(id=pet_id, name='我的宠物'), ensure_ascii=False,
        ).encode('utf-8'),
        f'{prefix}idle.png': make_image_bytes(size=(64, 64)),
    }
    files.update(extra or {})
    return zip_pack(files)


# ------------------------------------------------------------------ id 归一


@pytest.mark.parametrize('raw,expected', [
    ('My Cat', 'my-cat'),
    ('my-cat.zip', 'my-cat'),
    ('../evil', 'evil'),
    ('../../etc/passwd', 'etc-passwd'),
    ('a' * 100, 'a' * 64),
    ('!!!', 'pet'),
    ('', 'pet'),
    (None, 'pet'),
    ('café', 'caf'),
    ('好猫', 'pet'),
])
def test_sanitize_pet_id(raw, expected):
    """id 会被拼进路径，必须先归一化——尤其 `../evil` 不能原样留下。"""
    assert sanitize_pet_id(raw) == expected


def test_sanitize_pet_id_never_yields_traversal():
    for raw in ['..', '../..', 'a/../b', 'C:\\x', '\\\\server\\share']:
        result = sanitize_pet_id(raw)
        assert '..' not in result
        assert '/' not in result
        assert '\\' not in result
        assert ':' not in result


# ------------------------------------------------------------------ 设置


def test_default_settings_when_missing(store):
    assert store.get_settings() == DEFAULT_SETTINGS


def test_update_settings_round_trips(store):
    store.update_settings({'activePetId': 'my-cat'})
    assert store.get_settings()['activePetId'] == 'my-cat'


def test_update_settings_ignores_unknown_keys(store):
    """未知键（含宿主 config_schema 里的标量键）一律忽略。

    标量配置的唯一来源是 manifest 的 `config_schema`（宿主表单渲染 + `api.set_config`），
    插件私有设置里不该再存一份，否则两边会不同步。
    """
    store.update_settings({'hacker': 'x', 'quietMode': True, 'scale': 2})
    settings = store.get_settings()
    assert 'hacker' not in settings
    assert 'quietMode' not in settings
    assert 'scale' not in settings


def test_settings_file_is_utf8_without_escapes(store):
    """中文 JSON 用 ensure_ascii=False 写（§1.2）。"""
    store.update_settings({'activePetId': '我的猫'})
    with open(store.settings_path(), 'r', encoding='utf-8') as handle:
        text = handle.read()
    assert '\\u' not in text


def test_corrupted_settings_fall_back_to_defaults(store):
    """设置文件坏了不能导致插件挂掉——回落到默认值。"""
    with open(store.settings_path(), 'w', encoding='utf-8') as handle:
        handle.write('{ this is not json')
    assert store.get_settings() == DEFAULT_SETTINGS


def test_update_settings_rejects_non_dict(store):
    with pytest.raises(PetError):
        store.update_settings(['not', 'a', 'dict'])


# ------------------------------------------------------------------ 列出/回退


def test_list_pets_empty(store):
    assert store.list_pets() == []


def test_list_pets_includes_builtin(store, builtin_pet):
    items = store.list_pets()
    assert [item['id'] for item in items] == ['builtin-cat']
    assert items[0]['source'] == 'builtin'
    assert items[0]['name'] == '内置猫'
    assert 'idle' in items[0]['animations']


def test_list_pets_marks_missing_required_actions(store):
    write_pack(store.builtin_dir, 'only-idle', payload=minimal_pack(id='only-idle'))
    item = next(i for i in store.list_pets() if i['id'] == 'only-idle')
    assert set(item['missingRequired']) == {'walk', 'drag', 'fall'}


def test_list_pets_reports_broken_pack_without_failing_others(store, builtin_pet):
    """单个包损坏不能拖垮整个列表。"""
    broken = os.path.join(store.builtin_dir, 'broken')
    os.makedirs(broken, exist_ok=True)
    with open(os.path.join(broken, MANIFEST_FILENAME), 'w', encoding='utf-8') as handle:
        handle.write('{ not json')

    items = store.list_pets()
    ids = [item['id'] for item in items]
    assert 'builtin-cat' in ids
    broken_item = next(i for i in items if i['id'] == 'broken')
    assert broken_item['error'], '损坏的包应带 error 说明'


def test_user_pet_shadows_builtin_with_same_id(store, builtin_pet):
    """用户包与内置包同 id 时，用户那份优先（用户数据优先原则）。"""
    write_pack(store.user_pets_dir(), builtin_pet, payload=pack(id=builtin_pet, name='我的版本'))
    items = store.list_pets()
    matching = [i for i in items if i['id'] == builtin_pet]
    assert len(matching) == 1, '同 id 不应出现两条'
    assert matching[0]['source'] == 'user'
    assert matching[0]['name'] == '我的版本'


def test_list_pets_skips_invalid_directory_names(store):
    root = store.user_pets_dir()
    os.makedirs(root, exist_ok=True)
    os.makedirs(os.path.join(root, '..evil'), exist_ok=True)
    os.makedirs(os.path.join(root, 'UPPER'), exist_ok=True)
    assert store.list_pets() == []


# ------------------------------------------------------------------ 当前形象


def test_active_pet_id_falls_back_to_first_available(store, builtin_pet):
    assert store.active_pet_id() == 'builtin-cat'


def test_active_pet_id_honours_setting(store, builtin_pet):
    write_pack(store.builtin_dir, 'other', payload=minimal_pack(id='other'))
    store.update_settings({'activePetId': 'other'})
    assert store.active_pet_id() == 'other'


def test_active_pet_id_falls_back_when_setting_points_to_missing(store, builtin_pet):
    store.update_settings({'activePetId': 'deleted-pet'})
    assert store.active_pet_id() == 'builtin-cat'


def test_active_pet_id_empty_when_nothing_available(store):
    assert store.active_pet_id() == ''


# ------------------------------------------------------------------ 帧解析


def test_resolve_frame_path_from_builtin(store, builtin_pet):
    path, source = store.resolve_frame_path(builtin_pet, 'idle')
    assert source == 'builtin'
    assert os.path.isfile(path)
    assert path.endswith('idle.png')


def test_resolve_frame_path_override_beats_pack(store, builtin_pet):
    """两层覆盖：用户覆盖 > 包内（§3.2）。"""
    store.save_action_image(builtin_pet, 'idle', make_image_bytes(size=(64, 64), color=(0, 0, 255, 255)))
    path, source = store.resolve_frame_path(builtin_pet, 'idle')
    assert source == 'override'
    assert OVERRIDES_DIRNAME in path


def test_resolve_frame_path_missing_action_returns_none(store):
    write_pack(store.builtin_dir, 'bare', payload={'id': 'bare', 'animations': {'idle': {'sheet': ''}}})
    path, source = store.resolve_frame_path('bare', 'idle')
    assert (path, source) == ('', 'none')


def test_resolve_frame_path_rejects_bad_action_name(store, builtin_pet):
    for action in ['../evil', 'a/b', '', '..']:
        with pytest.raises(PetError):
            store.resolve_frame_path(builtin_pet, action)


def test_resolve_frame_path_unknown_pet_returns_none(store):
    path, source = store.resolve_frame_path('ghost', 'idle')
    assert (path, source) == ('', 'none')


# ------------------------------------------------------------------ runtime_pack


def test_runtime_pack_shape(store, builtin_pet):
    payload = store.runtime_pack(builtin_pet)
    assert payload['id'] == builtin_pet
    assert payload['size'] == {'w': 64, 'h': 64}
    assert set(payload['actions']) >= {'idle', 'walk', 'fall', 'drag'}
    idle = payload['actions']['idle']
    assert idle['kind'] == 'animated'
    assert idle['url'].startswith('/api/plugins/stm-pet/frame/')
    assert 'v=' in idle['url'], 'URL 必须带版本参数以便强缓存'
    assert payload['physics']['gravity'] == 1800


def test_runtime_pack_single_frame_pack_works(store):
    """★ 只有一张单帧图的包也要能跑起来，且行为合理（只位移不播帧）。"""
    write_pack(store.builtin_dir, 'single', payload=minimal_pack(id='single'),
               sheets={'idle.png': 1})
    payload = store.runtime_pack('single')
    for action in ('walk', 'drag', 'fall', 'land', 'happy', 'sleep'):
        entry = payload['actions'][action]
        assert entry['kind'] == 'animated'
        assert entry['source'] == 'idle', f'{action} 应回退到 idle'
        assert entry['frames'] == 1
        assert entry['url']


def test_runtime_pack_falls_back_to_active_pet(store, builtin_pet):
    assert store.runtime_pack()['id'] == builtin_pet


def test_runtime_pack_without_any_pet_is_readable_error(store):
    with pytest.raises(PetError) as info:
        store.runtime_pack()
    assert info.value.user_msg
    assert info.value.hint


def test_runtime_pack_reports_missing_sheet_file(store):
    """pet.json 指向的图不存在时，退化为 static 并给出说明，而不是崩掉。"""
    pack_dir = write_pack(store.builtin_dir, 'ghost-sheet',
                          payload=minimal_pack(id='ghost-sheet'))
    # 故意不生成 idle.png
    assert not os.path.exists(os.path.join(pack_dir, 'idle.png'))
    payload = store.runtime_pack('ghost-sheet')
    idle = payload['actions']['idle']
    assert idle['kind'] == 'static'
    assert idle['note']
    assert idle['url'] == ''


def test_frame_url_changes_with_content(store, builtin_pet):
    """内容变化 → URL 变化（否则强缓存会一直给旧图）。"""
    first = store.runtime_pack(builtin_pet)['actions']['idle']['url']
    store.save_action_image(builtin_pet, 'idle', make_image_bytes(size=(64, 64), color=(9, 9, 9, 255)))
    second = store.runtime_pack(builtin_pet)['actions']['idle']['url']
    assert first != second


# ------------------------------------------------------------------ 导入 zip


def test_import_zip_round_trip(store):
    result = store.import_zip(sample_zip('my-pet'))
    assert result['id'] == 'my-pet'
    assert result['source'] == 'user'
    assert result['actions']['idle']['kind'] == 'animated'
    # 落盘位置在 data/ 里（宿主保证更新时保留，§2.4）
    assert os.path.isfile(os.path.join(store.user_pet_dir('my-pet'), MANIFEST_FILENAME))


def test_import_zip_with_nested_root_folder(store):
    """用户压缩时常常多一层目录——要能自动识别。"""
    result = store.import_zip(sample_zip('nested-pet', nested=True))
    assert result['id'] == 'nested-pet'
    assert result['actions']['idle']['url']


def test_import_zip_assigns_new_id_when_taken(store):
    store.import_zip(sample_zip('dup'))
    second = store.import_zip(sample_zip('dup'))
    assert second['id'] != 'dup'
    assert second['id'].startswith('dup')


def test_import_zip_replace_mode_overwrites(store):
    store.import_zip(sample_zip('dup'))
    again = store.import_zip(sample_zip('dup'), replace=True)
    assert again['id'] == 'dup'


def test_import_zip_does_not_shadow_builtin_id(store, builtin_pet):
    """导入的包与内置包同 id 时自动改名，不覆盖内置形象。"""
    result = store.import_zip(sample_zip(builtin_pet))
    assert result['id'] != builtin_pet
    assert store.load_pack(builtin_pet).name == '内置猫'


def test_import_zip_transcodes_jpeg_inside_pack(store):
    """★ 包内带 JPEG 时自动转 PNG——否则宿主的资产白名单会 404。

    两层含义都要成立：磁盘上是 PNG，**且** pet.json 的 sheet 指向被同步改写
    （否则包指向一个不存在的 idle.jpg，运行期解析不到图）。
    """
    manifest = json.dumps(
        {'id': 'jpeg-pet', 'animations': {'idle': {'sheet': 'idle.jpg', 'frames': 1}}},
        ensure_ascii=False,
    ).encode('utf-8')
    data = zip_pack({
        MANIFEST_FILENAME: manifest,
        'idle.jpg': make_image_bytes(fmt='JPEG', size=(64, 64), mode='RGB'),
    })
    result = store.import_zip(data)
    idle = result['actions']['idle']
    assert idle['url'], '转码后应能解析出 URL'
    assert idle['kind'] == 'animated'

    path, _source = store.resolve_frame_path('jpeg-pet', 'idle')
    with open(path, 'rb') as handle:
        head = handle.read(8)
    assert head.startswith(b'\x89PNG'), 'JPEG 应被转成 PNG 落盘'
    assert path.endswith('idle.png')

    # sheet 指向必须跟着改
    with open(os.path.join(store.user_pet_dir('jpeg-pet'), MANIFEST_FILENAME),
              encoding='utf-8') as handle:
        stored = json.load(handle)
    assert stored['animations']['idle']['sheet'] == 'idle.png'
    assert not os.path.exists(os.path.join(store.user_pet_dir('jpeg-pet'), 'idle.jpg'))


def test_import_zip_transcodes_jpeg_in_nested_sheet_path(store):
    """sheet 在子目录里时，改写要保留目录结构。"""
    manifest = json.dumps(
        {'id': 'nested-jpg', 'animations': {'idle': {'sheet': 'art/idle.jpg'}}},
        ensure_ascii=False,
    ).encode('utf-8')
    data = zip_pack({
        MANIFEST_FILENAME: manifest,
        'art/idle.jpg': make_image_bytes(fmt='JPEG', size=(32, 32), mode='RGB'),
    })
    store.import_zip(data)
    with open(os.path.join(store.user_pet_dir('nested-jpg'), MANIFEST_FILENAME),
              encoding='utf-8') as handle:
        assert json.load(handle)['animations']['idle']['sheet'] == 'art/idle.png'
    assert store.resolve_frame_path('nested-jpg', 'idle')[0].endswith('idle.png')


def test_import_zip_accepts_string_shorthand_with_jpeg(store):
    """`"idle": "idle.jpg"` 这种简写也要能转码。"""
    manifest = json.dumps(
        {'id': 'short-jpg', 'animations': {'idle': 'idle.jpg'}}, ensure_ascii=False,
    ).encode('utf-8')
    store.import_zip(zip_pack({
        MANIFEST_FILENAME: manifest,
        'idle.jpg': make_image_bytes(fmt='JPEG', size=(32, 32), mode='RGB'),
    }))
    with open(os.path.join(store.user_pet_dir('short-jpg'), MANIFEST_FILENAME),
              encoding='utf-8') as handle:
        assert json.load(handle)['animations']['idle'] == 'idle.png'


def test_runtime_parse_still_rejects_jpeg_sheet(store):
    """运行期读盘走**严格**白名单：手工放进 data/ 的 .jpg 包要被拒绝。

    导入路径放行 JPEG 只是为了有机会转码；落盘后的包必须已经是宿主能吃的格式。
    """
    write_pack(store.builtin_dir, 'raw-jpg',
               payload={'id': 'raw-jpg', 'animations': {'idle': 'idle.jpg'}})
    with pytest.raises(PetError) as info:
        store.load_pack('raw-jpg')
    assert info.value.code == 'pack_field_invalid'


def test_import_zip_keeps_png_bytes_untouched(store):
    """已是 PNG 的 spritesheet **不要**重编码——转码会重采样，糊掉像素风。"""
    original = make_image_bytes(size=(64, 64), color=(1, 2, 3, 255))
    data = zip_pack({
        MANIFEST_FILENAME: json.dumps(minimal_pack(id='raw-png')).encode('utf-8'),
        'idle.png': original,
    })
    store.import_zip(data)
    path, _source = store.resolve_frame_path('raw-png', 'idle')
    with open(path, 'rb') as handle:
        assert handle.read() == original


def test_import_zip_skips_non_image_files(store):
    """包里的 readme / psd 源文件跳过而不是报错（`.md`/`.psd` 都不在白名单）。"""
    result = store.import_zip(sample_zip('with-extras', extra={
        'readme.md': b'# my pet',
        'idle.psd': b'\x00' * 10,
        'notes.txt': b'hello',
    }))
    assert result['id'] == 'with-extras'
    directory = store.user_pet_dir('with-extras')
    assert not os.path.exists(os.path.join(directory, 'readme.md'))
    assert not os.path.exists(os.path.join(directory, 'notes.txt'))


def test_import_zip_rejects_oversized(store):
    with pytest.raises(PetError) as info:
        store.import_zip(b'\x00' * (32 * 1024 * 1024 + 1))
    assert info.value.code == CODE_FILE_TOO_LARGE


def test_import_zip_rejects_non_zip(store):
    with pytest.raises(PetError) as info:
        store.import_zip(b'this is definitely not a zip file')
    assert info.value.code == CODE_ARCHIVE_INVALID
    assert info.value.hint


def test_import_zip_rejects_zip_without_manifest(store):
    data = zip_pack({'idle.png': make_image_bytes()})
    with pytest.raises(PetError) as info:
        store.import_zip(data)
    assert info.value.code == CODE_ARCHIVE_INVALID
    assert 'pet.json' in info.value.user_msg


def test_import_zip_rejects_multiple_manifests(store):
    data = zip_pack({
        'a/pet.json': json.dumps(minimal_pack()).encode('utf-8'),
        'b/pet.json': json.dumps(minimal_pack()).encode('utf-8'),
        'a/idle.png': make_image_bytes(),
        'b/idle.png': make_image_bytes(),
    })
    with pytest.raises(PetError) as info:
        store.import_zip(data)
    assert info.value.code == CODE_ARCHIVE_INVALID


def test_import_zip_rejects_zip_slip(store):
    """★ zip slip：包内条目带 `..` 必须拒绝。"""
    data = zip_pack({
        MANIFEST_FILENAME: json.dumps(minimal_pack()).encode('utf-8'),
        '../escaped.png': make_image_bytes(),
    })
    with pytest.raises(PetError) as info:
        store.import_zip(data)
    assert info.value.code == CODE_ARCHIVE_INVALID
    # 确认真的没有写到 data/ 外面
    assert not os.path.exists(os.path.join(store.data_dir, 'escaped.png'))
    assert not os.path.exists(os.path.join(os.path.dirname(store.data_dir), 'escaped.png'))


def test_import_zip_rejects_absolute_entry(store):
    data = zip_pack({
        MANIFEST_FILENAME: json.dumps(minimal_pack()).encode('utf-8'),
        '/etc/passwd.png': make_image_bytes(),
    })
    with pytest.raises(PetError) as info:
        store.import_zip(data)
    assert info.value.code == CODE_ARCHIVE_INVALID


def test_import_zip_ignores_macos_metadata(store):
    result = store.import_zip(sample_zip('mac-pet', extra={
        '__MACOSX/._pet.json': b'junk',
        '._idle.png': b'junk',
    }))
    assert result['id'] == 'mac-pet'


def test_import_zip_rejects_invalid_pack_id_when_normalized(store):
    """包内 id 是 `../evil` 时，落盘目录名必须被归一化到 data/ 内。"""
    manifest = json.dumps(
        {'id': '../../evil', 'name': 'evil', 'animations': {'idle': 'idle.png'}},
        ensure_ascii=False,
    ).encode('utf-8')
    data = zip_pack({MANIFEST_FILENAME: manifest, 'idle.png': make_image_bytes()})
    result = store.import_zip(data)
    assert '..' not in result['id']
    assert '/' not in result['id']
    assert os.path.isdir(store.user_pet_dir(result['id']))


def test_import_zip_rejects_broken_image_inside(store):
    data = zip_pack({
        MANIFEST_FILENAME: json.dumps(minimal_pack()).encode('utf-8'),
        'idle.png': b'not an image at all',
    })
    with pytest.raises(PetError):
        store.import_zip(data)


def test_import_zip_leaves_no_staging_dir_on_failure(store):
    data = zip_pack({
        MANIFEST_FILENAME: json.dumps(minimal_pack()).encode('utf-8'),
        'idle.png': b'garbage',
    })
    with pytest.raises(PetError):
        store.import_zip(data)
    root = store.user_pets_dir()
    leftovers = [n for n in os.listdir(root)] if os.path.isdir(root) else []
    assert not [n for n in leftovers if n.startswith('.staging-')]


def test_concurrent_imports_do_not_collide(store):
    """并发导入同名包不互相覆盖（阶段 5 验收项）。"""
    import threading

    results = []
    errors = []
    lock = threading.Lock()

    def worker():
        try:
            payload = store.import_zip(sample_zip('shared-name'))
            with lock:
                results.append(payload['id'])
        except Exception as exc:  # noqa: BLE001 - 测试装置，收集所有失败
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not errors, f'并发导入出现异常: {errors}'
    assert len(results) == 6
    assert len(set(results)) == len(results), f'并发导入产生了重复 id: {results}'
    for pet_id in results:
        assert os.path.isfile(os.path.join(store.user_pet_dir(pet_id), MANIFEST_FILENAME))


# ------------------------------------------------------------------ 单动作覆盖


def test_save_action_image_creates_override(store, builtin_pet):
    payload = store.save_action_image(
        builtin_pet, 'idle', make_image_bytes(size=(80, 80), color=(0, 128, 0, 255)),
    )
    assert payload['action'] == 'idle'
    assert payload['url']
    override_dir = os.path.join(store.user_pet_dir(builtin_pet), OVERRIDES_DIRNAME)
    assert os.path.isfile(os.path.join(override_dir, 'idle.png'))


def test_save_action_image_does_not_touch_pack_file(store, builtin_pet):
    """覆盖**不改动**包内原图——内置资源永远只读。"""
    original = os.path.join(store.builtin_pet_dir(builtin_pet), 'idle.png')
    with open(original, 'rb') as handle:
        before = handle.read()
    store.save_action_image(builtin_pet, 'idle', make_image_bytes(size=(80, 80), color=(7, 7, 7, 255)))
    with open(original, 'rb') as handle:
        assert handle.read() == before


def test_save_action_image_resizes_to_pack_frame_size(store, builtin_pet):
    payload = store.save_action_image(
        builtin_pet, 'idle', make_image_bytes(size=(500, 200), color=(0, 0, 0, 255)),
    )
    assert payload['size'] == [64, 64]


def test_save_action_image_replaces_previous_override(store, builtin_pet):
    store.save_action_image(builtin_pet, 'idle', make_image_bytes(size=(64, 64)))
    store.save_action_image(builtin_pet, 'idle', make_image_bytes(size=(64, 64)), output_format='webp')
    override_dir = os.path.join(store.user_pet_dir(builtin_pet), OVERRIDES_DIRNAME)
    files = sorted(os.listdir(override_dir))
    assert files == ['idle.webp'], f'同一动作应只有一张覆盖图，实际: {files}'


def test_save_action_image_rejects_bad_action(store, builtin_pet):
    for action in ['../evil', '', 'a/b']:
        with pytest.raises(PetError):
            store.save_action_image(builtin_pet, action, make_image_bytes())


def test_save_action_image_rejects_unknown_pet(store):
    with pytest.raises(PetError) as info:
        store.save_action_image('ghost', 'idle', make_image_bytes())
    assert info.value.code == CODE_PACK_NOT_FOUND


def test_save_action_image_rejects_non_image(store, builtin_pet):
    with pytest.raises(PetError):
        store.save_action_image(builtin_pet, 'idle', b'%PDF-1.4 fake')


def test_delete_action_override_reverts_to_pack(store, builtin_pet):
    store.save_action_image(builtin_pet, 'idle', make_image_bytes(size=(64, 64), color=(0, 0, 255, 255)))
    assert store.resolve_frame_path(builtin_pet, 'idle')[1] == 'override'

    assert store.delete_action_override(builtin_pet, 'idle') is True
    assert store.resolve_frame_path(builtin_pet, 'idle')[1] == 'builtin'


def test_delete_missing_override_is_noop(store, builtin_pet):
    assert store.delete_action_override(builtin_pet, 'idle') is False


def test_delete_last_override_prunes_empty_dir(store, builtin_pet):
    """删掉最后一个覆盖后，空的 overrides 目录也要清掉。

    留着它会让人以为「这里还有用户数据」，也是 `_scan_dir` 误判的诱因。
    """
    store.save_action_image(builtin_pet, 'idle', make_image_bytes(size=(64, 64)))
    override_dir = os.path.join(store.user_pet_dir(builtin_pet), OVERRIDES_DIRNAME)
    assert os.path.isdir(override_dir)

    store.delete_action_override(builtin_pet, 'idle')
    assert not os.path.isdir(override_dir), '空覆盖目录应被清理'


def test_delete_one_of_two_overrides_keeps_dir(store, builtin_pet):
    """还有别的覆盖时不能删目录。"""
    store.save_action_image(builtin_pet, 'idle', make_image_bytes(size=(64, 64)))
    store.save_action_image(builtin_pet, 'walk', make_image_bytes(size=(64, 64)))
    store.delete_action_override(builtin_pet, 'idle')
    override_dir = os.path.join(store.user_pet_dir(builtin_pet), OVERRIDES_DIRNAME)
    assert os.path.isdir(override_dir)
    assert os.listdir(override_dir) == ['walk.png']


def test_overrides_listed_in_describe(store, builtin_pet):
    store.save_action_image(builtin_pet, 'walk', make_image_bytes(size=(64, 64)))
    item = next(i for i in store.list_pets() if i['id'] == builtin_pet)
    assert 'walk' in item['overrides']


def test_builtin_pet_with_overrides_stays_builtin(store, builtin_pet):
    """★ 对内置形象做过覆盖后，它必须**仍然**是内置形象。

    实测踩过（真实浏览器里看到面板显示「自定义」+「删除」按钮）：
    单动作覆盖会在 `data/pets/<内置 id>/overrides/` 下落文件，
    于是 `data/pets/<内置 id>/` 这个目录存在了。
    如果「是不是用户包」按目录存在判断，内置形象就会被当成用户包——
    后果不止是显示错：
    ① 面板给出「删除」按钮，用户点了会把一个不存在的用户包删掉（困惑）；
    ② 更糟的是 `_locate` 用户优先，它会**遮蔽**同名内置包，
       而那个目录里没有 pet.json，等于把一个能用的内置形象变成「不存在」。
    """
    store.save_action_image(builtin_pet, 'idle', make_image_bytes(size=(64, 64)))

    items = store.list_pets()
    matching = [item for item in items if item['id'] == builtin_pet]
    assert len(matching) == 1, '内置形象不应因为覆盖而出现两条'
    assert matching[0]['source'] == 'builtin', (
        f'做过覆盖的内置形象仍应是 builtin，实际 {matching[0]["source"]}'
    )
    assert 'idle' in matching[0]['overrides']

    # 仍然可正常读取（没有被空目录遮蔽）
    assert store.load_pack(builtin_pet).name == '内置猫'
    # 内置形象不可删除
    assert store.delete_pet(builtin_pet) is False
    assert os.path.isdir(store.builtin_pet_dir(builtin_pet))


def test_override_only_directory_is_not_listed_as_pet(store):
    """只有 `overrides/`、没有 pet.json 的目录不该出现在形象列表里。"""
    orphan = os.path.join(store.user_pets_dir(), 'ghost-override-only', OVERRIDES_DIRNAME)
    os.makedirs(orphan, exist_ok=True)
    assert store.list_pets() == []


def test_orphan_directory_does_not_shadow_builtin(store, builtin_pet):
    """★ 空目录不能遮蔽同名内置形象（这是上一条的真实危害）。"""
    # 手工造出「只有覆盖目录、没有 pet.json」的用户目录
    os.makedirs(os.path.join(store.user_pets_dir(), builtin_pet, OVERRIDES_DIRNAME),
                exist_ok=True)
    # 内置形象必须仍然可用
    assert store.active_pet_id() == builtin_pet
    assert store.load_pack(builtin_pet).name == '内置猫'
    assert store.resolve_frame_path(builtin_pet, 'idle')[1] == 'builtin'


# ------------------------------------------------------------------ 删除形象


def test_delete_user_pet(store):
    store.import_zip(sample_zip('to-delete'))
    assert store.delete_pet('to-delete') is True
    assert not os.path.isdir(store.user_pet_dir('to-delete'))
    assert [i['id'] for i in store.list_pets()] == []


def test_delete_builtin_pet_is_refused(store, builtin_pet):
    assert store.delete_pet(builtin_pet) is False
    assert os.path.isdir(store.builtin_pet_dir(builtin_pet))


def test_delete_clears_active_setting(store):
    store.import_zip(sample_zip('active-one'))
    store.update_settings({'activePetId': 'active-one'})
    store.delete_pet('active-one')
    assert store.get_settings()['activePetId'] == ''


def test_delete_missing_returns_false(store):
    assert store.delete_pet('ghost') is False


# ------------------------------------------------------------------ 导出


def test_export_import_round_trip(store):
    """导出再导入应等价——用户在设备间搬运形象的路径。"""
    store.import_zip(sample_zip('porter'))
    store.save_action_image('porter', 'idle', make_image_bytes(size=(64, 64), color=(5, 5, 5, 255)))

    exported = store.export_pet('porter')
    store.delete_pet('porter')
    assert store.list_pets() == []

    restored = store.import_zip(exported)
    assert restored['id'] == 'porter'
    # 覆盖图也要跟着回来
    assert 'idle' in restored['overrides']
    assert store.resolve_frame_path('porter', 'idle')[1] == 'override'


def test_export_unknown_pet_raises(store):
    with pytest.raises(PetError):
        store.export_pet('ghost')


# ------------------------------------------------------------------ 数据保留


def test_user_data_survives_new_store_instance(tmp_path):
    """★ 重启宿主后形象仍在（阶段 5 验收）：只是重建 store，不改目录。"""
    data_dir = tmp_path / 'data'
    builtin = tmp_path / 'resources' / 'pets'
    data_dir.mkdir(parents=True)
    builtin.mkdir(parents=True)

    first = PetStore(str(data_dir), str(builtin))
    first.import_zip(sample_zip('persisted'))
    first.save_action_image('persisted', 'idle', make_image_bytes(size=(64, 64), color=(3, 3, 3, 255)))
    first.update_settings({'activePetId': 'persisted'})

    second = PetStore(str(data_dir), str(builtin))
    assert second.active_pet_id() == 'persisted'
    assert second.get_settings()['activePetId'] == 'persisted'
    assert second.resolve_frame_path('persisted', 'idle')[1] == 'override'


def test_plugin_update_keeps_user_data(tmp_path):
    """★ 插件「更新」（重装同一目录）后形象仍在。

    模拟宿主更新契约（§2.4）：新包带来同名文件时**用户那份保留**，
    新包那份被改名为 `<name>.plugin-default`。这里验证插件自己的数据
    全部落在 data/ 下，因此不会被更新流程动到。
    """
    data_dir = tmp_path / 'data'
    builtin = tmp_path / 'resources' / 'pets'
    data_dir.mkdir(parents=True)
    builtin.mkdir(parents=True)

    store = PetStore(str(data_dir), str(builtin))
    store.import_zip(sample_zip('mine'))
    store.save_action_image('mine', 'idle', make_image_bytes(size=(64, 64), color=(8, 8, 8, 255)))
    store.update_settings({'activePetId': 'mine'})

    # 模拟一次插件「更新」：随包资源被整个换成新版本
    builtin_v2 = tmp_path / 'resources-v2' / 'pets'
    shutil_copytree = __import__('shutil').copytree
    shutil_copytree(str(builtin), str(builtin_v2))
    write_pack(builtin_v2, 'new-builtin', payload=minimal_pack(id='new-builtin'))

    updated = PetStore(str(data_dir), str(builtin_v2))
    assert updated.active_pet_id() == 'mine', '更新后当前形象应保持'
    assert updated.get_settings()['activePetId'] == 'mine'
    assert updated.resolve_frame_path('mine', 'idle')[1] == 'override'
    assert 'new-builtin' in [i['id'] for i in updated.list_pets()]
